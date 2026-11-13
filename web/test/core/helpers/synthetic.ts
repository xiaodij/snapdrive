// Synthetic "scans", mirroring Tools/PipelineTest/main.swift's makePage() so the TS analyser
// is exercised on the same scenarios v1 validated against.
//
// Node has no font rasteriser, so text is drawn as glyph-like strokes: stems, bars and bowls
// at Helvetica's proportions (cap height 0.72 em, x-height 0.52 em, stem ~0.085 em), with
// distance-based anti-aliasing so stroke edges produce the same partial-coverage greys real
// text does. Coordinates follow CoreGraphics (origin bottom-left, y up) to keep the geometry
// identical to v1's; `toRow` flips to buffer rows once.

import type { RGBAImage } from '../../../src/core/raster';

export interface PageOptions {
  width: number;
  height: number;
  shadow: boolean;
  colorAccent: boolean;
  grayPhoto: boolean;
  photoScale?: number;
  warmCast?: boolean;
  grayBox?: boolean;
}

export const BODY_LINES = [
  'INVOICE 2026-0814',
  'Atlanta Industry Supply Co.',
  '1450 Riverbend Road SE, Calgary AB',
  '',
  'Description                 Qty      Amount',
  'Hydraulic coupling 3/4in      12      408.00',
  'Reinforced hose, 10m           4      236.50',
  'Shipping and handling          1       45.00',
  '',
  'Subtotal                             689.50',
  'GST 5 percent                         34.48',
  'Total due                            723.98',
  '',
  'Payment is due within thirty days of the invoice',
  'date. Late payments accrue interest at 1.5 percent',
  'per month. Please quote the invoice number on all',
  'remittances sent to accounts@example.com.',
];

/** Float RGB canvas, 0...1, CG coordinates. */
class Canvas {
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const n = width * height;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
  }

  /** Buffer row for a CG y coordinate of a pixel centre. */
  idx(px: number, cgRowFromBottom: number) {
    return (this.height - 1 - cgRowFromBottom) * this.width + px;
  }

  /** Source-over blend at coverage `a`. */
  blend(i: number, c: [number, number, number], a: number) {
    this.r[i] += (c[0] - this.r[i]) * a;
    this.g[i] += (c[1] - this.g[i]) * a;
    this.b[i] += (c[2] - this.b[i]) * a;
  }

  /** Anti-aliased axis-aligned rect fill, CG coords. Coverage = pixel overlap area. */
  fillRect(x: number, y: number, w: number, h: number, c: [number, number, number], alpha = 1) {
    const x0 = Math.max(0, Math.floor(x));
    const x1 = Math.min(this.width - 1, Math.ceil(x + w) - 1);
    const y0 = Math.max(0, Math.floor(y));
    const y1 = Math.min(this.height - 1, Math.ceil(y + h) - 1);
    for (let py = y0; py <= y1; py++) {
      const cy = Math.min(py + 1, y + h) - Math.max(py, y);
      if (cy <= 0) continue;
      for (let px = x0; px <= x1; px++) {
        const cx = Math.min(px + 1, x + w) - Math.max(px, x);
        if (cx <= 0) continue;
        this.blend(this.idx(px, py), c, cx * cy * alpha);
      }
    }
  }

  /** Anti-aliased capsule (thick line with round caps), CG coords. */
  stroke(x0: number, y0: number, x1: number, y1: number, width: number, c: [number, number, number]) {
    const half = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1) + half + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1) + half + 1));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        let t = ((cx - x0) * dx + (cy - y0) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - (x0 + t * dx);
        const ey = cy - (y0 + t * dy);
        const d = Math.sqrt(ex * ex + ey * ey);
        const cov = Math.min(1, Math.max(0, half + 0.5 - d));
        if (cov > 0) this.blend(this.idx(px, py), c, cov);
      }
    }
  }

  /** Anti-aliased filled circle, clipped to a rect, CG coords. */
  fillCircle(cx: number, cy: number, r: number, c: [number, number, number], alpha: number, clip: Rect) {
    const minX = Math.max(Math.floor(clip.x), Math.floor(cx - r - 1), 0);
    const maxX = Math.min(Math.ceil(clip.x + clip.w) - 1, Math.ceil(cx + r + 1), this.width - 1);
    const minY = Math.max(Math.floor(clip.y), Math.floor(cy - r - 1), 0);
    const maxY = Math.min(Math.ceil(clip.y + clip.h) - 1, Math.ceil(cy + r + 1), this.height - 1);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        const cov = Math.min(1, Math.max(0, r + 0.5 - d));
        if (cov > 0) this.blend(this.idx(px, py), c, cov * alpha);
      }
    }
  }

  toRGBA(): RGBAImage {
    const n = this.width * this.height;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = this.r[i] * 255 + 0.5;
      data[i * 4 + 1] = this.g[i] * 255 + 0.5;
      data[i * 4 + 2] = this.b[i] * 255 + 0.5;
      data[i * 4 + 3] = 255;
    }
    return { width: this.width, height: this.height, data };
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** v1's LCG, bit-for-bit (UInt64 wrapping arithmetic). */
function lcg(seed0: bigint) {
  let seed = seed0;
  const mask = (1n << 64n) - 1n;
  return () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & mask;
    return Number((seed >> 33n) % 10000n) / 10000;
  };
}

