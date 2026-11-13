// Shared vocabulary for the scan pipeline. Port of SnapDrive/Core/Models/ScanTypes.swift.
//
// Everything under src/core is pure TypeScript with no DOM access, so it runs the same in
// the pipeline Web Worker, on the main thread, and under Node in the vitest suite.

/** How a page's pixels get rendered into the final PDF. */
export type ColorMode = 'color' | 'grayscale' | 'blackAndWhite';

export const COLOR_MODES: readonly ColorMode[] = ['color', 'grayscale', 'blackAndWhite'];

export const COLOR_MODE_LABEL: Record<ColorMode, string> = {
  color: 'Colour',
  grayscale: 'Greyscale',
  blackAndWhite: 'Black & White',
};

export const COLOR_MODE_SHORT: Record<ColorMode, string> = {
  color: 'Colour',
  grayscale: 'Grey',
  blackAndWhite: 'B&W',
};

/** What the user picked. `auto` defers to the page analyser, per page. */
export type ColorSelection = 'auto' | ColorMode;

export function resolveMode(selection: ColorSelection, detected: ColorMode): ColorMode {
  return selection === 'auto' ? detected : selection;
}

/** Output size/quality tier. Drives both the pixel cap and the JPEG quality. */
export type QualityTier = 'small' | 'balanced' | 'high';

export const QUALITY_TIERS: readonly QualityTier[] = ['small', 'balanced', 'high'];

export const QUALITY_LABEL: Record<QualityTier, string> = {
  small: 'Small',
  balanced: 'Balanced',
  high: 'High',
};

export const QUALITY_DETAIL: Record<QualityTier, string> = {
  small: 'Smallest files. Fine for text you just need to keep.',
  balanced: 'Good detail at a modest size. Recommended.',
  high: 'Maximum detail. Use for fine print or artwork.',
};

/**
 * Longest-edge pixel cap. Images are only ever scaled down, never up.
 *
 * For scale: an A4/Letter long edge is ~3500px at 300 dpi, so `balanced` colour lands around
 * 210 dpi and `high` around 290 dpi. Bilevel gets a much higher cap on purpose: 1-bit output
 * compresses ~20x, so the extra resolution is nearly free and it keeps small type crisp.
 */
export function maxLongEdge(tier: QualityTier, mode: ColorMode): number {
  const table: Record<QualityTier, Record<ColorMode, number>> = {
    small: { color: 1700, grayscale: 2000, blackAndWhite: 2600 },
    balanced: { color: 2500, grayscale: 2800, blackAndWhite: 3300 },
    high: { color: 3400, grayscale: 3600, blackAndWhite: 4200 },
  };
  return table[tier][mode];
}

/** The largest cap any tier/mode can ask for: the deskewed source page never needs more. */
export const SOURCE_MAX_LONG_EDGE = 4200;

/**
 * mozjpeg quality on a 0...1 scale (the encoder multiplies by 100), per tier and mode.
 *
 * v1 encoded with ImageIO at 0.50 / 0.70 / 0.82, whose scale is far gentler than libjpeg's:
 * ImageIO "0.70" keeps a page at 47.3 dB PSNR in colour and 53.0 dB in grey. These values are
 * the lowest mozjpeg qualities (standard Annex K tables, progressive) that reach v1's PSNR on
 * the same pixels for each tier, so v2 is never visibly softer than v1. Re-derive them with
 * test/core/jpeg-quality.test.ts if the encoder settings change.
 */
export function jpegQuality(tier: QualityTier, mode: ColorMode): number {
  const table: Record<QualityTier, { color: number; gray: number }> = {
    small: { color: 0.88, gray: 0.9 },
    balanced: { color: 0.94, gray: 0.95 },
    high: { color: 0.95, gray: 0.97 },
  };
  return mode === 'color' ? table[tier].color : table[tier].gray;
}

/** Normalised rectangle on the unit square. */
export interface UnitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One line of recognised text plus where OCR found it.
 *
 * `box` is normalised to the page with a **bottom-left origin** (PDF's convention, and Apple
 * Vision's, which v1 used). Tesseract reports top-left pixel boxes; the OCR adapter flips
 * them once, so nothing downstream ever has to.
 */
export interface RecognizedLine {
  text: string;
  box: UnitRect;
  /** 0...1 */
  confidence: number;
}

/** How a page's image bytes are stored inside the PDF. */
export type PDFImageEncoding =
  | 'jpegRGB' // /DCTDecode,  /DeviceRGB,  8 bpc
  | 'jpegGray' // /DCTDecode,  /DeviceGray, 8 bpc
  | 'flateBilevel' // /FlateDecode, /DeviceGray, 1 bpc
  | 'rawBilevel'; // no filter,   /DeviceGray, 1 bpc (fallback)

/** Output of the image renderer for one page. */
export interface RenderedPage {
  /** Already-encoded bytes, written into the PDF stream untouched. */
  data: Uint8Array;
  encoding: PDFImageEncoding;
  width: number;
  height: number;
  mode: ColorMode;
}

/** Everything the pipeline produced for one page. */
export interface ProcessedPage extends RenderedPage {
  detectedMode: ColorMode;
  lines: RecognizedLine[];
}
