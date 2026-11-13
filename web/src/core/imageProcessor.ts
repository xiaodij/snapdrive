// Port of SnapDrive/Core/Processing/ImageProcessor.swift.
//
// Turns a deskewed page into compressed, PDF-ready bytes.
//
// The heavy lifting for greyscale and bilevel is *flat-fielding*: divide the page by a heavily
// blurred copy of itself. The blur approximates the lighting across the sheet, so the division
// cancels shadows and vignetting and lands paper at a flat 1.0. That is what makes a fixed
// threshold safe on the bilevel path: a global threshold applied to an unnormalised photo
// would black out whichever corner your hand shaded.
//
// v1 ran these chains through CoreImage with an sRGB working space, i.e. on gamma-encoded
// values. Everything here works the same way: floats on 0...1 straight from the bytes, no
// linearisation, and no clamping until the final render, just as CoreImage kept float
// intermediates until `createCGImage`.

import { zlib } from './deflate';
import type { JpegEncoder } from './jpeg';
import {
  createFloat,
  createGray,
  createRGBA,
  fitLongEdge,
  type FloatImage,
  type GrayImage,
  type RGBAImage,
} from './raster';
import { resizeFloat, resizeRGBA, upscaleFloatCubic } from './resample';
import { jpegQuality, maxLongEdge, type ColorMode, type QualityTier, type RenderedPage } from './types';

/**
 * v2 rendering settings for greyscale and black & white (2026-11-13).
 *
 * v1's chains (kept verbatim in test/core/helpers/imageProcessorV1.ts) lost too much on real
 * captures: VisionKit and live-camera pages arrive soft and at ~200 dpi, and a 3x3 median
 * followed by a hard threshold at that resolution erased thin strokes (serif E arms, i-dots)
 * and left staircase edges. v2 sharpens after flat-fielding, renders soft pages at a print-like
 * resolution before thresholding, and pins paper to white and ink to black on the grey path.
 * Values were chosen with test/core/quality-lab.test.ts (OCR word accuracy + visual crops).
 */
export const QUALITY = {
  /** Ink threshold on the flat-fielded page (paper ~1.0). v1: 0.76. */
  bwThreshold: 0.8,
  /** Soft captures are enlarged up to this factor (never past the tier's cap) before thresholding. */
  bwMaxUpscale: 2,
  bwSharpenRadius: 1.0,
  bwSharpenAmount: 1.0,
  /** Isolated single black pixels are dropped after thresholding (v1's median did this, at a cost). */
  bwDespeckle: true,
  grayMaxUpscale: 1.5,
  /** Levels on the flat-fielded page: values >= white become paper white, <= black become ink black. */
  grayWhite: 0.91,
  grayBlack: 0.15,
  graySharpenRadius: 1.6,
  graySharpenAmount: 1.5,
};

/** v1's threshold, kept for reference and the parity helper. */
export const BILEVEL_THRESHOLD = 0.76;

/** CIColorControls' luminance weights (Rec. 709, as CoreImage rounds them). */
const CI_LUMA_R = 0.2125;
const CI_LUMA_G = 0.7154;
const CI_LUMA_B = 0.0721;

export interface ProcessOutput extends RenderedPage {
  /** The 8-bit pixels that were encoded (before 1-bit packing), for the review screen. */
  preview: RGBAImage;
}

export async function processPage(
  source: RGBAImage,
  mode: ColorMode,
  tier: QualityTier,
  encode: JpegEncoder,
): Promise<ProcessOutput> {
  const cap = maxLongEdge(tier, mode);

  switch (mode) {
    case 'color': {
      const scaled = downscale(source, cap);
      const { width, height } = scaled;
      const preview = enhanceColor(scaled);
      const data = await encode(preview, jpegQuality(tier, mode), false);
      return { data, encoding: 'jpegRGB', width, height, mode, preview };
    }
    case 'grayscale': {
      const gray = renderGray(source, cap);
      const { width, height } = gray;
      const preview = grayToRGBA(gray);
      const data = await encode(preview, jpegQuality(tier, mode), true);
      return { data, encoding: 'jpegGray', width, height, mode, preview };
    }
    case 'blackAndWhite': {
      const bw = renderBilevel(source, cap);
      const { width, height } = bw;
      const packed = packBilevel(bw);
      // Flate on 1-bit text typically lands 15-30x, which is why B&W pages end up an order
      // of magnitude smaller than the same page as JPEG.
      const deflated = zlib(packed, 9);
      const preview = grayToRGBA(bw);
      if (deflated) return { data: deflated, encoding: 'flateBilevel', width, height, mode, preview };
      return { data: packed, encoding: 'rawBilevel', width, height, mode, preview };
    }
  }
}