export function makePage(o: PageOptions): RGBAImage {
  const { width, height } = o;
  const cv = new Canvas(width, height);

  // Paper
  cv.r.fill(0.98);
  cv.g.fill(0.975);
  cv.b.fill(0.96);

  // A greyscale photograph block: the thing that should pull the decision to greyscale.
  if (o.grayPhoto) {
    const scale = o.photoScale ?? 1;
    const rect: Rect = { x: width * 0.12, y: height * 0.42, w: width * 0.76 * scale, h: height * 0.34 * scale };
    const stops: [number, number][] = [
      [0, 0.15],
      [0.55, 0.85],
      [1, 0.35],
    ];
    const len2 = rect.w * rect.w + rect.h * rect.h;
    for (let py = Math.floor(rect.y); py < Math.ceil(rect.y + rect.h); py++) {
      for (let px = Math.floor(rect.x); px < Math.ceil(rect.x + rect.w); px++) {
        const t = ((px + 0.5 - rect.x) * rect.w + (py + 0.5 - rect.y) * rect.h) / len2;
        const v = gradientAt(stops, Math.min(1, Math.max(0, t)));
        const i = cv.idx(px, py);
        cv.r[i] = cv.g[i] = cv.b[i] = v;
      }
    }
    // Texture at several scales. A real photograph carries detail at many frequencies; a
    // bare linear ramp is indistinguishable from a lighting gradient by construction.
    const rand = lcg(0x5eedn);
    for (let k = 0; k < 220; k++) {
      const r = (0.01 + rand() * 0.09) * rect.w;
      const cx = rect.x + rand() * rect.w;
      const cy = rect.y + rand() * rect.h;
      const gray = 0.12 + rand() * 0.76;
      const alpha = 0.35 + rand() * 0.4;
      cv.fillCircle(cx, cy, r, [gray, gray, gray], alpha, rect);
    }
  }

  // A flat mid-grey block: a filled table header or shaded box.
  if (o.grayBox) {
    cv.fillRect(width * 0.12, height * 0.45, width * 0.76, height * 0.22, [0.55, 0.55, 0.55]);
  }

  // A saturated logo block: should flip the decision to colour.
  if (o.colorAccent) {
    cv.fillRect(width * 0.08, height * 0.86, width * 0.3, height * 0.055, [0.11, 0.42, 0.82]);
    cv.fillRect(width * 0.42, height * 0.86, width * 0.14, height * 0.055, [0.9, 0.29, 0.16]);
  }

  // Body text
  const fontSize = height * 0.018;
  let y = height * 0.8;
  for (const line of BODY_LINES) {
    if (line) drawTextLine(cv, line, width * 0.1, y, fontSize);
    y -= fontSize * 1.7;
  }

  // Uneven lighting: the shadow a hand or phone body casts across a real capture.
  if (o.shadow) {
    const p0 = { x: 0, y: height };
    const p1 = { x: width * 0.85, y: 0 };
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len2 = dx * dx + dy * dy;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const t = ((px + 0.5 - p0.x) * dx + (py + 0.5 - p0.y) * dy) / len2;
        // No extend options in v1: outside the gradient's span nothing is drawn.
        if (t < 0 || t > 1) continue;
        const i = cv.idx(px, py);
        cv.r[i] *= 0.42 + 0.58 * t;
        cv.g[i] *= 0.42 + 0.58 * t;
        cv.b[i] *= 0.45 + 0.55 * t;
      }
    }
  }

  // Tungsten-style illuminant. Nothing on the page is coloured, so this must still come out
  // as B&W: it is the case that raw-chroma detection gets wrong.
  if (o.warmCast) {
    for (let i = 0; i < cv.r.length; i++) {
      cv.g[i] *= 0.88;
      cv.b[i] *= 0.72;
    }
  }

  return cv.toRGBA();
}

function gradientAt(stops: [number, number][], t: number): number {
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, v0] = stops[k - 1];
      const [t1, v1] = stops[k];
      return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
    }
  }
  return stops[stops.length - 1][1];
}

// ── Glyph-like text ─────────────────────────────────────────────────────────────────────

