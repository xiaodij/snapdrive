import CoreGraphics
import Foundation

/// Decides whether a scanned page wants colour, greyscale or bilevel treatment.
///
/// Two independent measurements, each taken at the resolution that makes it meaningful:
///
/// - **Colour** comes from a 256px thumbnail. Hue is a low-frequency property, so a
///   thumbnail sees it fine. Pixels are white-balanced against the page's own paper
///   colour first, otherwise every page shot under tungsten light reads as "colour".
///
/// - **Tone** comes from a grid of tiles cropped at *native* resolution. Downsampling a
///   text page turns crisp black-on-white into grey mush, so a histogram taken from a
///   thumbnail reports midtones everywhere there is text and never picks bilevel. Each
///   tile is normalised against its own paper white, which also cancels shadows.
enum PageAnalyzer {

    /// Fraction of the page that must carry real colour before we keep it in colour.
    private static let colorAreaThreshold = 0.05
    /// A much smaller patch of *vivid* colour is also enough — catches logos and stamps.
    private static let vividAreaThreshold = 0.015
    /// Saturation, measured after white balancing, above which a pixel counts as coloured.
    private static let saturationThreshold = 0.16
    private static let vividSaturationThreshold = 0.35

    /// Pooled midtone fraction above which we assume photos or shading and keep greys.
    private static let midtoneThreshold = 0.12
    /// A single heavily-midtone tile means a localised photo, even if the page average
    /// stays low. Without this a small photo on an otherwise textual page gets thresholded
    /// into a black blob. Text tiles sit around 0.03, so the margin here is wide.
    private static let tileMidtoneThreshold = 0.30

    struct Stats {
        let coloredFraction: Double
        let vividFraction: Double
        let midtoneFraction: Double
        let maxTileMidtone: Double
        let paperWhite: (r: Double, g: Double, b: Double)
        /// Per-tile midtone fractions, in row-major grid order. Diagnostic only.
        let tileMidtones: [Double]
    }

    static func analyze(_ image: CGImage) -> (mode: ColorMode, stats: Stats) {
        guard let color = colorStats(image), let tone = toneStats(image) else {
            // If the pixels can't be read, colour is the choice that destroys least.
            return (.color, Stats(coloredFraction: 1, vividFraction: 1, midtoneFraction: 1,
                                  maxTileMidtone: 1, paperWhite: (1, 1, 1), tileMidtones: []))
        }

        let stats = Stats(
            coloredFraction: color.colored,
            vividFraction: color.vivid,
            midtoneFraction: tone.pooled,
            maxTileMidtone: tone.maxTile,
            paperWhite: color.paperWhite,
            tileMidtones: tone.tiles
        )

        if stats.coloredFraction > colorAreaThreshold || stats.vividFraction > vividAreaThreshold {
            return (.color, stats)
        }
        if stats.midtoneFraction > midtoneThreshold || stats.maxTileMidtone > tileMidtoneThreshold {
            return (.grayscale, stats)
        }
        return (.blackAndWhite, stats)
    }

    // MARK: - Colour

