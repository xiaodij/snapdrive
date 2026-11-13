// Text helpers ported from SnapDrive/Core/Processing/OCRService.swift.
// Boxes are normalised with a bottom-left origin, so a larger midY is higher on the page.

import type { RecognizedLine } from './types';

const midY = (l: RecognizedLine) => l.box.y + l.box.height / 2;

/** Reading order for a page: top to bottom, then left to right. */
export function plainText(lines: RecognizedLine[]): string {
  return [...lines]
    .sort((a, b) => {
      // Treat lines within half a line-height of each other as the same row.
      if (Math.abs(midY(a) - midY(b)) > a.box.height * 0.5) return midY(b) - midY(a);
      return a.box.x - b.box.x;
    })
    .map((l) => l.text)
    .join('\n');
}

/** Whole-document text, with page separators when there is more than one page. */
export function documentText(pages: RecognizedLine[][]): string {
  return pages
    .map((lines, i) => (pages.length > 1 ? `--- Page ${i + 1} ---\n${plainText(lines)}` : plainText(lines)))
    .join('\n\n');
}

/** First plausible line of a page, used to suggest a filename. */
export function suggestedTitle(lines: RecognizedLine[]): string | null {
  const ordered = [...lines].sort((a, b) => midY(b) - midY(a));
  for (const line of ordered) {
    const cleaned = line.text.trim().replace(/[/\\:*?"<>|]/g, '-');
    // Skip page furniture and stray marks; look for something title-shaped.
    const length = [...cleaned].length;
    if (length < 4 || length > 60) continue;
    if (!/\p{L}/u.test(cleaned)) continue;
    if (line.confidence <= 0.5) continue;
    // v2 addition: OCR noise from logos and rules ("- ems ll @ -") passes the checks above.
    // A title has a run of 3+ letters/digits (or 2+ CJK characters) and is mostly letters and digits.
    if (!/[\p{L}\p{N}]{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/u.test(cleaned)) continue;
    const glyphs = [...cleaned.replace(/\s+/g, '')];
    const alnum = glyphs.filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
    if (alnum / glyphs.length < 0.7) continue;
    return cleaned;
  }
  return null;
}