const INK: [number, number, number] = [0.08, 0.08, 0.08];

/** Unit-box strokes [x0, y0, x1, y1] (0...1 across the glyph's ink box). */
const TEMPLATES: number[][][] = [
  [[0, 0, 0, 1], [1, 0, 1, 1], [0, 0.5, 1, 0.5]], // H
  [[0, 0, 0, 1], [0, 1, 1, 1], [0, 0.5, 0.8, 0.5], [0, 0, 1, 0]], // E
  [[0, 0.15, 0, 0.85], [1, 0.15, 1, 0.85], [0.15, 1, 0.85, 1], [0.15, 0, 0.85, 0]], // O
  [[0, 0, 0.5, 1], [0.5, 1, 1, 0], [0.25, 0.4, 0.75, 0.4]], // A
  [[0, 1, 1, 1], [0.5, 1, 0.5, 0]], // T
  [[0, 0, 0, 1], [0, 0, 1, 0]], // L
  [[0, 0, 0, 1], [0, 1, 0.8, 1], [0.8, 1, 1, 0.75], [1, 0.75, 0.8, 0.5], [0, 0.5, 0.8, 0.5]], // P
  [[0, 1, 0.5, 0], [0.5, 0, 1, 1]], // V
  [[0, 0.15, 0, 0.85], [0.15, 1, 1, 1], [0.15, 0, 1, 0]], // C
  [[0, 0, 0, 1], [0, 0.4, 1, 1], [0.3, 0.6, 1, 0]], // K
  [[1, 1, 0, 1], [0, 1, 0, 0.5], [0, 0.5, 1, 0.5], [1, 0.5, 1, 0], [1, 0, 0, 0]], // S/5-ish
  [[0, 0, 0, 1], [0, 1, 1, 0], [1, 0, 1, 1]], // N
];

function drawTextLine(cv: Canvas, text: string, x0: number, baseline: number, em: number) {
  const stem = em * 0.085;
  let x = x0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    if (ch === ' ') {
      x += em * 0.278;
      continue;
    }
    const upper = /[A-Z0-9]/.test(ch);
    const tall = upper || /[bdfhklt]/.test(ch);
    const desc = /[gjpqy]/.test(ch);
    const narrow = /[il1.,:;'|!]/.test(ch);
    const advance = em * (narrow ? 0.28 : upper ? 0.62 : 0.53);

    if (ch === '.' || ch === ',') {
      cv.stroke(x + advance * 0.4, baseline + stem, x + advance * 0.4, baseline + stem * 1.2, stem * 1.4, INK);
    } else if (ch === '-') {
      cv.stroke(x + advance * 0.15, baseline + em * 0.3, x + advance * 0.8, baseline + em * 0.3, stem, INK);
    } else if (narrow) {
      cv.stroke(x + advance * 0.45, baseline, x + advance * 0.45, baseline + em * (tall ? 0.72 : 0.52), stem, INK);
    } else {
      const top = em * (tall ? 0.72 : 0.52);
      const bottom = desc ? -em * 0.21 : 0;
      const left = x + em * 0.07;
      const width = advance - em * 0.16;
      const t = TEMPLATES[(code * 7 + 3) % TEMPLATES.length];
      for (const [ax, ay, bx, by] of t) {
        cv.stroke(
          left + ax * width,
          baseline + bottom + ay * (top - bottom),
          left + bx * width,
          baseline + bottom + by * (top - bottom),
          stem,
          INK,
        );
      }
    }
    x += advance;
  }
}

/** Mean Rec.709 luminance of a 24px patch centred on a unit point (top-left origin, as v1). */
export function patchLuminance(img: RGBAImage, ux: number, uy: number): number {
  const size = 24;
  const px = Math.max(0, Math.floor(ux * img.width) - size / 2);
  const py = Math.max(0, Math.floor(uy * img.height) - size / 2);
  let sum = 0;
  for (let y = py; y < py + size; y++) {
    for (let x = px; x < px + size; x++) {
      const o = (y * img.width + x) * 4;
      sum += (0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]) / 255;
    }
  }
  return sum / (size * size);
}

/** Plausible OCR boxes for BODY_LINES as drawn by makePage (bottom-left, normalised). */
export function bodyLineBoxes(width: number, height: number) {
  const em = height * 0.018;
  const lines: { text: string; box: { x: number; y: number; width: number; height: number }; confidence: number }[] = [];
  let y = height * 0.8;
  for (const text of BODY_LINES) {
    if (text) {
      lines.push({
        text,
        box: { x: 0.1, y: (y - em * 0.21) / height, width: (text.length * em * 0.55) / width, height: em / height },
        confidence: 0.95,
      });
    }
    y -= em * 1.7;
  }
  return lines;
}
