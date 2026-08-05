import CoreGraphics
import Foundation
import SwiftUI
import UIKit

/// One captured page and whatever the pipeline has made of it so far.
struct PageDraft: Identifiable {
    let id = UUID()
    let source: CGImage
    var selection: ColorModeSelection = .auto
    var processed: ProcessedPage?
    var preview: UIImage?

    var detectedMode: ColorMode? { processed?.detectedMode }
    var resolvedMode: ColorMode? { processed?.mode }
    var byteCount: Int { processed?.byteCount ?? 0 }
}

/// Drives a single scan from capture through review to upload.
@MainActor
final class ScanCoordinator: ObservableObject {

    enum Stage: Equatable {
        case idle
        case processing(done: Int, total: Int)
        case review
        case uploading(Double)
        case finished(UploadRecord)
        case failed(String)
    }

    @Published private(set) var stage: Stage = .idle {
        didSet { Log.scan.info("stage -> \(self.stage.name, privacy: .public)") }
    }
    @Published private(set) var pages: [PageDraft] = []
    @Published var filename: String = ""
    @Published var folder: FolderRef = .root
    @Published var quality: QualityTier = .balanced

    private var ocrEnabled = true
    private var languages: [String] = ["en-US"]

    var totalBytes: Int { pages.reduce(0) { $0 + $1.byteCount } }
    var hasPages: Bool { !pages.isEmpty }

    // MARK: - Capture

    /// Enter the processing state synchronously, before any async work starts.
    ///
    /// The review screen is presented off the back of this, so it has to be true by the
    /// time the first frame renders — otherwise the sheet appears empty and flashes
    /// "No pages" before processing visibly begins.
    func prepare(pageCount: Int) {
        stage = .processing(done: 0, total: pageCount)
    }

    func begin(with images: [UIImage], settings: AppSettings) async {
        guard !images.isEmpty else {
            stage = .idle
            return
        }

        quality = settings.quality
        folder = settings.defaultFolder
        ocrEnabled = settings.ocrEnabled
        languages = settings.languages

        let selection = settings.colorSelection
        pages = images.compactMap { image in
            image.normalizedCGImage().map { PageDraft(source: $0, selection: selection) }
        }
        stage = .processing(done: 0, total: pages.count)

        for index in pages.indices {
            await renderPage(at: index)
            if case .processing = stage {
                stage = .processing(done: index + 1, total: pages.count)
            }
        }

        filename = defaultFilename(settings: settings)
        stage = .review
    }

    /// Re-render one page after a colour-mode or quality change.
    ///
    /// Cheap on purpose: OCR results are carried over, so only the image pipeline reruns.
    func updateSelection(_ selection: ColorModeSelection, forPageAt index: Int) async {
        guard pages.indices.contains(index) else { return }
        pages[index].selection = selection
        await renderPage(at: index)
    }

    func updateQuality(_ tier: QualityTier) async {
        quality = tier
        for index in pages.indices {
            await renderPage(at: index)
        }
    }

    func removePage(at index: Int) {
        guard pages.indices.contains(index) else { return }
        pages.remove(at: index)
    }

    private func renderPage(at index: Int) async {
        guard pages.indices.contains(index) else { return }

        let draft = pages[index]
        let input = DocumentPipeline.PageInput(
            image: draft.source,
            selection: draft.selection,
            cachedLines: draft.processed?.lines
        )
        let tier = quality
        let ocr = ocrEnabled
        let langs = languages

        // Off the main actor: OCR alone is around a second a page and would otherwise
        // freeze the review screen.
        let result = await Task.detached(priority: .userInitiated) { () -> ProcessedPage? in
            try? DocumentPipeline.process(input, quality: tier, ocrEnabled: ocr, languages: langs)
        }.value

        guard let result, pages.indices.contains(index) else {
            Log.scan.error("page \(index, privacy: .public) failed to render")
            return
        }
        Log.scan.info("page \(index, privacy: .public): auto=\(result.detectedMode.rawValue, privacy: .public) used=\(result.mode.rawValue, privacy: .public) \(result.pixelWidth, privacy: .public)x\(result.pixelHeight, privacy: .public) \(result.byteCount, privacy: .public)B lines=\(result.lines.count, privacy: .public)")
        pages[index].processed = result
        pages[index].preview = UIImage(cgImage: result.preview)
    }

    // MARK: - Naming

    private func defaultFilename(settings: AppSettings) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH.mm"
        let stamp = formatter.string(from: Date())

        if settings.useOCRTitle,
           let lines = pages.first?.processed?.lines,
           let title = OCRService.suggestedTitle(from: lines) {
            return "\(title) \(stamp)"
        }
        return "Scan \(stamp)"
    }

    var sanitizedFilename: String {
        let base = filename.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = base.isEmpty ? "Scan" : base
        let stripped = cleaned.replacingOccurrences(
            of: "[/\\\\:*?\"<>|]", with: "-", options: .regularExpression)
        return stripped.hasSuffix(".pdf") ? stripped : stripped + ".pdf"
    }

    // MARK: - Output

    func makePDF() -> Data? {
        let ready = pages.compactMap(\.processed)
        guard ready.count == pages.count, !ready.isEmpty else { return nil }
        return DocumentPipeline.buildPDF(from: ready, title: filename)
    }

    func upload(using client: OneDriveClient, settings: AppSettings) async {
        guard let pdf = makePDF() else {
            stage = .failed("The pages haven't finished processing yet.")
            return
        }

        stage = .uploading(0)
        do {
            let name = sanitizedFilename
            let item = try await client.upload(pdf, as: name, to: folder) { [weak self] fraction in
                // Only meaningful while the upload is still in flight. A progress update
                // that lands after the transfer finished must never resurrect the
                // progress screen over `.finished` or `.failed`.
                guard let self, case .uploading = self.stage else { return }
                self.stage = .uploading(fraction)
            }
            let record = UploadRecord(
                filename: item.name,
                folderPath: folder.displayPath,
                date: Date(),
                byteCount: pdf.count,
                pageCount: pages.count,
                webURL: item.webURL
            )
            settings.record(record)
            stage = .finished(record)
        } catch {
            stage = .failed(error.localizedDescription)
        }
    }

    func reportFailure(_ message: String) {
        stage = .failed(message)
    }

    func reset() {
        pages = []
        filename = ""
        stage = .idle
    }

    func backToReview() {
        stage = .review
    }
}

extension UIImage {
    /// A `CGImage` with any EXIF-style rotation baked in.
    ///
    /// `UIImage.cgImage` ignores `imageOrientation`, so a capture that arrives rotated
    /// would be analysed and rendered sideways without this.
    func normalizedCGImage() -> CGImage? {
        if imageOrientation == .up { return cgImage }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: size)) }.cgImage
    }
}

extension ScanCoordinator.Stage {
    /// Short label for logs — the associated values are noisy and mostly redundant.
    var name: String {
        switch self {
        case .idle: return "idle"
        case .processing(let done, let total): return "processing(\(done)/\(total))"
        case .review: return "review"
        case .uploading(let f): return "uploading(\(Int(f * 100))%)"
        case .finished: return "finished"
        case .failed: return "failed"
        }
    }
}