    private static func colorStats(
        _ image: CGImage
    ) -> (colored: Double, vivid: Double, paperWhite: (r: Double, g: Double, b: Double))? {
        let maxEdge = 256
        let scale = min(1.0, Double(maxEdge) / Double(max(image.width, image.height)))
        let w = max(1, Int((Double(image.width) * scale).rounded()))
        let h = max(1, Int((Double(image.height) * scale).rounded()))

        var buffer = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(
            data: &buffer, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

        let count = w * h
        var luma = [Double](repeating: 0, count: count)
        for i in 0..<count {
            let o = i * 4
            luma[i] = (0.2126 * Double(buffer[o]) + 0.7152 * Double(buffer[o + 1]) + 0.0722 * Double(buffer[o + 2])) / 255.0
        }

        // Paper colour = mean of the brightest fifth of the page. Dividing by this is a
        // von Kries white balance, which strips the illuminant's cast so that only pixels
        // whose hue genuinely differs *from the paper* register as coloured.
        let cutoff = percentile(luma, 0.80)
        var sum = (r: 0.0, g: 0.0, b: 0.0)
        var bright = 0
        for i in 0..<count where luma[i] >= cutoff {
            let o = i * 4
            sum.r += Double(buffer[o]) / 255.0
            sum.g += Double(buffer[o + 1]) / 255.0
            sum.b += Double(buffer[o + 2]) / 255.0
            bright += 1
        }
        guard bright > 0 else { return nil }
        let paper = (
            r: max(0.05, sum.r / Double(bright)),
            g: max(0.05, sum.g / Double(bright)),
            b: max(0.05, sum.b / Double(bright))
        )

        var colored = 0
        var vivid = 0
        var counted = 0
        for i in 0..<count {
            let o = i * 4
            let r = min(1.0, Double(buffer[o]) / 255.0 / paper.r)
            let g = min(1.0, Double(buffer[o + 1]) / 255.0 / paper.g)
            let b = min(1.0, Double(buffer[o + 2]) / 255.0 / paper.b)

            let hi = max(r, g, b)
            let lo = min(r, g, b)
            // Near-black pixels carry no reliable hue; excluding them keeps dense text
            // and JPEG fringing out of the colour vote.
            guard hi > 0.18 else { counted += 1; continue }

            let saturation = (hi - lo) / hi
            if saturation > saturationThreshold { colored += 1 }
            if saturation > vividSaturationThreshold { vivid += 1 }
            counted += 1
        }

        guard counted > 0 else { return nil }
        return (Double(colored) / Double(counted), Double(vivid) / Double(counted), paper)
    }

    // MARK: - Tone

    /// Midtone measurement, normalised against a paper-only estimate of the lighting.
    ///
    /// The illumination field is built by *dilating* a thumbnail — taking a local maximum
    /// erases text, shaded boxes and photos, leaving only paper — then smoothing what
    /// remains. Dividing by that field cancels shadow and vignetting while leaving genuine
    /// content intact, which is the distinction a per-tile percentile cannot make: a flat
    /// grey box and shadowed paper are the same pixel value, and only the surrounding
    /// paper level says which is which.
    private static func toneStats(
        _ image: CGImage
    ) -> (pooled: Double, maxTile: Double, tiles: [Double])? {
        guard let field = illuminationField(image) else { return nil }

        // One render of the whole page rather than a grid of sampled crops. Sampling left
        // gaps a small photo could fall through, and 16 crops meant 16 draw calls anyway;
        // this is a single draw and gives exact coverage.
        let maxEdge = 2400
        let scale = min(1.0, Double(maxEdge) / Double(max(image.width, image.height)))
        let w = max(1, Int((Double(image.width) * scale).rounded()))
        let h = max(1, Int((Double(image.height) * scale).rounded()))

        var buffer = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(
            data: &buffer, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

        let grid = 10
        var cellMidtone = [Int](repeating: 0, count: grid * grid)
        var cellTotal = [Int](repeating: 0, count: grid * grid)

        // Precomputed row/column lookups keep the inner loop to array reads. The field is
        // smooth by construction, so nearest-neighbour sampling costs nothing in accuracy.
        let fieldRow = (0..<h).map { y in
            (Double(y) / Double(h) * Double(field.height)).rounded(.down).int.clamped(to: 0...(field.height - 1))
        }
        let fieldCol = (0..<w).map { x in
            (Double(x) / Double(w) * Double(field.width)).rounded(.down).int.clamped(to: 0...(field.width - 1))
        }
        let cellRow = (0..<h).map { min(grid - 1, $0 * grid / h) }
        let cellCol = (0..<w).map { min(grid - 1, $0 * grid / w) }

        buffer.withUnsafeBufferPointer { pixels in
            field.values.withUnsafeBufferPointer { fieldValues in
                for y in 0..<h {
                    let rowBase = y * w
                    let fieldBase = fieldRow[y] * field.width
                    let cellBase = cellRow[y] * grid
                    for x in 0..<w {
                        let reference = max(24.0, fieldValues[fieldBase + fieldCol[x]] * 255.0)
                        let normalized = min(1.0, Double(pixels[rowBase + x]) / reference)
                        let cell = cellBase + cellCol[x]
                        cellTotal[cell] += 1
                        if normalized > 0.25 && normalized < 0.80 { cellMidtone[cell] += 1 }
                    }
                }
            }
        }

        let midtoneTotal = cellMidtone.reduce(0, +)
        let pixelTotal = cellTotal.reduce(0, +)
        guard pixelTotal > 0 else { return nil }

        var tiles: [Double] = []
        var maxTile = 0.0
        for i in 0..<(grid * grid) where cellTotal[i] > 0 {
            let fraction = Double(cellMidtone[i]) / Double(cellTotal[i])
            tiles.append(fraction)
            maxTile = max(maxTile, fraction)
        }

        return (Double(midtoneTotal) / Double(pixelTotal), maxTile, tiles)
    }

    /// Paper-level lighting estimate, as a small grid of 0...1 values.
    private static func illuminationField(_ image: CGImage) -> (values: [Double], width: Int, height: Int)? {
        let maxEdge = 256
        let scale = min(1.0, Double(maxEdge) / Double(max(image.width, image.height)))
        let w = max(8, Int((Double(image.width) * scale).rounded()))
        let h = max(8, Int((Double(image.height) * scale).rounded()))

        var buffer = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(
            data: &buffer, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

        var values = buffer.map { Double($0) / 255.0 }

        // Radius has to exceed the largest non-paper feature we want bridged over, but stay
        // well under the scale on which lighting actually changes.
        let radius = max(4, max(w, h) / 8)
        values = separable(values, w: w, h: h, radius: radius, reduce: max)
        values = boxBlur(values, w: w, h: h, radius: radius / 2)
        return (values, w, h)
    }

    private static func separable(
        _ src: [Double], w: Int, h: Int, radius: Int,
        reduce: (Double, Double) -> Double
    ) -> [Double] {
        var pass = [Double](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                var acc = src[y * w + x]
                for i in max(0, x - radius)...min(w - 1, x + radius) {
                    acc = reduce(acc, src[y * w + i])
                }
                pass[y * w + x] = acc
            }
        }
        var out = [Double](repeating: 0, count: w * h)
        for x in 0..<w {
            for y in 0..<h {
                var acc = pass[y * w + x]
                for i in max(0, y - radius)...min(h - 1, y + radius) {
                    acc = reduce(acc, pass[i * w + x])
                }
                out[y * w + x] = acc
            }
        }
        return out
    }

    private static func boxBlur(_ src: [Double], w: Int, h: Int, radius: Int) -> [Double] {
        guard radius > 0 else { return src }
        var pass = [Double](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let lo = max(0, x - radius), hi = min(w - 1, x + radius)
                var sum = 0.0
                for i in lo...hi { sum += src[y * w + i] }
                pass[y * w + x] = sum / Double(hi - lo + 1)
            }
        }
        var out = [Double](repeating: 0, count: w * h)
        for x in 0..<w {
            for y in 0..<h {
                let lo = max(0, y - radius), hi = min(h - 1, y + radius)
                var sum = 0.0
                for i in lo...hi { sum += pass[i * w + x] }
                out[y * w + x] = sum / Double(hi - lo + 1)
            }
        }
        return out
    }

    // MARK: - Utilities

    private static func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let index = Int(Double(sorted.count - 1) * p)
        return sorted[index]
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

private extension Double {
    var int: Int { Int(self) }
}
