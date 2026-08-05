import CoreGraphics
import Foundation

/// Picks a physical page size for a scan so the PDF prints at the right scale.
///
/// A capture only tells us pixels and aspect ratio, never inches. Matching the aspect
/// against the common paper sizes recovers the intent for the overwhelmingly common case;
/// anything unusual (a receipt, a torn note) falls back to an 11-inch long edge, which
/// keeps text at a believable size rather than producing a 20-inch page.
enum PaperSize {

    private struct Candidate {
        let name: String
        let size: CGSize    // portrait, in points
    }

    private static let candidates: [Candidate] = [
        // Letter first so it wins ties on this side of the Atlantic.
        Candidate(name: "Letter", size: CGSize(width: 612, height: 792)),
        Candidate(name: "A4", size: CGSize(width: 595.28, height: 841.89)),
        Candidate(name: "Legal", size: CGSize(width: 612, height: 1008)),
        Candidate(name: "A5", size: CGSize(width: 419.53, height: 595.28)),
        Candidate(name: "A3", size: CGSize(width: 841.89, height: 1190.55))
    ]

    private static let tolerance = 0.04
    private static let fallbackLongEdge: CGFloat = 792   // 11 inches

    static func pageSize(pixelWidth: Int, pixelHeight: Int) -> CGSize {
        guard pixelWidth > 0, pixelHeight > 0 else {
            return CGSize(width: 612, height: 792)
        }

        let landscape = pixelWidth > pixelHeight
        let shortPx = CGFloat(min(pixelWidth, pixelHeight))
        let longPx = CGFloat(max(pixelWidth, pixelHeight))
        let aspect = shortPx / longPx

        for candidate in candidates {
            let candidateAspect = candidate.size.width / candidate.size.height
            if abs(candidateAspect - aspect) / candidateAspect <= tolerance {
                return landscape
                    ? CGSize(width: candidate.size.height, height: candidate.size.width)
                    : candidate.size
            }
        }

        let shortEdge = fallbackLongEdge * aspect
        return landscape
            ? CGSize(width: fallbackLongEdge, height: shortEdge)
            : CGSize(width: shortEdge, height: fallbackLongEdge)
    }
}
