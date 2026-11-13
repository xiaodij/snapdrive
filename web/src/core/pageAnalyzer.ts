// Port of SnapDrive/Core/Processing/PageAnalyzer.swift.
//
// Decides whether a scanned page wants colour, greyscale or bilevel treatment.
//
// Two independent measurements, each taken at the resolution that makes it meaningful:
//
// - **Colour** comes from a 256px thumbnail. Hue is a low-frequency property, so a thumbnail
//   sees it fine. Pixels are white-balanced against the page's own paper colour first,
//   otherwise every page shot under tungsten light reads as "colour".
//
// - **Tone** comes from the whole page at near-native resolution. Downsampling a text page
//   turns crisp black-on-white into grey mush, so a histogram taken from a thumbnail reports
//   midtones everywhere there is text and never picks bilevel. Each pixel is normalised
//   against a paper-only estimate of the lighting, which also cancels shadows.

import { fitLongEdge, type FloatImage, type RGBAImage } from './raster';
import { resizeGray, resizeRGBA, toGray } from './resample';
import type { ColorMode } from './types';

/** Fraction of the page that must carry real colour before we keep it in colour. */
const COLOR_AREA_THRESHOLD = 0.05;
/** A much smaller patch of *vivid* colour is also enough: catches logos and stamps. */
const VIVID_AREA_THRESHOLD = 0.015;
/** Saturation, measured after white balancing, above which a pixel counts as coloured. */
const SATURATION_THRESHOLD = 0.16;
const VIVID_SATURATION_THRESHOLD = 0.35;

/** Pooled midtone fraction above which we assume photos or shading and keep greys. */
const MIDTONE_THRESHOLD = 0.12;
/**
 * A single heavily-midtone tile means a localised photo, even if the page average stays low.
 * Without this a small photo on an otherwise textual page gets thresholded into a black blob.
 * Text tiles sit around 0.03, so the margin here is wide.
 */
const TILE_MIDTONE_THRESHOLD = 0.3;

export const ANALYZER_THRESHOLDS = {
  COLOR_AREA_THRESHOLD,
  VIVID_AREA_THRESHOLD,
  SATURATION_THRESHOLD,
  VIVID_SATURATION_THRESHOLD,
  MIDTONE_THRESHOLD,
  TILE_MIDTONE_THRESHOLD,
} as const;

export interface AnalyzerStats {
  coloredFraction: number;
  vividFraction: number;
  midtoneFraction: number;
  maxTileMidtone: number;
  paperWhite: { r: number; g: number; b: number };
  /** Per-tile midtone fractions, in row-major grid order. Diagnostic only. */
  tileMidtones: number[];
}

export function analyze(img: RGBAImage): { mode: ColorMode; stats: AnalyzerStats } {
  const color = colorStats(img);
  const tone = toneStats(img);
  if (!color || !tone) {
    // If the pixels can't be read, colour is the choice that destroys least.
    return {
      mode: 'color',
      stats: {
        coloredFraction: 1,
        vividFraction: 1,
        midtoneFraction: 1,
        maxTileMidtone: 1,
        paperWhite: { r: 1, g: 1, b: 1 },
        tileMidtones: [],
      },
    };
  }

  const stats: AnalyzerStats = {
    coloredFraction: color.colored,
    vividFraction: color.vivid,
    midtoneFraction: tone.pooled,
    maxTileMidtone: tone.maxTile,
    paperWhite: color.paperWhite,
    tileMidtones: tone.tiles,
  };

  if (stats.coloredFraction > COLOR_AREA_THRESHOLD || stats.vividFraction > VIVID_AREA_THRESHOLD) {
    return { mode: 'color', stats };
  }
  if (stats.midtoneFraction > MIDTONE_THRESHOLD || stats.maxTileMidtone > TILE_MIDTONE_THRESHOLD) {
    return { mode: 'grayscale', stats };
  }
  return { mode: 'blackAndWhite', stats };
}

// ── Colour ──────────────────────────────────────────────────────────────────────────────

function colorStats(
  img: RGBAImage,
): { colored: number; vivid: number; paperWhite: { r: number; g: number; b: number } } | null {
  if (img.width < 1 || img.height < 1) return null;
  const { width: w, height: h } = fitLongEdge(img.width, img.height, 256);
  const thumb = resizeRGBA(img, w, h);
  const px = thumb.data;
  const count = w * h;

  const luma = new Float64Array(count);
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    luma[i] = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
  }

  // Paper colour = mean of the brightest fifth of the page. Dividing by this is a von Kries
  // white balance, which strips the illuminant's cast so that only pixels whose hue
  // genuinely differs *from the paper* register as coloured.
  const cutoff = percentile(luma, 0.8);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let bright = 0;
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    if (luma[i] >= cutoff) {
      sr += px[o] / 255;
      sg += px[o + 1] / 255;
      sb += px[o + 2] / 255;
      bright++;
    }
  }
  if (bright === 0) return null;
  const paper = {
    r: Math.max(0.05, sr / bright),
    g: Math.max(0.05, sg / bright),
    b: Math.max(0.05, sb / bright),
  };

  let colored = 0;
  let vivid = 0;
  let counted = 0;
  for (let o = 0; o < count * 4; o += 4) {
    const r = Math.min(1, px[o] / 255 / paper.r);
    const g = Math.min(1, px[o + 1] / 255 / paper.g);
    const b = Math.min(1, px[o + 2] / 255 / paper.b);
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    counted++;
    // Near-black pixels carry no reliable hue; excluding them keeps dense text and JPEG
    // fringing out of the colour vote.
    if (hi <= 0.18) continue;
    const saturation = (hi - lo) / hi;
    if (saturation > SATURATION_THRESHOLD) colored++;
    if (saturation > VIVID_SATURATION_THRESHOLD) vivid++;
  }
  if (counted === 0) return null;
  return { colored: colored / counted, vivid: vivid / counted, paperWhite: paper };
}