/**
 * Flat-fielded greyscale for OCR. Tesseract binarises with a global Otsu threshold, which a
 * shadowed photo defeats; handing it a page whose paper is already a flat white keeps faint
 * text in the corner a hand shaded.
 */
export function ocrInput(source: RGBAImage, maxEdge = 2600): GrayImage {
  const scaled = downscale(source, maxEdge);
  const flat = flatField(desaturate(scaled));
  contrast(flat, 1.18, 0);
  return floatToGray(flat);
}

// ── Filter chains ───────────────────────────────────────────────────────────────────────

/** Never scales up. Area average stands in for CoreImage's Lanczos. */
function downscale(image: RGBAImage, maxEdge: number): RGBAImage {
  if (Math.max(image.width, image.height) <= maxEdge) return image;
  const { width, height } = fitLongEdge(image.width, image.height, maxEdge);
  return resizeRGBA(image, width, height);
}

/**
 * Deliberately gentle. The capture step already balances the page, and flat-fielding a
 * colour page risks tinting large saturated areas like photos.
 */
function enhanceColor(image: RGBAImage): RGBAImage {
  const { width: w, height: h } = image;
  const n = w * h;
  const planes = [createFloat(w, h), createFloat(w, h), createFloat(w, h)];
  const [R, G, B] = planes.map((p) => p.data);
  const d = image.data;

  // CIColorControls: saturation (mix with luma), then brightness (add), then contrast
  // around 0.5. Values are left unclamped, as CoreImage's float intermediates were.
  const saturation = 1.06;
  const brightness = 0.02;
  const contrastK = 1.08;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = d[o] / 255;
    const g = d[o + 1] / 255;
    const b = d[o + 2] / 255;
    const l = CI_LUMA_R * r + CI_LUMA_G * g + CI_LUMA_B * b;
    R[i] = (l + (r - l) * saturation + brightness - 0.5) * contrastK + 0.5;
    G[i] = (l + (g - l) * saturation + brightness - 0.5) * contrastK + 0.5;
    B[i] = (l + (b - l) * saturation + brightness - 0.5) * contrastK + 0.5;
  }

  for (const plane of planes) unsharpMask(plane, 1.2, 0.4);

  const out = createRGBA(w, h);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    out.data[o] = R[i] * 255 + 0.5; // Uint8ClampedArray clamps and the +0.5 rounds
    out.data[o + 1] = G[i] * 255 + 0.5;
    out.data[o + 2] = B[i] * 255 + 0.5;
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * Output scale for a page: shrink to the cap, or enlarge a soft capture by up to `maxUpscale`
 * (never past the cap). Returns the working image at min(1, scale) and the final size.
 */
function plan(source: RGBAImage, cap: number, maxUpscale: number) {
  const long = Math.max(source.width, source.height);
  const scale = Math.min(cap / long, maxUpscale);
  const work = scale < 1 ? downscale(source, cap) : source;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  return { work, width, height, enlarge: scale > 1.02 };
}

/** Greyscale: flat-field, pin paper/ink with levels, sharpen, enlarge soft captures. */
function renderGray(source: RGBAImage, cap: number): GrayImage {
  const { work, width, height, enlarge } = plan(source, cap, QUALITY.grayMaxUpscale);
  let g = flatField(desaturate(work));
  levels(g, QUALITY.grayBlack, QUALITY.grayWhite);
  unsharpMask(g, QUALITY.graySharpenRadius, QUALITY.graySharpenAmount);
  if (enlarge) g = upscaleFloatCubic(g, width, height);
  return floatToGray(g);
}

/**
 * Black & white: flat-field, sharpen, enlarge soft captures to a print-like resolution, then
 * threshold. Thresholding the enlarged, still-continuous image is what keeps edges smooth and
 * thin strokes whole; thresholding first and enlarging after would only enlarge the staircase.
 */
