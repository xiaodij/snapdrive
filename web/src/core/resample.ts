// Deterministic resampling for the pipeline.
//
// v1 resized by drawing into a CGContext (interpolation "medium") or through CoreImage's
// Lanczos filter. Neither exists here, so this uses an exact area average when shrinking and
// bilinear interpolation when enlarging. Area averaging is what a thumbnail measurement wants:
// every source pixel contributes to exactly one place, so a fraction measured on the small
// image is the same fraction of the page — no aliasing, no ringing.

import {
  createFloat,
  createGray,
  createRGBA,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  type FloatImage,
  type GrayImage,
  type RGBAImage,
} from './raster';

/** Per-output-sample source contributors along one axis. */
interface AxisWeights {
  start: Int32Array;
  count: Int32Array;
  /** Flat, `stride` slots per output sample. */
  weights: Float32Array;
  stride: number;
}

function axisWeights(srcN: number, dstN: number): AxisWeights {
  const start = new Int32Array(dstN);
  const count = new Int32Array(dstN);

  if (dstN < srcN) {
    // Shrinking: each output covers `scale` source samples; weight each by its overlap.
    const scale = srcN / dstN;
    const stride = Math.ceil(scale) + 1;
    const weights = new Float32Array(dstN * stride);
    for (let i = 0; i < dstN; i++) {
      const left = i * scale;
      const right = Math.min(srcN, (i + 1) * scale);
      const j0 = Math.floor(left);
      const j1 = Math.min(srcN, Math.ceil(right));
      start[i] = j0;
      count[i] = j1 - j0;
      for (let j = j0; j < j1; j++) {
        const overlap = Math.min(right, j + 1) - Math.max(left, j);
        weights[i * stride + (j - j0)] = overlap / scale;
      }
    }
    return { start, count, weights, stride };
  }

  // Enlarging (or same size): bilinear on pixel centres, clamped at the edges.
  const stride = 2;
  const weights = new Float32Array(dstN * stride);
  const scale = srcN / dstN;
  for (let i = 0; i < dstN; i++) {
    const centre = (i + 0.5) * scale - 0.5;
    let j0 = Math.floor(centre);
    let frac = centre - j0;
    if (j0 < 0) {
      j0 = 0;
      frac = 0;
    }
    if (j0 >= srcN - 1) {
      j0 = srcN - 1;
      frac = 0;
    }
    start[i] = j0;
    count[i] = frac > 0 ? 2 : 1;
    weights[i * stride] = 1 - frac;
    weights[i * stride + 1] = frac;
  }
  return { start, count, weights, stride };
}

/**
 * Resample `channels` interleaved planes. Returns floats in the source's units.
 * Separable: horizontal pass into a float buffer, then vertical.
 */
function resampleInterleaved(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  channels: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const wx = axisWeights(srcW, dstW);
  const wy = axisWeights(srcH, dstH);

  // Horizontal: srcH rows of dstW samples.
  const mid = new Float32Array(dstW * srcH * channels);
  for (let y = 0; y < srcH; y++) {
    const rowIn = y * srcW * channels;
    const rowOut = y * dstW * channels;
    for (let x = 0; x < dstW; x++) {
      const s = wx.start[x];
      const n = wx.count[x];
      const wBase = x * wx.stride;
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += src[rowIn + (s + k) * channels + c] * wx.weights[wBase + k];
        mid[rowOut + x * channels + c] = acc;
      }
    }
  }

  // Vertical.
  const out = new Float32Array(dstW * dstH * channels);
  const rowLen = dstW * channels;
  for (let y = 0; y < dstH; y++) {
    const s = wy.start[y];
    const n = wy.count[y];
    const wBase = y * wy.stride;
    const rowOut = y * rowLen;
    for (let k = 0; k < n; k++) {
      const w = wy.weights[wBase + k];
      if (w === 0) continue;
      const rowIn = (s + k) * rowLen;
      for (let i = 0; i < rowLen; i++) out[rowOut + i] += mid[rowIn + i] * w;
    }
  }
  return out;
}