// ── Tone ────────────────────────────────────────────────────────────────────────────────

/**
 * Midtone measurement, normalised against a paper-only estimate of the lighting.
 *
 * The illumination field is built by *dilating* a thumbnail (a local maximum erases text,
 * shaded boxes and photos, leaving only paper), then smoothing what remains. Dividing by that
 * field cancels shadow and vignetting while leaving genuine content intact, which is the
 * distinction a per-tile percentile cannot make: a flat grey box and shadowed paper are the
 * same pixel value, and only the surrounding paper level says which is which.
 */
function toneStats(img: RGBAImage): { pooled: number; maxTile: number; tiles: number[] } | null {
  const field = illuminationField(img);
  if (!field) return null;

  // One render of the whole page rather than a grid of sampled crops: sampling left gaps a
  // small photo could fall through; this gives exact coverage.
  const { width: w, height: h } = fitLongEdge(img.width, img.height, 2400);
  const page = resizeGray(toGray(img), w, h);
  const pixels = page.data;

  const grid = 10;
  const cellMidtone = new Int32Array(grid * grid);
  const cellTotal = new Int32Array(grid * grid);

  // Precomputed row/column lookups keep the inner loop to array reads. The field is smooth by
  // construction, so nearest-neighbour sampling costs nothing in accuracy.
  const fieldRow = new Int32Array(h);
  for (let y = 0; y < h; y++) fieldRow[y] = clamp(Math.floor((y / h) * field.height), 0, field.height - 1);
  const fieldCol = new Int32Array(w);
  for (let x = 0; x < w; x++) fieldCol[x] = clamp(Math.floor((x / w) * field.width), 0, field.width - 1);
  const cellRow = new Int32Array(h);
  for (let y = 0; y < h; y++) cellRow[y] = Math.min(grid - 1, Math.floor((y * grid) / h));
  const cellCol = new Int32Array(w);
  for (let x = 0; x < w; x++) cellCol[x] = Math.min(grid - 1, Math.floor((x * grid) / w));

  const fv = field.data;
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    const fieldBase = fieldRow[y] * field.width;
    const cellBase = cellRow[y] * grid;
    for (let x = 0; x < w; x++) {
      const reference = Math.max(24, fv[fieldBase + fieldCol[x]] * 255);
      const normalized = Math.min(1, pixels[rowBase + x] / reference);
      const cell = cellBase + cellCol[x];
      cellTotal[cell]++;
      if (normalized > 0.25 && normalized < 0.8) cellMidtone[cell]++;
    }
  }

  let midtoneTotal = 0;
  let pixelTotal = 0;
  for (let i = 0; i < grid * grid; i++) {
    midtoneTotal += cellMidtone[i];
    pixelTotal += cellTotal[i];
  }
  if (pixelTotal === 0) return null;

  const tiles: number[] = [];
  let maxTile = 0;
  for (let i = 0; i < grid * grid; i++) {
    if (cellTotal[i] === 0) continue;
    const fraction = cellMidtone[i] / cellTotal[i];
    tiles.push(fraction);
    maxTile = Math.max(maxTile, fraction);
  }
  return { pooled: midtoneTotal / pixelTotal, maxTile, tiles };
}

/** Paper-level lighting estimate, as a small grid of 0...1 values. */
function illuminationField(img: RGBAImage): FloatImage | null {
  if (img.width < 1 || img.height < 1) return null;
  const scale = Math.min(1, 256 / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const thumb = toGray(resizeRGBA(img, w, h));

  let values: Float32Array = new Float32Array(w * h);
  for (let i = 0; i < values.length; i++) values[i] = thumb.data[i] / 255;

  // Radius has to exceed the largest non-paper feature we want bridged over, but stay well
  // under the scale on which lighting actually changes.
  const radius = Math.max(4, Math.floor(Math.max(w, h) / 8));
  values = dilate(values, w, h, radius);
  values = boxBlur(values, w, h, Math.floor(radius / 2));
  return { width: w, height: h, data: values };
}

/** Separable local maximum over a (2r+1) square. */
function dilate(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const pass = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = src[y * w + x];
      for (let i = Math.max(0, x - radius), e = Math.min(w - 1, x + radius); i <= e; i++) {
        const v = src[y * w + i];
        if (v > acc) acc = v;
      }
      pass[y * w + x] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = pass[y * w + x];
      for (let i = Math.max(0, y - radius), e = Math.min(h - 1, y + radius); i <= e; i++) {
        const v = pass[i * w + x];
        if (v > acc) acc = v;
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Separable box mean over a (2r+1) square, window shrunk at the edges (as v1). */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  const pass = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(w - 1, x + radius);
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += src[y * w + i];
      pass[y * w + x] = sum / (hi - lo + 1);
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - radius);
      const hi = Math.min(h - 1, y + radius);
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += pass[i * w + x];
      out[y * w + x] = sum / (hi - lo + 1);
    }
  }
  return out;
}

// ── Utilities ───────────────────────────────────────────────────────────────────────────

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