function renderBilevel(source: RGBAImage, cap: number): GrayImage {
  const { work, width, height, enlarge } = plan(source, cap, QUALITY.bwMaxUpscale);
  let g = flatField(desaturate(work));
  unsharpMask(g, QUALITY.bwSharpenRadius, QUALITY.bwSharpenAmount);
  if (enlarge) g = upscaleFloatCubic(g, width, height);
  const out = createGray(g.width, g.height);
  const f = g.data;
  const t = QUALITY.bwThreshold;
  for (let i = 0; i < f.length; i++) out.data[i] = f[i] > t ? 255 : 0;
  if (QUALITY.bwDespeckle) despeckle(out);
  return out;
}

/** Map [black, white] to [0, 1], clamping: paper texture goes white, ink goes solid. */
function levels(plane: FloatImage, black: number, white: number): void {
  const p = plane.data;
  const k = 1 / Math.max(1e-3, white - black);
  for (let i = 0; i < p.length; i++) {
    const v = (p[i] - black) * k;
    p[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

/** Turn isolated black pixels (no black 8-neighbour) white. Sensor noise, not ink. */
function despeckle(img: GrayImage): void {
  const { width: w, height: h, data } = img;
  const src = new Uint8Array(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] !== 0) continue;
      let ink = 0;
      for (let dy = -1; dy <= 1 && !ink; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx || dy) && xx >= 0 && xx < w && src[yy * w + xx] === 0) {
            ink = 1;
            break;
          }
        }
      }
      if (!ink) data[i] = 255;
    }
  }
}

function desaturate(image: RGBAImage): FloatImage {
  const out = createFloat(image.width, image.height);
  const d = image.data;
  for (let i = 0, o = 0; i < out.data.length; i++, o += 4) {
    out.data[i] = (CI_LUMA_R * d[o] + CI_LUMA_G * d[o + 1] + CI_LUMA_B * d[o + 2]) / 255;
  }
  return out;
}

/** Divide the page by a heavily blurred copy of itself to cancel uneven lighting. */
export function flatField(gray: FloatImage): FloatImage {
  // Radius scales with the page so the blur always estimates *lighting* rather than smearing
  // away glyphs: roughly 1/40th of the short edge.
  const radius = Math.max(8, Math.min(gray.width, gray.height) / 40);
  // Edge-clamped, so the blur does not pull in black from outside the page and darken every
  // margin (v1 used clampedToExtent for the same reason).
  const background = gaussianBlur(gray, radius);
  const out = createFloat(gray.width, gray.height);
  const g = gray.data;
  const bg = background.data;
  for (let i = 0; i < g.length; i++) {
    const v = g[i] / Math.max(bg[i], 1e-4);
    out.data[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

function contrast(plane: FloatImage, k: number, brightness: number): void {
  const p = plane.data;
  for (let i = 0; i < p.length; i++) p[i] = (p[i] + brightness - 0.5) * k + 0.5;
}

/** CIUnsharpMask: x + intensity * (x - gaussian(x, radius)). In place. */
function unsharpMask(plane: FloatImage, radius: number, intensity: number): void {
  const blurred = gaussianExact(plane, radius);
  const p = plane.data;
  const b = blurred.data;
  for (let i = 0; i < p.length; i++) p[i] += intensity * (p[i] - b[i]);
}

// ── Blur ────────────────────────────────────────────────────────────────────────────────

/**
 * Gaussian blur of standard deviation `sigma` (CoreImage's "radius"), edge-clamped.
 *
 * Large sigmas (the flat-field's ~60px) are done at reduced resolution: area-average down by
 * f, three box passes approximating the remaining Gaussian, bilinear back up. The down/up
 * steps contribute variance of their own (~f²/12 and ~f²/6), which is subtracted from the
 * box passes so the total matches the requested sigma. The result is smooth by construction,
 * which is all a lighting estimate needs, at a few percent of the cost of a direct kernel.
 */
export function gaussianBlur(src: FloatImage, sigma: number): FloatImage {
  if (sigma < 6) return gaussianExact(src, sigma);
  const f = Math.max(1, Math.floor(sigma / 4));
  const sw = Math.max(1, Math.round(src.width / f));
  const sh = Math.max(1, Math.round(src.height / f));
  const small = resizeFloat(src, sw, sh);
  const fx = src.width / sw;
  const fy = src.height / sh;
  const sigmaX = Math.sqrt(Math.max(0.25, (sigma * sigma - (fx * fx) / 4) / (fx * fx)));
  const sigmaY = Math.sqrt(Math.max(0.25, (sigma * sigma - (fy * fy) / 4) / (fy * fy)));
  const blurred = boxBlur3(small, sigmaX, sigmaY);
  return resizeFloat(blurred, src.width, src.height);
}

/** Direct separable Gaussian, kernel out to 3 sigma, edge-clamped. For small sigmas. */
export function gaussianExact(src: FloatImage, sigma: number): FloatImage {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width: w, height: h } = src;
  const s = src.data;
  const mid = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        let xi = x + k;
        xi = xi < 0 ? 0 : xi >= w ? w - 1 : xi;
        acc += s[row + xi] * kernel[k + r];
      }
      mid[row + x] = acc;
    }
  }
  const out = createFloat(w, h);
  const o = out.data;
  for (let y = 0; y < h; y++) {
    for (let k = -r; k <= r; k++) {
      let yi = y + k;
      yi = yi < 0 ? 0 : yi >= h ? h - 1 : yi;
      const kv = kernel[k + r];
      const rowIn = yi * w;
      const rowOut = y * w;
      for (let x = 0; x < w; x++) o[rowOut + x] += mid[rowIn + x] * kv;
    }
  }
  return out;
}

