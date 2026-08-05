import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Exercises the on-device pipeline against synthetic "scans" so the analyser thresholds,
// the flat-field correction, the bilevel packing and the PDF writer can all be verified
// on a Mac before any of it runs on a phone.

let outputDir = URL(fileURLWithPath: "/tmp/snap-test")
try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

// MARK: - Synthetic page generation

let bodyLines = [
    "INVOICE 2026-0814",
    "Atlanta Industry Supply Co.",
    "1450 Riverbend Road SE, Calgary AB",
    "",
    "Description                 Qty      Amount",
    "Hydraulic coupling 3/4in      12      408.00",
    "Reinforced hose, 10m           4      236.50",
    "Shipping and handling          1       45.00",
    "",
    "Subtotal                             689.50",
    "GST 5 percent                         34.48",
    "Total due                            723.98",
    "",
    "Payment is due within thirty days of the invoice",
    "date. Late payments accrue interest at 1.5 percent",
    "per month. Please quote the invoice number on all",
    "remittances sent to accounts@example.com."
]

func makePage(
    width: Int,
    height: Int,
    shadow: Bool,
    colorAccent: Bool,
    grayPhoto: Bool,
    photoScale: Double = 1.0,
    warmCast: Bool = false,
    grayBox: Bool = false
) -> CGImage {
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(
        data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: 0, space: cs,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )!

    // Paper
    ctx.setFillColor(CGColor(red: 0.98, green: 0.975, blue: 0.96, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // A greyscale photograph block — the thing that should pull the decision to greyscale.
    if grayPhoto {
        let w = 0.76 * photoScale
        let h = 0.34 * photoScale
        let rect = CGRect(x: Double(width) * 0.12, y: Double(height) * 0.42,
                          width: Double(width) * w, height: Double(height) * h)
        let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceGray(),
            colors: [CGColor(gray: 0.15, alpha: 1), CGColor(gray: 0.85, alpha: 1),
                     CGColor(gray: 0.35, alpha: 1)] as CFArray,
            locations: [0, 0.55, 1]
        )!
        ctx.saveGState()
        ctx.clip(to: rect)
        ctx.drawLinearGradient(
            gradient,
            start: CGPoint(x: rect.minX, y: rect.minY),
            end: CGPoint(x: rect.maxX, y: rect.maxY),
            options: []
        )
        // Texture at several scales. A real photograph carries detail at many
        // frequencies; a bare linear ramp is indistinguishable from a lighting gradient
        // by construction, so testing only against one would be testing a pathological
        // case rather than a representative one.
        var seed: UInt64 = 0x5EED
        func rand() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double((seed >> 33) % 10_000) / 10_000.0
        }
        for _ in 0..<220 {
            let r = (0.01 + rand() * 0.09) * rect.width
            let cx = rect.minX + rand() * rect.width
            let cy = rect.minY + rand() * rect.height
            ctx.setFillColor(CGColor(gray: 0.12 + rand() * 0.76, alpha: 0.35 + rand() * 0.4))
            ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
        }
        ctx.restoreGState()
    }

    // A flat mid-grey block: a filled table header or shaded box. Not photographic, but
    // thresholding still destroys it, so it belongs on the greyscale side.
    if grayBox {
        ctx.setFillColor(CGColor(gray: 0.55, alpha: 1))
        ctx.fill(CGRect(x: Double(width) * 0.12, y: Double(height) * 0.45,
                        width: Double(width) * 0.76, height: Double(height) * 0.22))
    }

    // A saturated logo block — should flip the decision to colour.
    if colorAccent {
        ctx.setFillColor(CGColor(red: 0.11, green: 0.42, blue: 0.82, alpha: 1))
        ctx.fill(CGRect(x: Double(width) * 0.08, y: Double(height) * 0.86,
                        width: Double(width) * 0.30, height: Double(height) * 0.055))
        ctx.setFillColor(CGColor(red: 0.90, green: 0.29, blue: 0.16, alpha: 1))
        ctx.fill(CGRect(x: Double(width) * 0.42, y: Double(height) * 0.86,
                        width: Double(width) * 0.14, height: Double(height) * 0.055))
    }

    // Body text
    let fontSize = Double(height) * 0.018
    let font = CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)
    var y = Double(height) * 0.80
    for line in bodyLines {
        defer { y -= fontSize * 1.7 }
        guard !line.isEmpty else { continue }
        // Raw CoreText keys — `.font`/`.foregroundColor` come from AppKit/UIKit, which
        // this target deliberately doesn't link.
        let attributed = NSAttributedString(string: line, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.08, alpha: 1)
        ])
        let ctLine = CTLineCreateWithAttributedString(attributed)
        ctx.textPosition = CGPoint(x: Double(width) * 0.10, y: y)
        CTLineDraw(ctLine, ctx)
    }

    // Uneven lighting: the shadow a hand or phone body casts across a real capture.
    if shadow {
        let gradient = CGGradient(
            colorsSpace: cs,
            colors: [CGColor(red: 0.42, green: 0.42, blue: 0.45, alpha: 1),
                     CGColor(red: 1, green: 1, blue: 1, alpha: 1)] as CFArray,
            locations: [0, 1]
        )!
        ctx.setBlendMode(.multiply)
        ctx.drawLinearGradient(
            gradient,
            start: CGPoint(x: 0, y: Double(height)),
            end: CGPoint(x: Double(width) * 0.85, y: 0),
            options: []
        )
        ctx.setBlendMode(.normal)
    }

    // Tungsten-style illuminant. Nothing on the page is actually coloured, so this must
    // still come out as B&W — it's the case that raw-chroma detection gets wrong.
    if warmCast {
        ctx.setBlendMode(.multiply)
        ctx.setFillColor(CGColor(red: 1.0, green: 0.88, blue: 0.72, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setBlendMode(.normal)
    }

    return ctx.makeImage()!
}

// MARK: - Helpers

func savePNG(_ image: CGImage, _ name: String) {
    let url = outputDir.appendingPathComponent(name)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

/// Mean luminance of a small patch, used to prove flat-fielding actually flattens.
func patchLuminance(_ image: CGImage, at unit: CGPoint) -> Double {
    let size = 24
    let px = Int(unit.x * Double(image.width)) - size / 2
    let py = Int(unit.y * Double(image.height)) - size / 2
    let rect = CGRect(x: max(0, px), y: max(0, py), width: size, height: size)
    guard let crop = image.cropping(to: rect) else { return .nan }

    var buffer = [UInt8](repeating: 0, count: size * size * 4)
    guard let ctx = CGContext(
        data: &buffer, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return .nan }
    ctx.draw(crop, in: CGRect(x: 0, y: 0, width: size, height: size))

    var sum = 0.0
    for i in stride(from: 0, to: buffer.count, by: 4) {
        sum += (0.2126 * Double(buffer[i]) + 0.7152 * Double(buffer[i + 1]) + 0.0722 * Double(buffer[i + 2])) / 255.0
    }
    return sum / Double(size * size)
}

func kb(_ bytes: Int) -> String { String(format: "%.1f KB", Double(bytes) / 1024.0) }

// MARK: - Run

struct Fixture {
    let name: String
    let image: CGImage
    let expected: ColorMode
}

let fixtures: [Fixture] = [
    Fixture(name: "text-only",
            image: makePage(width: 2550, height: 3300, shadow: true, colorAccent: false, grayPhoto: false),
            expected: .blackAndWhite),
    Fixture(name: "text-no-shadow",
            image: makePage(width: 2550, height: 3300, shadow: false, colorAccent: false, grayPhoto: false),
            expected: .blackAndWhite),
    // Tungsten light with nothing actually coloured on the page.
    Fixture(name: "warm-cast",
            image: makePage(width: 2550, height: 3300, shadow: true, colorAccent: false,
                            grayPhoto: false, warmCast: true),
            expected: .blackAndWhite),
    Fixture(name: "with-gray-photo",
            image: makePage(width: 2550, height: 3300, shadow: true, colorAccent: false, grayPhoto: true),
            expected: .grayscale),
    // A photo covering only ~6% of the page: the page average stays low, so this only
    // passes if a single saturated tile can carry the decision.
    Fixture(name: "small-gray-photo",
            image: makePage(width: 2550, height: 3300, shadow: true, colorAccent: false,
                            grayPhoto: true, photoScale: 0.4),
            expected: .grayscale),
    // Flat shaded block rather than a photo — thresholding wipes it out just the same.
    Fixture(name: "gray-box",
            image: makePage(width: 2550, height: 3300, shadow: true, colorAccent: false,
                            grayPhoto: false, grayBox: true),
            expected: .grayscale),
    Fixture(name: "with-color-logo",
            image: makePage(width: 2550, height: 3300, shadow: true, colorAccent: true, grayPhoto: false),
            expected: .color)
]

print("=== 1. Colour-mode detection ===")
var detectionFailures = 0
for fixture in fixtures {
    let (mode, stats) = PageAnalyzer.analyze(fixture.image)
    let ok = mode == fixture.expected
    if !ok { detectionFailures += 1 }
    print(String(
        format: "%@ %-18s -> %-14s (want %-14s) colour %.3f vivid %.3f midtone %.3f maxTile %.3f",
        ok ? "PASS" : "FAIL",
        (fixture.name as NSString).utf8String!,
        (mode.label as NSString).utf8String!,
        (fixture.expected.label as NSString).utf8String!,
        stats.coloredFraction, stats.vividFraction, stats.midtoneFraction, stats.maxTileMidtone
    ))
    let hot = stats.tileMidtones.filter { $0 > 0.30 }.count
    print(String(format: "     %d/%d cells above the 0.30 tile threshold, paper white %.2f",
                 hot, stats.tileMidtones.count,
                 0.2126 * stats.paperWhite.r + 0.7152 * stats.paperWhite.g + 0.0722 * stats.paperWhite.b))
    savePNG(fixture.image, "source-\(fixture.name).png")
}

print("\n=== 2. Flat-field correction (shadowed text page) ===")
let shadowed = fixtures[0].image
let corners = [CGPoint(x: 0.06, y: 0.94), CGPoint(x: 0.94, y: 0.06)]
let before = corners.map { patchLuminance(shadowed, at: $0) }
print(String(format: "raw capture   dark corner %.3f   bright corner %.3f   spread %.3f",
             before[0], before[1], abs(before[0] - before[1])))

let flattened = try ImageProcessor.process(shadowed, mode: .grayscale, quality: .balanced)
let after = corners.map { patchLuminance(flattened.preview, at: $0) }
print(String(format: "after flat-fielding  %.3f            %.3f            spread %.3f",
             after[0], after[1], abs(after[0] - after[1])))
let flatteningWorks = abs(after[0] - after[1]) < abs(before[0] - before[1]) * 0.4
print(flatteningWorks ? "PASS shadow largely removed" : "FAIL shadow survived")

print("\n=== 3. Encoding size by mode (2550x3300 text page) ===")
var renders: [ColorMode: ImageProcessor.Output] = [:]
for mode in ColorMode.allCases {
    let out = try ImageProcessor.process(shadowed, mode: mode, quality: .balanced)
    renders[mode] = out
    savePNG(out.preview, "processed-\(mode.rawValue).png")
    print(String(format: "%-14s %5d x %-5d  %-14s %s",
                 (mode.label as NSString).utf8String!,
                 out.width, out.height,
                 ("\(out.encoding)" as NSString).utf8String!,
                 (kb(out.data.count) as NSString).utf8String!))
}

print("\n=== 4. OCR ===")
let ocrStart = Date()
let lines = try OCRService.recognize(shadowed, languages: ["en-US"])
let ocrElapsed = Date().timeIntervalSince(ocrStart)
print(String(format: "recognised %d lines in %.2fs on this Mac", lines.count, ocrElapsed))
let recognised = OCRService.plainText(from: lines)
print("--- text ---")
print(recognised)
print("--- suggested filename: \(OCRService.suggestedTitle(from: lines) ?? "(none)") ---")

let expectedTokens = ["INVOICE", "Calgary", "723.98", "Subtotal"]
let missing = expectedTokens.filter { !recognised.localizedCaseInsensitiveContains($0) }
print(missing.isEmpty ? "PASS all probe tokens recognised" : "FAIL missing: \(missing.joined(separator: ", "))")

print("\n=== 5. PDF assembly ===")
for mode in ColorMode.allCases {
    guard let render = renders[mode] else { continue }
    let page = ProcessedPage(
        imageData: render.data, encoding: render.encoding,
        pixelWidth: render.width, pixelHeight: render.height,
        mode: mode, detectedMode: mode, lines: lines, preview: render.preview
    )
    let pdf = DocumentPipeline.buildPDF(from: [page], title: "Snap test — \(mode.label)")
    let url = outputDir.appendingPathComponent("test-\(mode.rawValue).pdf")
    try pdf.write(to: url)
    let paper = PaperSize.pageSize(pixelWidth: render.width, pixelHeight: render.height)
    print(String(format: "%-14s %-10s page %.0f x %.0f pt",
                 (mode.label as NSString).utf8String!,
                 (kb(pdf.count) as NSString).utf8String!,
                 paper.width, paper.height))
}

// Multi-page, mixed modes — the realistic case.
let multi = try ColorMode.allCases.map { mode -> ProcessedPage in
    let r = try ImageProcessor.process(shadowed, mode: mode, quality: .balanced)
    return ProcessedPage(imageData: r.data, encoding: r.encoding,
                         pixelWidth: r.width, pixelHeight: r.height,
                         mode: mode, detectedMode: mode, lines: lines, preview: r.preview)
}
let multiPDF = DocumentPipeline.buildPDF(from: multi, title: "Snap multi-page test")
try multiPDF.write(to: outputDir.appendingPathComponent("test-multipage.pdf"))
print("3-page mixed  \(kb(multiPDF.count))")

print("\n=== 6. Unicode text layer ===")
let cjkLines = [
    RecognizedLine(text: "发票编号 2026-0814", boundingBox: CGRect(x: 0.1, y: 0.80, width: 0.5, height: 0.02), confidence: 0.9),
    RecognizedLine(text: "卡尔加里市 阿尔伯塔省", boundingBox: CGRect(x: 0.1, y: 0.76, width: 0.6, height: 0.02), confidence: 0.9),
    RecognizedLine(text: "Grüße — naïve café", boundingBox: CGRect(x: 0.1, y: 0.72, width: 0.4, height: 0.02), confidence: 0.9)
]
if let bw = renders[.blackAndWhite] {
    let page = ProcessedPage(imageData: bw.data, encoding: bw.encoding,
                             pixelWidth: bw.width, pixelHeight: bw.height,
                             mode: .blackAndWhite, detectedMode: .blackAndWhite,
                             lines: cjkLines, preview: bw.preview)
    let pdf = DocumentPipeline.buildPDF(from: [page], title: "中文测试")
    try pdf.write(to: outputDir.appendingPathComponent("test-unicode.pdf"))
    print("wrote test-unicode.pdf (\(kb(pdf.count)))")
}

print("\nArtifacts in \(outputDir.path)")
if detectionFailures > 0 { print("\n\(detectionFailures) detection failure(s)") }
