// Port of SnapDrive/Core/PDF/PaperSize.swift.
//
// Picks a physical page size for a scan so the PDF prints at the right scale.
//
// A capture only tells us pixels and aspect ratio, never inches. Matching the aspect against
// the common paper sizes recovers the intent for the overwhelmingly common case; anything
// unusual (a receipt, a torn note) falls back to an 11-inch long edge, which keeps text at a
// believable size rather than producing a 20-inch page.

export interface PageSize {
  /** PDF points, 72 per inch. */
  width: number;
  height: number;
}

interface Candidate {
  name: string;
  /** Portrait, in points. */
  size: PageSize;
}

const CANDIDATES: Candidate[] = [
  // Letter first so it wins ties on this side of the Atlantic.
  { name: 'Letter', size: { width: 612, height: 792 } },
  { name: 'A4', size: { width: 595.28, height: 841.89 } },
  { name: 'Legal', size: { width: 612, height: 1008 } },
  { name: 'A5', size: { width: 419.53, height: 595.28 } },
  { name: 'A3', size: { width: 841.89, height: 1190.55 } },
];

const TOLERANCE = 0.04;
const FALLBACK_LONG_EDGE = 792; // 11 inches

export function pageSize(pixelWidth: number, pixelHeight: number): PageSize {
  if (pixelWidth <= 0 || pixelHeight <= 0) return { width: 612, height: 792 };

  const landscape = pixelWidth > pixelHeight;
  const shortPx = Math.min(pixelWidth, pixelHeight);
  const longPx = Math.max(pixelWidth, pixelHeight);
  const aspect = shortPx / longPx;

  for (const candidate of CANDIDATES) {
    const candidateAspect = candidate.size.width / candidate.size.height;
    if (Math.abs(candidateAspect - aspect) / candidateAspect <= TOLERANCE) {
      return landscape
        ? { width: candidate.size.height, height: candidate.size.width }
        : { ...candidate.size };
    }
  }

  const shortEdge = FALLBACK_LONG_EDGE * aspect;
  return landscape
    ? { width: FALLBACK_LONG_EDGE, height: shortEdge }
    : { width: shortEdge, height: FALLBACK_LONG_EDGE };
}

/** Name of the matched paper size, or null for the 11-inch fallback. */
export function paperName(pixelWidth: number, pixelHeight: number): string | null {
  if (pixelWidth <= 0 || pixelHeight <= 0) return null;
  const aspect = Math.min(pixelWidth, pixelHeight) / Math.max(pixelWidth, pixelHeight);
  for (const c of CANDIDATES) {
    const ca = c.size.width / c.size.height;
    if (Math.abs(ca - aspect) / ca <= TOLERANCE) return c.name;
  }
  return null;
}
