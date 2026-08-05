import CoreGraphics
import Foundation

/// How a page's pixels get rendered into the final PDF.
enum ColorMode: String, CaseIterable, Codable, Identifiable {
    case color
    case grayscale
    case blackAndWhite

    var id: String { rawValue }

    var label: String {
        switch self {
        case .color: return "Colour"
        case .grayscale: return "Greyscale"
        case .blackAndWhite: return "Black & White"
        }
    }

    var shortLabel: String {
        switch self {
        case .color: return "Colour"
        case .grayscale: return "Grey"
        case .blackAndWhite: return "B&W"
        }
    }

    var symbolName: String {
        switch self {
        case .color: return "camera.filters"
        case .grayscale: return "circle.lefthalf.filled"
        case .blackAndWhite: return "circle.righthalf.filled"
        }
    }
}

/// What the user picked in the review screen. `.auto` defers to `PageAnalyzer`.
enum ColorModeSelection: Hashable {
    case auto
    case forced(ColorMode)

    func resolve(auto detected: ColorMode) -> ColorMode {
        switch self {
        case .auto: return detected
        case .forced(let m): return m
        }
    }
}

/// Output size/quality tier. Drives both the pixel cap and the JPEG quality.
enum QualityTier: String, CaseIterable, Codable, Identifiable {
    case small
    case balanced
    case high

    var id: String { rawValue }

    var label: String {
        switch self {
        case .small: return "Small"
        case .balanced: return "Balanced"
        case .high: return "High"
        }
    }

    var detail: String {
        switch self {
        case .small: return "Smallest files. Fine for text you just need to keep."
        case .balanced: return "Good detail at a modest size. Recommended."
        case .high: return "Maximum detail. Use for fine print or artwork."
        }
    }

    /// Longest-edge pixel cap. Images are only ever scaled down, never up.
    ///
    /// Bilevel gets a much higher cap on purpose: 1-bit output compresses ~20x, so the
    /// extra resolution is nearly free and it's what keeps small type crisp.
    func maxLongEdge(for mode: ColorMode) -> Int {
        switch (self, mode) {
        case (.small, .color): return 1500
        case (.small, .grayscale): return 1700
        case (.small, .blackAndWhite): return 2200

        case (.balanced, .color): return 2000
        case (.balanced, .grayscale): return 2200
        case (.balanced, .blackAndWhite): return 3000

        case (.high, .color): return 2800
        case (.high, .grayscale): return 3000
        case (.high, .blackAndWhite): return 3500
        }
    }

    var jpegQuality: CGFloat {
        switch self {
        case .small: return 0.45
        case .balanced: return 0.60
        case .high: return 0.75
        }
    }
}

/// A single line of recognised text plus where Vision found it.
///
/// `boundingBox` is normalised to the page with a **bottom-left origin**, which is
/// both Vision's convention and PDF's — no flip is needed anywhere downstream.
struct RecognizedLine {
    let text: String
    let boundingBox: CGRect
    let confidence: Float
}

/// Everything the pipeline produced for one page.
struct ProcessedPage {
    let imageData: Data
    let encoding: PDFImageEncoding
    let pixelWidth: Int
    let pixelHeight: Int
    let mode: ColorMode
    let detectedMode: ColorMode
    let lines: [RecognizedLine]
    /// 8-bit renderable version of the same pixels, for the review UI.
    let preview: CGImage

    var byteCount: Int { imageData.count }
}
