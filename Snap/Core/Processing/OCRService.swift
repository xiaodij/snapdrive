import CoreGraphics
import Foundation
import Vision

/// On-device text recognition.
///
/// Runs entirely on the Neural Engine — no network, no account, no per-page cost. On an
/// A15 (iPhone 13 Pro) an accurate-mode pass over a full page lands around a second.
enum OCRService {

    /// Recognition runs against the *original* capture rather than the processed page.
    ///
    /// That keeps OCR independent of the colour-mode choice, so flipping a page to B&W in
    /// the review screen re-renders the image without paying for another OCR pass — and it
    /// avoids feeding Vision a thresholded image that may have dropped faint text.
    static func recognize(
        _ image: CGImage,
        languages: [String],
        minimumConfidence: Float = 0.3
    ) throws -> [RecognizedLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if !languages.isEmpty {
            request.recognitionLanguages = languages
        }

        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        try handler.perform([request])

        guard let observations = request.results else { return [] }
        return observations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first,
                  candidate.confidence >= minimumConfidence,
                  !candidate.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            // Vision normalises to the unit square with a bottom-left origin, which is
            // also PDF's convention — the boxes pass straight through to the text layer.
            return RecognizedLine(
                text: candidate.string,
                boundingBox: observation.boundingBox,
                confidence: candidate.confidence
            )
        }
    }

    static var supportedLanguages: [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? ["en-US"]
    }

    /// Reading order for a page: top to bottom, then left to right.
    static func plainText(from lines: [RecognizedLine]) -> String {
        lines
            .sorted { a, b in
                // Treat lines within half a line-height of each other as the same row.
                if abs(a.boundingBox.midY - b.boundingBox.midY) > a.boundingBox.height * 0.5 {
                    return a.boundingBox.midY > b.boundingBox.midY
                }
                return a.boundingBox.minX < b.boundingBox.minX
            }
            .map(\.text)
            .joined(separator: "\n")
    }

    /// First plausible line of a page, used to suggest a filename.
    static func suggestedTitle(from lines: [RecognizedLine]) -> String? {
        let ordered = lines.sorted { $0.boundingBox.midY > $1.boundingBox.midY }
        for line in ordered {
            let cleaned = line.text
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "[/\\\\:*?\"<>|]", with: "-", options: .regularExpression)
            // Skip page furniture and stray marks; look for something title-shaped.
            guard cleaned.count >= 4, cleaned.count <= 60 else { continue }
            guard cleaned.rangeOfCharacter(from: .letters) != nil else { continue }
            guard line.confidence > 0.5 else { continue }
            return cleaned
        }
        return nil
    }
}
