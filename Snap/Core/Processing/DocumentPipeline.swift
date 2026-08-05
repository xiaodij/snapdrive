import CoreGraphics
import Foundation

/// Composes analyse → OCR → render → PDF for one document.
enum DocumentPipeline {

    struct PageInput {
        let image: CGImage
        let selection: ColorModeSelection
        /// Supplied when OCR already ran for this page, so a colour-mode change in the
        /// review screen only re-renders the image.
        let cachedLines: [RecognizedLine]?

        init(image: CGImage, selection: ColorModeSelection = .auto, cachedLines: [RecognizedLine]? = nil) {
            self.image = image
            self.selection = selection
            self.cachedLines = cachedLines
        }
    }

    static func process(
        _ input: PageInput,
        quality: QualityTier,
        ocrEnabled: Bool,
        languages: [String]
    ) throws -> ProcessedPage {
        let detected = PageAnalyzer.analyze(input.image).mode
        let mode = input.selection.resolve(auto: detected)

        let lines: [RecognizedLine]
        if let cached = input.cachedLines {
            lines = cached
        } else if ocrEnabled {
            lines = (try? OCRService.recognize(input.image, languages: languages)) ?? []
        } else {
            lines = []
        }

        let rendered = try ImageProcessor.process(input.image, mode: mode, quality: quality)

        return ProcessedPage(
            imageData: rendered.data,
            encoding: rendered.encoding,
            pixelWidth: rendered.width,
            pixelHeight: rendered.height,
            mode: mode,
            detectedMode: detected,
            lines: lines,
            preview: rendered.preview
        )
    }

    static func buildPDF(from pages: [ProcessedPage], title: String?) -> Data {
        let pdfPages = pages.map { page in
            PDFPage(
                imageData: page.imageData,
                encoding: page.encoding,
                pixelWidth: page.pixelWidth,
                pixelHeight: page.pixelHeight,
                pageSize: PaperSize.pageSize(pixelWidth: page.pixelWidth, pixelHeight: page.pixelHeight),
                textLines: page.lines
            )
        }
        return PDFWriter.makePDF(pages: pdfPages, title: title)
    }

    static func plainText(from pages: [ProcessedPage]) -> String {
        pages
            .map { OCRService.plainText(from: $0.lines) }
            .enumerated()
            .map { index, text in pages.count > 1 ? "--- Page \(index + 1) ---\n\(text)" : text }
            .joined(separator: "\n\n")
    }
}