/** Three box passes per axis whose combined variance equals sigma² (Kutskir's sizes). */
function boxBlur3(src: FloatImage, sigmaX: number, sigmaY: number): FloatImage {
  const { width: w, height: h } = src;
  const a = new Float32Array(src.data);
  const b = new Float32Array(a.length);
  const rx = boxRadii(sigmaX);
  const ry = boxRadii(sigmaY);
  // Box passes are linear and separable, so interleaving H and V changes nothing.
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, rx[pass]); // a → b
    boxV(b, a, w, h, ry[pass]); // b → a
  }
  return { width: w, height: h, data: a };
}

function boxRadii(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii;
}

/** Horizontal running-sum box of radius r, edge-clamped. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row];
    const last = src[row + w - 1];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc / span;
      const add = x + r + 1;
      const sub = x - r;
      acc += (add < w ? src[row + add] : last) - (sub >= 0 ? src[row + sub] : first);
    }
  }
}

/** Vertical running-sum box of radius r, edge-clamped. */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  const span = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    const first = src[x];
    const last = src[(h - 1) * w + x];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / span;
      const add = y + r + 1;
      const sub = y - r;
      acc += (add < h ? src[add * w + x] : last) - (sub >= 0 ? src[sub * w + x] : first);
    }
  }
}

// ── Rendering & packing ─────────────────────────────────────────────────────────────────

function floatToGray(plane: FloatImage): GrayImage {
  const out = createGray(plane.width, plane.height);
  const p = plane.data;
  for (let i = 0; i < p.length; i++) {
    const v = p[i] * 255 + 0.5;
    out.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

function grayToRGBA(gray: GrayImage): RGBAImage {
  const out = createRGBA(gray.width, gray.height);
  for (let i = 0, o = 0; i < gray.data.length; i++, o += 4) {
    const v = gray.data[i];
    out.data[o] = v;
    out.data[o + 1] = v;
    out.data[o + 2] = v;
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * Pack an already-thresholded 8-bit image down to 1 bit per pixel, MSB first, rows padded to
 * whole bytes. PDF's DeviceGray reads 0 as black and 1 as white, which is exactly this
 * mapping, so no /Decode array is needed.
 */
export function packBilevel(image: GrayImage): Uint8Array {
  const { width: w, height: h } = image;
  const rowBytes = (w + 7) >> 3;
  const out = new Uint8Array(rowBytes * h);
  const d = image.data;
  for (let y = 0; y < h; y++) {
    const rowIn = y * w;
    const rowOut = y * rowBytes;
    for (let x = 0; x < w; x++) {
      if (d[rowIn + x] >= 128) out[rowOut + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}
