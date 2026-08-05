import Accelerate
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageProcessingError: Error {
    case renderFailed
    case encodeFailed
}

/// Turns a raw deskewed capture into compressed, PDF-ready page bytes.
///
/// The heavy lifting for greyscale and bilevel is *flat-fielding*: divide the page by a
/// heavily blurred copy of itself. The blur approximates the lighting across the sheet,
/// so the division cancels shadows and vignetting and lands paper at a flat 1.0. That's
/// what makes a fixed threshold safe on the bilevel path — a global threshold applied to
/// an unnormalised photo would black out whichever corner your hand shaded.
enum ImageProcessor {

    static let ciContext: CIContext = {
        CIContext(options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any,
            .cacheIntermediates: false
        ])
    }()

    /// Ink threshold applied to the flat-fielded page. Paper sits at ~1.0 after
    /// normalisation, so this catches pencil and faded toner without chasing noise.
    private static let bilevelThreshold: CGFloat = 0.76

    struct Output {
        let data: Data
        let encoding: PDFImageEncoding
        let width: Int
        let height: Int
        let preview: CGImage
    }

    static func process(_ source: CGImage, mode: ColorMode, quality: QualityTier) throws -> Output {
        let scaled = downscale(CIImage(cgImage: source), maxLongEdge: quality.maxLongEdge(for: mode))

        switch mode {
        case .color:
            let image = enhanceColor(scaled)
            guard let cg = render(image, gray: false) else { throw ImageProcessingError.renderFailed }
            guard let data = encodeJPEG(cg, quality: quality.jpegQuality) else { throw ImageProcessingError.encodeFailed }
            return Output(data: data, encoding: .jpegRGB, width: cg.width, height: cg.height, preview: cg)

        case .grayscale:
            let image = enhanceGray(scaled)
            guard let cg = render(image, gray: true) else { throw ImageProcessingError.renderFailed }
            guard let data = encodeJPEG(cg, quality: quality.jpegQuality) else { throw ImageProcessingError.encodeFailed }
            return Output(data: data, encoding: .jpegGray, width: cg.width, height: cg.height, preview: cg)

        case .blackAndWhite:
            let image = binarize(scaled)
            guard let cg = render(image, gray: true) else { throw ImageProcessingError.renderFailed }
            guard let packed = packBilevel(cg) else { throw ImageProcessingError.encodeFailed }
            // Flate on 1-bit text typically lands 15-30x, which is why B&W pages end up
            // an order of magnitude smaller than the same page as JPEG.
            if let deflated = Deflate.zlib(packed) {
                return Output(data: deflated, encoding: .flateBilevel, width: cg.width, height: cg.height, preview: cg)
            }
            return Output(data: packed, encoding: .rawBilevel, width: cg.width, height: cg.height, preview: cg)
        }
    }

    // MARK: - Filter chains

    private static func downscale(_ image: CIImage, maxLongEdge: Int) -> CIImage {
        let longEdge = max(image.extent.width, image.extent.height)
        guard longEdge > CGFloat(maxLongEdge) else { return image }
        let scale = CGFloat(maxLongEdge) / longEdge

        let f = CIFilter.lanczosScaleTransform()
        f.inputImage = image
        f.scale = Float(scale)
        f.aspectRatio = 1
        return f.outputImage ?? image
    }

    private static func enhanceColor(_ image: CIImage) -> CIImage {
        // Deliberately gentle. VisionKit already applies its own colour correction, and
        // flat-fielding a colour page risks tinting large saturated areas like photos.
        let controls = CIFilter.colorControls()
        controls.inputImage = image
        controls.contrast = 1.08
        controls.saturation = 1.06
        controls.brightness = 0.02
        guard let boosted = controls.outputImage else { return image }

        let sharpen = CIFilter.unsharpMask()
        sharpen.inputImage = boosted
        sharpen.radius = 1.2
        sharpen.intensity = 0.4
        return (sharpen.outputImage ?? boosted).cropped(to: image.extent)
    }

    private static func enhanceGray(_ image: CIImage) -> CIImage {
        let flat = flatField(desaturate(image))

        let controls = CIFilter.colorControls()
        controls.inputImage = flat
        controls.contrast = 1.18
        controls.brightness = 0.0
        guard let boosted = controls.outputImage else { return flat }

        let sharpen = CIFilter.unsharpMask()
        sharpen.inputImage = boosted
        sharpen.radius = 1.0
        sharpen.intensity = 0.45
        return (sharpen.outputImage ?? boosted).cropped(to: image.extent)
    }

    private static func binarize(_ image: CIImage) -> CIImage {
        var gray = desaturate(image)

        // 3x3 median knocks out sensor speckle that would otherwise survive the threshold
        // as scattered black dots and wreck the Flate ratio.
        let median = CIFilter.median()
        median.inputImage = gray
        if let out = median.outputImage { gray = out.cropped(to: image.extent) }

        let flat = flatField(gray)

        let threshold = CIFilter.colorThreshold()
        threshold.inputImage = flat
        threshold.threshold = Float(bilevelThreshold)
        return (threshold.outputImage ?? flat).cropped(to: image.extent)
    }

    private static func desaturate(_ image: CIImage) -> CIImage {
        let f = CIFilter.colorControls()
        f.inputImage = image
        f.saturation = 0
        return f.outputImage ?? image
    }

    /// Divide the page by a heavily blurred copy of itself to cancel uneven lighting.
    private static func flatField(_ gray: CIImage) -> CIImage {
        let extent = gray.extent
        // Radius scales with the page so the blur always estimates *lighting* rather than
        // smearing away glyphs — roughly 1/40th of the long edge.
        let radius = max(8.0, min(extent.width, extent.height) / 40.0)

        let blur = CIFilter.gaussianBlur()
        // Clamping first stops the blur from pulling in transparent black at the margins,
        // which would otherwise darken every edge of the page.
        blur.inputImage = gray.clampedToExtent()
        blur.radius = Float(radius)
        guard let background = blur.outputImage?.cropped(to: extent) else { return gray }

        let divide = CIFilter.divideBlendMode()
        divide.inputImage = background      // source  (divisor)
        divide.backgroundImage = gray       // backdrop (dividend)
        guard let divided = divide.outputImage else { return gray }

        let clamp = CIFilter.colorClamp()
        clamp.inputImage = divided
        clamp.minComponents = CIVector(x: 0, y: 0, z: 0, w: 0)
        clamp.maxComponents = CIVector(x: 1, y: 1, z: 1, w: 1)
        return (clamp.outputImage ?? divided).cropped(to: extent)
    }

    // MARK: - Rendering & encoding

    private static func render(_ image: CIImage, gray: Bool) -> CGImage? {
        let space = gray ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)!
        let format: CIFormat = gray ? .L8 : .RGBA8
        return ciContext.createCGImage(image, from: image.extent, format: format, colorSpace: space)
    }

    private static func encodeJPEG(_ image: CGImage, quality: CGFloat) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    /// Pack an already-thresholded 8-bit image down to 1 bit per pixel, MSB first.
    ///
    /// PDF's DeviceGray reads 0 as black and 1 as white, which is exactly what
    /// `vImageConvert_Planar8toPlanar1` produces, so no `/Decode` array is needed.
    private static func packBilevel(_ image: CGImage) -> Data? {
        let w = image.width, h = image.height
        guard w > 0, h > 0 else { return nil }

        var src8 = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(
            data: &src8, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

        let dstRowBytes = (w + 7) / 8
        var dst1 = [UInt8](repeating: 0, count: dstRowBytes * h)

        var status = kvImageNoError
        src8.withUnsafeMutableBufferPointer { sp in
            dst1.withUnsafeMutableBufferPointer { dp in
                var s = vImage_Buffer(data: sp.baseAddress, height: vImagePixelCount(h),
                                      width: vImagePixelCount(w), rowBytes: w)
                var d = vImage_Buffer(data: dp.baseAddress, height: vImagePixelCount(h),
                                      width: vImagePixelCount(w), rowBytes: dstRowBytes)
                status = vImageConvert_Planar8toPlanar1(&s, &d, nil,
                                                        Int32(kvImageConvert_DitherNone),
                                                        vImage_Flags(kvImageNoFlags))
            }
        }
        guard status == kvImageNoError else { return nil }
        return Data(dst1)
    }
}