/** Area average when shrinking, bilinear when enlarging. Alpha is forced opaque. */
export function resizeRGBA(img: RGBAImage, width: number, height: number): RGBAImage {
  if (width === img.width && height === img.height) {
    return { width, height, data: new Uint8ClampedArray(img.data) };
  }
  // Pack RGB only: alpha carries nothing for a scan and would cost a third more work.
  const n = img.width * img.height;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    rgb[i * 3] = img.data[o];
    rgb[i * 3 + 1] = img.data[o + 1];
    rgb[i * 3 + 2] = img.data[o + 2];
  }
  const res = resampleInterleaved(rgb, img.width, img.height, 3, width, height);
  const out = createRGBA(width, height);
  for (let i = 0, m = width * height; i < m; i++) {
    out.data[i * 4] = res[i * 3] + 0.5;
    out.data[i * 4 + 1] = res[i * 3 + 1] + 0.5;
    out.data[i * 4 + 2] = res[i * 3 + 2] + 0.5;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

export function resizeGray(img: GrayImage, width: number, height: number): GrayImage {
  if (width === img.width && height === img.height) {
    return { width, height, data: new Uint8Array(img.data) };
  }
  const res = resampleInterleaved(img.data, img.width, img.height, 1, width, height);
  const out = createGray(width, height);
  for (let i = 0; i < res.length; i++) out.data[i] = Math.min(255, Math.max(0, Math.round(res[i])));
  return out;
}

export function resizeFloat(img: FloatImage, width: number, height: number): FloatImage {
  if (width === img.width && height === img.height) {
    return { width, height, data: new Float32Array(img.data) };
  }
  return { width, height, data: resampleInterleaved(img.data, img.width, img.height, 1, width, height) };
}

/** Rec. 709 luma of gamma-encoded RGB, the weights v1 used for every grey measurement. */
export function toGray(img: RGBAImage): GrayImage {
  const out = createGray(img.width, img.height);
  const d = img.data;
  for (let i = 0, o = 0, n = img.width * img.height; i < n; i++, o += 4) {
    out.data[i] = LUMA_R * d[o] + LUMA_G * d[o + 1] + LUMA_B * d[o + 2] + 0.5;
  }
  return out;
}

/** Grey bytes as floats on 0...1. */
export function grayToFloat(img: GrayImage): FloatImage {
  const out = createFloat(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] / 255;
  return out;
}

/**
 * Enlarge with a separable Catmull-Rom (Keys, a = -0.5) kernel, edge-clamped.
 *
 * For upsampling only (use resizeFloat to shrink: cubic sampling aliases when reducing). Used to
 * render soft, low-resolution captures at a print-like resolution *before* thresholding, so
 * glyph edges come out smooth rather than as staircases of the source's coarse pixels.
 */
export function upscaleFloatCubic(img: FloatImage, width: number, height: number): FloatImage {
  const { width: sw, height: sh, data: src } = img;
  const taps = (dst: number, n: number) => {
    const idx = new Int32Array(dst * 4);
    const wts = new Float32Array(dst * 4);
    for (let o = 0; o < dst; o++) {
      const s = ((o + 0.5) * n) / dst - 0.5;
      const i0 = Math.floor(s);
      const t = s - i0;
      const w = [((-0.5 * t + 1.0) * t - 0.5) * t, (1.5 * t - 2.5) * t * t + 1, ((-1.5 * t + 2.0) * t + 0.5) * t, (0.5 * t - 0.5) * t * t];
      for (let k = 0; k < 4; k++) {
        const i = i0 - 1 + k;
        idx[o * 4 + k] = i < 0 ? 0 : i >= n ? n - 1 : i;
        wts[o * 4 + k] = w[k];
      }
    }
    return { idx, wts };
  };
  const hx = taps(width, sw);
  const vy = taps(height, sh);
  const mid = new Float32Array(width * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    const out = y * width;
    for (let x = 0; x < width; x++) {
      const b = x * 4;
      mid[out + x] =
        src[row + hx.idx[b]] * hx.wts[b] +
        src[row + hx.idx[b + 1]] * hx.wts[b + 1] +
        src[row + hx.idx[b + 2]] * hx.wts[b + 2] +
        src[row + hx.idx[b + 3]] * hx.wts[b + 3];
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const b = y * 4;
    const r0 = vy.idx[b] * width;
    const r1 = vy.idx[b + 1] * width;
    const r2 = vy.idx[b + 2] * width;
    const r3 = vy.idx[b + 3] * width;
    const w0 = vy.wts[b];
    const w1 = vy.wts[b + 1];
    const w2 = vy.wts[b + 2];
    const w3 = vy.wts[b + 3];
    const row = y * width;
    for (let x = 0; x < width; x++) out[row + x] = mid[r0 + x] * w0 + mid[r1 + x] * w1 + mid[r2 + x] * w2 + mid[r3 + x] * w3;
  }
  return { width, height, data: out };
}
