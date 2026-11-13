// Finds the page in a camera frame: the job VisionKit's rectangle detector did in v1.
//
// Pipeline, all on a small grey frame (~480 px long edge):
//
//  1. Morphological closing (max then min filter). Text, ruled lines and table borders are
//     thin dark marks on light paper, and closing deletes every dark feature thinner than the
//     kernel. What survives is the paper as one flat bright region, so its outline is the
//     dominant edge instead of being lost among thousands of glyph edges.
//  2. Gaussian blur, Sobel gradients, non-maximum suppression and hysteresis (Canny), with
//     thresholds taken from the frame's own gradient distribution.
//  3. A gradient-guided Hough transform: each edge pixel votes only for orientations close to
//     its own gradient direction, which keeps the accumulator clean and fast.
//  4. Peak lines are refined by a least-squares fit to the edge pixels that voted for them,
//     then profiled: at every pixel along each line we record whether the image steps from
//     bright to dark across it, and keep prefix sums so any segment's support is O(1).
//  5. Every pair of roughly-parallel lines combined with every other such pair makes a
//     candidate quad (the image border counts as a line, for pages that run off the frame).
//     A quad scores by how well all four sides are supported with a consistent polarity
//     (inside brighter than outside), weighted gently toward larger area.
//  6. The winner's sides are re-fitted to sub-pixel edge positions and re-intersected.

import { isConvex, orderQuad, quadArea } from './geometry';
import type { GrayImage, Point, Quad } from './raster';

export interface Detection {
  /** Page corners in the input image's pixel space, ordered TL, TR, BR, BL. */
  quad: Quad;
  /** 0...1: the geometric-mean edge support of the four sides. */
  confidence: number;
}

/**
 * Intermediate results of one detection, for the test tools in test/core/detect-helpers.
 * Nothing in the app installs a trace; with none installed the detector does no extra work.
 */
export interface DetectTrace {
  width: number;
  height: number;
  smooth?: Float32Array;
  edges?: Uint8Array;
  lines?: { theta: number; rho: number; votes: number; border: boolean }[];
  /** All candidate quads, best score first, with per-side support (border sides flagged). */
  candidates?: { corners: Point[]; score: number; support: number; sides: { border: boolean; support: number }[] }[];
}
let traceSink: ((t: DetectTrace) => void) | null = null;
let trace: DetectTrace | null = null;
/** Install (or with null, remove) a trace receiver. Test tooling only. */
export function setDetectTrace(fn: ((t: DetectTrace) => void) | null): void {
  traceSink = fn;
}

/** Working size. Larger inputs are area-averaged down to this long edge first. */
const WORK_EDGE = 480;
/** Below this support the frame has no convincing page; the caller falls back to full frame... */
const MIN_CONFIDENCE = 0.55;
/** ...unless the winner is weaker but unambiguous: this much support, and this margin over */
const MIN_CONFIDENCE_CLEAR = 0.42;
/** the best substantially different candidate. */
const CLEAR_MARGIN = 1.3;

/**
 * Detect a document in a grey frame. Returns null when nothing is convincing.
 * Coordinates are continuous pixel coordinates: the image spans [0, width] x [0, height].
 */
export function detectDocument(gray: GrayImage): Detection | null {
  const long = Math.max(gray.width, gray.height);
  let work = gray;
  if (long > 512) {
    const s = WORK_EDGE / long;
    work = downscaleGray(gray, Math.max(8, Math.round(gray.width * s)), Math.max(8, Math.round(gray.height * s)));
  }
  const found = detectAtWorkingSize(work);
  if (!found) return null;
  if (work === gray) return found;
  const sx = gray.width / work.width;
  const sy = gray.height / work.height;
  return {
    quad: found.quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad,
    confidence: found.confidence,
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

interface Line {
  /** Unit normal n = (cos θ, sin θ); the line is n·(p − c) = rho, c = image centre. */
  nx: number;
  ny: number;
  rho: number;
  /** Direction along the line, d = (−sin θ, cos θ). */
  dx: number;
  dy: number;
  /** Parameter range of the line inside the image, and its profile prefix sums. */
  t0: number;
  /** Prefix counts of "brighter on the +n side" and "brighter on the −n side" samples. */
  pos: Float32Array | null;
  neg: Float32Array | null;
  /** Raw signed steps along the line (NaN = unmeasurable), kept until weights are known. */
  steps: Float32Array | null;
  border: boolean;
  votes: number;
}

interface Side {
  line: Line;
  a: Point;
  b: Point;
  /** Support this side scored (filled in by scoreQuad, read by the trace). */
  sup?: number;
}

interface Candidate {
  sides: Side[];
  corners: Point[];
  score: number;
  support: number;
}

function detectAtWorkingSize(img: GrayImage): Detection | null {
  trace = traceSink ? { width: img.width, height: img.height } : null;
  try {
    return detectCore(img);
  } finally {
    if (trace && traceSink) traceSink(trace);
    trace = null;
  }
}

function detectCore(img: GrayImage): Detection | null {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const L = Math.max(w, h);
  const cx = w / 2;
  const cy = h / 2;

  // 1. Closing, then blur.
  const radius = Math.max(2, Math.round(L / 110));
  let f: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = img.data[i];
  f = rankFilter(f, w, h, radius, true);
  f = rankFilter(f, w, h, radius, false);
  // A small opening removes bright specks (speckled laminate, glare dots) that the closing
  // leaves behind; 3x3 is too small to touch a real page margin.
  f = rankFilter(f, w, h, 1, false);
  f = rankFilter(f, w, h, 1, true);
  const s = gaussianBlur(f, w, h, 1.4);

  // 2. Gradients and Canny.
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = s[i - w - 1], b = s[i - w], c = s[i - w + 1];
      const d = s[i - 1], e = s[i + 1];
      const f2 = s[i + w - 1], g = s[i + w], hh = s[i + w + 1];
      const vx = c + 2 * e + hh - a - 2 * d - f2;
      const vy = f2 + 2 * g + hh - a - 2 * b - c;
      gx[i] = vx;
      gy[i] = vy;
      mag[i] = Math.sqrt(vx * vx + vy * vy);
    }
  }
  // Thresholds relative to the frame's own gradient distribution, kept low on purpose:
  // a white page on a white desk can be a 10-level step. The Hough stage and the side
  // profiles are what reject noise, not Canny.
  const p93 = percentile(mag, 0.93);
  const high = Math.max(10, 0.55 * p93);
  const low = Math.max(5, 0.45 * high);
  const edges = canny(mag, gx, gy, w, h, low, high);
  if (trace) {
    trace.smooth = s;
    trace.edges = edges;
  }

  // 3. Hough.
  const ex: number[] = [];
  const ey: number[] = [];
  const ea: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!edges[i]) continue;
    ex.push((i % w) + 0.5);
    ey.push(((i / w) | 0) + 0.5);
    ea.push(Math.atan2(gy[i], gx[i]));
  }
  if (ex.length < 20) return null;
  const lines = houghLines(ex, ey, ea, w, h);

  // 4. Refine and profile.
  const tau = Math.max(2.5, p93 / 7);
  for (const line of lines) refineLine(line, ex, ey, ea, cx, cy, 2.5);
  const unique = dedupeLines(lines, L);
  for (const line of unique) profileLine(line, s, w, h, cx, cy, radius + 2);
  const full = fullStrength(unique, tau);
  for (const line of unique) weighLine(line, tau, full);

  // Image borders as pseudo-lines (rho measured from the centre).
  const borders: Line[] = [
    makeLine(Math.PI / 2, -cy, true), // top    y = 0
    makeLine(Math.PI / 2, h - cy, true), // bottom y = h
    makeLine(0, -cx, true), // left   x = 0
    makeLine(0, w - cx, true), // right  x = w
  ];
  const all = [...unique, ...borders];

  // 5. Candidates.
  const found = bestQuad(all, s, w, h, cx, cy, L);
  if (!found) return null;
  const best = found.best;
  const clear = best.support >= MIN_CONFIDENCE_CLEAR && best.score >= CLEAR_MARGIN * found.runnerUp;
  if (best.support < MIN_CONFIDENCE && !clear) return null;

  // 6. Sub-pixel side refinement.
  const refined = refineQuad(best, s, w, h, cx, cy, full);
  const corners = refined ?? best.corners;
  const clamped = corners.map((p) => ({
    x: Math.min(w, Math.max(0, p.x)),
    y: Math.min(h, Math.max(0, p.y)),
  }));
  const quad = orderQuad(clamped);
  if (!isConvex(quad) || quadArea(quad) < 0.03 * w * h) return null;
  return { quad, confidence: Math.min(1, best.support) };
}

function makeLine(theta: number, rho: number, border = false, votes = 0): Line {
  const nx = Math.cos(theta);
  const ny = Math.sin(theta);
  return { nx, ny, rho, dx: -ny, dy: nx, t0: 0, pos: null, neg: null, steps: null, border, votes };
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** Separable square max (dilate) or min (erode) filter. */
function rankFilter(src: Float32Array, w: number, h: number, r: number, isMax: boolean): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const lo = x - r < 0 ? 0 : x - r;
      const hi = x + r >= w ? w - 1 : x + r;
      let v = src[row + lo];
      for (let k = lo + 1; k <= hi; k++) {
        const u = src[row + k];
        if (isMax ? u > v : u < v) v = u;
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const lo = y - r < 0 ? 0 : y - r;
      const hi = y + r >= h ? h - 1 : y + r;
      let v = tmp[lo * w + x];
      for (let k = lo + 1; k <= hi; k++) {
        const u = tmp[k * w + x];
        if (isMax ? u > v : u < v) v = u;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 2.5);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += src[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  // Histogram percentile: magnitudes are bounded (Sobel on 0...255 tops out near 1450).
  const bins = 2048;
  const maxV = 1500;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, (values[i] / maxV) * bins) | 0;
    hist[b]++;
  }
  const target = p * values.length;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) return ((b + 0.5) / bins) * maxV;
  }
  return maxV;
}

/** Non-maximum suppression plus hysteresis. Returns a 0/1 edge map. */
function canny(
  mag: Float32Array,
  gx: Float32Array,
  gy: Float32Array,
  w: number,
  h: number,
  low: number,
  high: number,
): Uint8Array {
  const n = w * h;
  const state = new Uint8Array(n); // 0 none, 1 weak, 2 strong
  const stack: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < low) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let m1: number;
      let m2: number;
      if (ay <= ax * 0.4142) {
        m1 = mag[i - 1];
        m2 = mag[i + 1];
      } else if (ay >= ax * 2.4142) {
        m1 = mag[i - w];
        m2 = mag[i + w];
      } else if (gx[i] * gy[i] > 0) {
        m1 = mag[i - w - 1];
        m2 = mag[i + w + 1];
      } else {
        m1 = mag[i - w + 1];
        m2 = mag[i + w - 1];
      }
      if (m < m1 || m <= m2) continue;
      if (m >= high) {
        state[i] = 2;
        stack.push(i);
      } else {
        state[i] = 1;
      }
    }
  }
  const out = new Uint8Array(n);
  while (stack.length) {
    const i = stack.pop()!;
    if (out[i]) continue;
    out[i] = 1;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (state[j] && !out[j]) stack.push(j);
      }
    }
  }
  return out;
}

// ── Hough ────────────────────────────────────────────────────────────────────

const THETA_BINS = 360; // 0.5° each over [0, π)
const VOTE_SPREAD = 8; // ±4° around each pixel's own gradient direction
const COS = new Float64Array(THETA_BINS);
const SIN = new Float64Array(THETA_BINS);
for (let t = 0; t < THETA_BINS; t++) {
  COS[t] = Math.cos((t * Math.PI) / THETA_BINS);
  SIN[t] = Math.sin((t * Math.PI) / THETA_BINS);
}

function houghLines(ex: number[], ey: number[], ea: number[], w: number, h: number): Line[] {
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.ceil(Math.hypot(w, h) / 2) + 2;
  const R = 2 * half + 1;
  const raw = new Float32Array(THETA_BINS * R);
  for (let k = 0; k < ex.length; k++) {
    const x = ex[k] - cx;
    const y = ey[k] - cy;
    let a = ea[k];
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    const t0 = Math.round((a / Math.PI) * THETA_BINS);
    for (let dt = -VOTE_SPREAD; dt <= VOTE_SPREAD; dt++) {
      // Wrapping past 0 or π lands on the same family of lines with the normal reversed;
      // ρ is simply recomputed for the wrapped angle.
      let t = t0 + dt;
      if (t < 0) t += THETA_BINS;
      else if (t >= THETA_BINS) t -= THETA_BINS;
      // Split the vote between the two nearest ρ cells: pixel-grid jitter would otherwise
      // scatter a straight edge across neighbouring cells and halve its peak.
      const rf = x * COS[t] + y * SIN[t] + half;
      const r0 = Math.floor(rf);
      const fr = rf - r0;
      if (r0 >= 0 && r0 + 1 < R) {
        raw[t * R + r0] += 1 - fr;
        raw[t * R + r0 + 1] += fr;
      }
    }
  }
  // 3x3 box smoothing (θ ±0.5°, ρ ±1 px), θ wrapping with ρ mirrored.
  const acc = new Float32Array(THETA_BINS * R);
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 1; r < R - 1; r++) {
      let sum = 0;
      for (let dt = -1; dt <= 1; dt++) {
        let tt = t + dt;
        let rr = r;
        if (tt < 0) {
          tt += THETA_BINS;
          rr = 2 * half - r;
        } else if (tt >= THETA_BINS) {
          tt -= THETA_BINS;
          rr = 2 * half - r;
        }
        if (rr < 1 || rr >= R - 1) continue;
        const base = tt * R + rr;
        sum += raw[base - 1] + raw[base] + raw[base + 1];
      }
      acc[t * R + r] = sum / 3; // ≈ line length in pixels
    }
  }

  const L = Math.max(w, h);
  const minVotes = Math.max(18, 0.07 * L);
  const peaks: { t: number; r: number; v: number }[] = [];
  const NT = 5; // ±2.5°
  const NR = 4;
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 0; r < R; r++) {
      const v = acc[t * R + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -NT; dt <= NT && isMax; dt++) {
        let tt = t + dt;
        let rr0 = r;
        if (tt < 0) {
          tt += THETA_BINS;
          rr0 = 2 * half - r;
        } else if (tt >= THETA_BINS) {
          tt -= THETA_BINS;
          rr0 = 2 * half - r;
        }
        for (let dr = -NR; dr <= NR; dr++) {
          const rr = rr0 + dr;
          if (rr < 0 || rr >= R || (dt === 0 && dr === 0)) continue;
          const u = acc[tt * R + rr];
          // Strict on one side so plateaus still yield exactly one peak.
          if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ t, r, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, 40).map((p) => makeLine((p.t * Math.PI) / THETA_BINS, p.r - half, false, Math.round(p.v)));
}

/** Least-squares refit of a Hough line to the edge pixels lying on it. */
function refineLine(line: Line, ex: number[], ey: number[], ea: number[], cx: number, cy: number, band: number): void {
  for (let iter = 0; iter < 2; iter++) {
    let sx = 0, sy = 0, cnt = 0;
    const px: number[] = [];
    const py: number[] = [];
    for (let k = 0; k < ex.length; k++) {
      const x = ex[k] - cx;
      const y = ey[k] - cy;
      const d = x * line.nx + y * line.ny - line.rho;
      if (Math.abs(d) > band) continue;
      // Gradient must be (anti)parallel to the line normal.
      const c = Math.abs(Math.cos(ea[k]) * line.nx + Math.sin(ea[k]) * line.ny);
      if (c < 0.97) continue;
      px.push(x);
      py.push(y);
      sx += x;
      sy += y;
      cnt++;
    }
    if (cnt < 12) return;
    const mx = sx / cnt;
    const my = sy / cnt;
    let sxx = 0, sxy = 0, syy = 0;
    for (let k = 0; k < cnt; k++) {
      const dx = px[k] - mx;
      const dy = py[k] - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    // Normal = eigenvector of the smaller eigenvalue of the scatter matrix.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the larger one
    let nx = -Math.sin(theta);
    let ny = Math.cos(theta);
    if (nx * line.nx + ny * line.ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    line.nx = nx;
    line.ny = ny;
    line.dx = -ny;
    line.dy = nx;
    line.rho = mx * nx + my * ny;
    band = 1.75;
  }
}

function dedupeLines(lines: Line[], L: number): Line[] {
  const out: Line[] = [];
  const tol = Math.max(2.5, 0.006 * L);
  for (const l of lines) {
    let dup = false;
    for (const o of out) {
      const c = l.nx * o.nx + l.ny * o.ny;
      if (Math.abs(c) < Math.cos((1.5 * Math.PI) / 180)) continue;
      const r = c > 0 ? o.rho : -o.rho;
      if (Math.abs(l.rho - r) < tol) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(l);
    if (out.length >= 28) break;
  }
  return out;
}

// ── Line profiles ────────────────────────────────────────────────────────────

/** Bilinear sample of a float image at continuous coordinates (pixel centres at i + 0.5). */
function sampleAt(img: Float32Array, w: number, h: number, X: number, Y: number): number {
  let x = X - 0.5;
  let y = Y - 0.5;
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  const a = img[y0 * w + x0];
  const b = img[y0 * w + x1];
  const c = img[y1 * w + x0];
  const d = img[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

const STEP_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
const STEP_HALF = 2;

/**
 * Signed brightness step across the line at point (X, Y): S(+n side) − S(−n side).
 * NaN when the point is too close to the frame edge to measure at all.
 */
function stepAcross(s: Float32Array, w: number, h: number, X: number, Y: number, nx: number, ny: number): number {
  let best = 0;
  let bestO = 0;
  let measured = false;
  for (const o of STEP_OFFSETS) {
    const ax = X + (o + STEP_HALF) * nx;
    const ay = Y + (o + STEP_HALF) * ny;
    const bx = X + (o - STEP_HALF) * nx;
    const by = Y + (o - STEP_HALF) * ny;
    if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax > w || ay > h || bx > w || by > h) continue;
    const v = sampleAt(s, w, h, ax, ay) - sampleAt(s, w, h, bx, by);
    measured = true;
    if (Math.abs(v) > Math.abs(best)) {
      best = v;
      bestO = o;
    }
  }
  if (!measured) return NaN;
  // Sharpness: an edge concentrates its brightness change within a few pixels, so the
  // 4 px step is most of the 12 px one. A soft shadow or a smooth tonal ramp keeps climbing
  // and fails this, however long and straight it is.
  const ax = X + (bestO + 6) * nx;
  const ay = Y + (bestO + 6) * ny;
  const bx = X + (bestO - 6) * nx;
  const by = Y + (bestO - 6) * ny;
  if (ax >= 0 && ay >= 0 && bx >= 0 && by >= 0 && ax <= w && ay <= h && bx <= w && by <= h) {
    const wide = sampleAt(s, w, h, ax, ay) - sampleAt(s, w, h, bx, by);
    if (Math.abs(best) < 0.5 * Math.abs(wide)) return 0;
  }
  return best;
}

function profileLine(line: Line, s: Float32Array, w: number, h: number, cx: number, cy: number, near: number): void {
  // Clip the infinite line to the image rectangle: p(t) = c + rho·n + t·d.
  const px = cx + line.rho * line.nx;
  const py = cy + line.rho * line.ny;
  let tmin = -Infinity;
  let tmax = Infinity;
  const clip = (p: number, d: number, lo: number, hi: number): void => {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) {
        tmin = Infinity;
        tmax = -Infinity;
      }
      return;
    }
    let a = (lo - p) / d;
    let b = (hi - p) / d;
    if (a > b) [a, b] = [b, a];
    tmin = Math.max(tmin, a);
    tmax = Math.min(tmax, b);
  };
  clip(px, line.dx, 0, w);
  clip(py, line.dy, 0, h);
  if (!(tmax > tmin)) {
    line.t0 = 0;
    line.steps = new Float32Array(0);
    return;
  }
  const t0 = Math.ceil(tmin);
  const count = Math.max(0, Math.floor(tmax) - t0 + 1);
  const steps = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const t = t0 + k;
    const X = px + t * line.dx;
    const Y = py + t * line.dy;
    // Within reach of the closing of the frame edge, a thin sliver of background between
    // the page and the border may have been filled in: no evidence either way.
    if (X < near || Y < near || X > w - near || Y > h - near) steps[k] = NaN;
    else steps[k] = stepAcross(s, w, h, X, Y, line.nx, line.ny);
  }
  line.t0 = t0;
  line.steps = steps;
}

/**
 * Turn raw steps into support prefix sums. Each sample of the right sign counts in proportion
 * to its strength relative to `full` (capped at 1), so the boundary between a page and what
 * it lies on outweighs wood grain, a fold's shading or a printed rule, which are all real
 * straight edges but much weaker ones.
 */
function weighLine(line: Line, tau: number, full: number): void {
  const steps = line.steps!;
  const n = steps.length;
  const pos = new Float32Array(n + 1);
  const neg = new Float32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const v = steps[k];
    let p = 0;
    let q = 0;
    if (Number.isNaN(v)) {
      // Unmeasurable (hugging the frame edge): neither evidence for nor against.
      p = q = 0.7;
    } else if (v > tau) {
      p = Math.sqrt(Math.min(1, v / full));
    } else if (v < -tau) {
      q = Math.sqrt(Math.min(1, -v / full));
    }
    pos[k + 1] = pos[k] + p;
    neg[k + 1] = neg[k] + q;
  }
  line.pos = pos;
  line.neg = neg;
}

/** Step strength that counts as full support: a fraction of the frame's strongest line steps. */
function fullStrength(lines: Line[], tau: number): number {
  const all: number[] = [];
  for (const l of lines) {
    const st = l.steps;
    if (!st) continue;
    for (let k = 0; k < st.length; k += 2) {
      const v = Math.abs(st[k]);
      if (v > tau) all.push(v);
    }
  }
  if (!all.length) return tau * 2;
  all.sort((a, b) => a - b);
  return Math.max(tau * 1.5, 0.5 * all[Math.floor(all.length * 0.9)]);
}

// ── Candidate quads ──────────────────────────────────────────────────────────

function angleBetween(a: Line, b: Line): number {
  // Angle between the two lines' directions, folded into [0, π/2].
  const c = Math.abs(a.nx * b.nx + a.ny * b.ny);
  return Math.acos(Math.min(1, c));
}

function intersect(a: Line, b: Line, cx: number, cy: number): Point | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  const x = (a.rho * b.ny - b.rho * a.ny) / det;
  const y = (a.nx * b.rho - b.nx * a.rho) / det;
  return { x: x + cx, y: y + cy };
}

function lineParam(line: Line, p: Point, cx: number, cy: number): number {
  return (p.x - cx) * line.dx + (p.y - cy) * line.dy;
}

const DEG = Math.PI / 180;

function bestQuad(
  lines: Line[],
  s: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  L: number,
): { best: Candidate; runnerUp: number } | null {
  const minSep = 0.1 * Math.min(w, h);
  // Opposite-side pairs: roughly parallel (perspective allows up to ~35° of convergence),
  // well separated.
  const pairs: [Line, Line][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (angleBetween(a, b) > 35 * DEG) continue;
      const c = a.nx * b.nx + a.ny * b.ny;
      const rb = c > 0 ? b.rho : -b.rho;
      if (Math.abs(a.rho - rb) < minSep) continue;
      pairs.push([a, b]);
    }
  }

  const area = w * h;
  const margin = 0.02 * L;
  let best: Candidate | null = null;
  const pool: Candidate[] = [];
  const contenders: Candidate[] = [];

  for (let p = 0; p < pairs.length; p++) {
    const [a1, a2] = pairs[p];
    for (let q = p + 1; q < pairs.length; q++) {
      const [b1, b2] = pairs[q];
      if (b1 === a1 || b1 === a2 || b2 === a1 || b2 === a2) continue;
      if (
        angleBetween(a1, b1) < 40 * DEG ||
        angleBetween(a1, b2) < 40 * DEG ||
        angleBetween(a2, b1) < 40 * DEG ||
        angleBetween(a2, b2) < 40 * DEG
      )
        continue;
      const borderCount = +a1.border + +a2.border + +b1.border + +b2.border;
      if (borderCount > 2) continue;

      const c11 = intersect(a1, b1, cx, cy);
      const c12 = intersect(a1, b2, cx, cy);
      const c22 = intersect(a2, b2, cx, cy);
      const c21 = intersect(a2, b1, cx, cy);
      if (!c11 || !c12 || !c22 || !c21) continue;
      const corners = [c11, c12, c22, c21];
      let inside = true;
      for (const c of corners) {
        if (c.x < -margin || c.y < -margin || c.x > w + margin || c.y > h + margin) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
      const sides: Side[] = [
        { line: a1, a: c11, b: c12 },
        { line: b2, a: c12, b: c22 },
        { line: a2, a: c22, b: c21 },
        { line: b1, a: c21, b: c11 },
      ];
      const cand = scoreQuad(sides, corners, s, w, h, cx, cy, area);
      if (!cand) continue;
      if (!best || cand.score > best.score) best = cand;
      contenders.push(cand);
      if (trace) pool.push(cand);
    }
  }
  if (trace) {
    pool.sort((a, b) => b.score - a.score);
    trace.lines = lines.map((l) => ({ theta: (Math.atan2(l.ny, l.nx) * 180) / Math.PI, rho: l.rho, votes: l.votes, border: l.border }));
    trace.candidates = pool.map((c) => ({
      corners: c.corners,
      score: c.score,
      support: c.support,
      sides: c.sides.map((sd) => ({ border: sd.line.border, support: sd.sup ?? 0 })),
    }));
  }
  if (!best) return null;
  // Strongest candidate that is a genuinely different answer (some corner > 5% away).
  let runnerUp = 0;
  for (const c of contenders) {
    if (c === best || c.score <= runnerUp) continue;
    let far = 0;
    for (const p of best.corners) {
      let near = Infinity;
      for (const q of c.corners) near = Math.min(near, Math.hypot(p.x - q.x, p.y - q.y));
      far = Math.max(far, near);
    }
    if (far > 0.05 * L) runnerUp = c.score;
  }
  return { best, runnerUp };
}

function scoreQuad(
  sides: Side[],
  corners: Point[],
  s: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  imageArea: number,
): Candidate | null {
  // Convexity (either winding) and size.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z === 0) return null;
    const sg = z > 0 ? 1 : -1;
    if (sign === 0) sign = sg;
    else if (sg !== sign) return null;
  }
  let ar = 0;
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const nn = corners[(i + 1) % 4];
    ar += p.x * nn.y - nn.x * p.y;
  }
  const areaFrac = Math.abs(ar) / 2 / imageArea;
  if (areaFrac < 0.04) return null;

  const minSide = 0.1 * Math.min(w, h);
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 3) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < minSide) return null;
    // Interior angle at a.
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - a.x, v2y = c.y - a.y;
    const cosA = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
    if (cosA > Math.cos(35 * DEG) || cosA < Math.cos(145 * DEG)) return null;
  }

  const mx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const my = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

  // Bright-inside / dark-inside support of a real side over the part of it from u0 to u1
  // (0 = its start corner, 1 = its end corner).
  const segSupport = (side: Side, u0: number, u1: number): [number, number] => {
    const line = side.line;
    let ta = lineParam(line, side.a, cx, cy);
    let tb = lineParam(line, side.b, cx, cy);
    const a = ta + (tb - ta) * u0;
    const b = ta + (tb - ta) * u1;
    ta = Math.min(a, b);
    tb = Math.max(a, b);
    const pos = line.pos!;
    const neg = line.neg!;
    const last = pos.length - 1;
    const ia = Math.max(0, Math.min(last, Math.round(ta) - line.t0));
    const ib = Math.max(0, Math.min(last, Math.round(tb) - line.t0));
    const len = Math.max(1, Math.round(tb - ta));
    const np = (pos[ib] - pos[ia]) / len;
    const nn = (neg[ib] - neg[ia]) / len;
    const interiorPlus = (mx - cx) * line.nx + (my - cy) * line.ny - line.rho > 0;
    return interiorPlus ? [np, nn] : [nn, np];
  };

  let logBright = 0;
  let logDark = 0;
  let borderSides = 0;
  for (let si = 0; si < 4; si++) {
    const side = sides[si];
    const line = side.line;
    if (line.border) {
      borderSides++;
      let support = borderSupport(side, sides, s, w, h, mx, my);
      // A page that really runs off the frame keeps its adjacent sides' edges right up to
      // the border. A border grabbed for want of a real edge doesn't: the neighbouring edge
      // stops short at the page's true corner.
      const ends: number[] = [];
      const prev = sides[(si + 3) % 4]; // ends at this border side's start
      const next = sides[(si + 1) % 4]; // starts at this border side's end
      if (!prev.line.border) ends.push(segSupport(prev, 0.85, 0.98)[0]);
      if (!next.line.border) ends.push(segSupport(next, 0.02, 0.15)[0]);
      if (ends.length) {
        const e = ends.reduce((x, y) => x + y, 0) / ends.length;
        support = 0.1 + (support - 0.1) * Math.max(0, Math.min(1, (e - 0.2) / 0.45));
      }
      side.sup = support;
      logBright += Math.log(Math.max(0.02, support));
      logDark += Math.log(0.02);
      continue;
    }
    // Support over the whole side (trimmed at the corners, which are often rounded or
    // occluded), and over its weakest third: a side that overshoots its real corner
    // (extended to some farther line) is well supported for most of its length but has a
    // dead third, and that is what gives it away.
    const all = segSupport(side, 0.06, 0.94);
    const thirds = [segSupport(side, 0.06, 0.353), segSupport(side, 0.353, 0.647), segSupport(side, 0.647, 0.94)];
    const minB = Math.min(...thirds.map((t) => t[0]));
    const minD = Math.min(...thirds.map((t) => t[1]));
    const bright = 0.5 * all[0] + 0.5 * minB;
    const dark = 0.5 * all[1] + 0.5 * minD;
    side.sup = bright;
    logBright += Math.log(Math.max(0.02, bright));
    logDark += Math.log(Math.max(0.02, dark));
  }
  const gB = Math.exp(logBright / 4);
  // Paper is nearly always lighter than what it lies on; a darker-inside quad is usually a
  // shaded box or photo printed on the page, so it has to be clearly better to win.
  const gD = Math.exp(logDark / 4) * 0.6;
  const support = Math.max(gB, gD);
  let score = support * Math.pow(areaFrac, 0.3);
  if (borderSides === 2) score *= 0.97;
  return { sides, corners, score, support };
}

/**
 * Plausibility of an image-border side. If the page really runs off the frame here, the strip
 * just inside the border looks like the page; if the quad has merely grabbed the border for
 * lack of a real edge, the strip looks like background. "Page" and "background" are sampled
 * right where it matters: just inside and just outside the adjacent real sides, near the
 * ends where they meet this border. When the two can't be told apart by brightness there is
 * no evidence either way and the side gets a low, neutral score.
 */
function inwardOf(sd: Side, mx: number, my: number): { ix: number; iy: number; ul: number } {
  const ux = mx - (sd.a.x + sd.b.x) / 2;
  const uy = my - (sd.a.y + sd.b.y) / 2;
  const ul = Math.hypot(ux, uy) || 1;
  return { ix: ux / ul, iy: uy / ul, ul };
}

/**
 * Brightness of "page" and "background" near a border side: just inside and just outside the
 * adjacent real sides, close to where they meet the border. Falls back to the quad interior
 * versus outside all its real sides when no adjacent side is real.
 */
function pageAndBackground(
  side: Side,
  sides: Side[],
  s: Float32Array,
  w: number,
  h: number,
  mx: number,
  my: number,
): { page: number; back: number } | null {
  const N = 24;
  let page = 0;
  let back = 0;
  let count = 0;
  for (const sd of sides) {
    if (sd === side || sd.line.border) continue;
    const touches = sd.a === side.a || sd.b === side.a || sd.a === side.b || sd.b === side.b;
    if (!touches) continue;
    const shared = sd.a === side.a || sd.a === side.b ? sd.a : sd.b;
    const other = shared === sd.a ? sd.b : sd.a;
    const o = inwardOf(sd, mx, my);
    for (let k = 0; k < 8; k++) {
      const t = 0.75 + (0.2 * (k + 0.5)) / 8; // from `other` (0) toward `shared` (1)
      const x = other.x + (shared.x - other.x) * t;
      const y = other.y + (shared.y - other.y) * t;
      const ox = x - 6 * o.ix;
      const oy = y - 6 * o.iy;
      if (ox < 0 || oy < 0 || ox > w || oy > h) continue;
      page += sampleAt(s, w, h, x + 6 * o.ix, y + 6 * o.iy);
      back += sampleAt(s, w, h, ox, oy);
      count++;
    }
  }
  if (count >= 4) return { page: page / count, back: back / count };

  const me = inwardOf(side, mx, my);
  let inner = 0;
  for (let k = 0; k < N; k++) {
    const t = (k + 0.5) / N;
    inner += sampleAt(s, w, h, side.a.x + (side.b.x - side.a.x) * t + 0.25 * me.ul * me.ix, side.a.y + (side.b.y - side.a.y) * t + 0.25 * me.ul * me.iy);
  }
  back = 0;
  count = 0;
  for (const sd of sides) {
    if (sd.line.border) continue;
    const o = inwardOf(sd, mx, my);
    for (let k = 0; k < N; k++) {
      const t = 0.1 + (0.8 * (k + 0.5)) / N;
      const x = sd.a.x + (sd.b.x - sd.a.x) * t - 6 * o.ix;
      const y = sd.a.y + (sd.b.y - sd.a.y) * t - 6 * o.iy;
      if (x < 0 || y < 0 || x > w || y > h) continue;
      back += sampleAt(s, w, h, x, y);
      count++;
    }
  }
  if (!count) return null;
  return { page: inner / N, back: back / count };
}

/**
 * Plausibility of an image-border side. If the page really runs off the frame here, the strip
 * just inside the border looks like the page; if the quad has merely grabbed the border for
 * lack of a real edge, the strip looks like background. When the two can't be told apart by
 * brightness there is no evidence either way and the side gets a low, neutral score.
 */
function borderSupport(side: Side, sides: Side[], s: Float32Array, w: number, h: number, mx: number, my: number): number {
  const N = 24;
  const me = inwardOf(side, mx, my);
  let strip = 0;
  for (let k = 0; k < N; k++) {
    const t = (k + 0.5) / N;
    strip += sampleAt(s, w, h, side.a.x + (side.b.x - side.a.x) * t + 4 * me.ix, side.a.y + (side.b.y - side.a.y) * t + 4 * me.iy);
  }
  strip /= N;
  const ref = pageAndBackground(side, sides, s, w, h, mx, my);
  if (!ref) return 0.3;
  const gap = ref.page - ref.back;
  if (Math.abs(gap) < 6) return 0.3;
  const z = (strip - ref.back) / gap; // 1: like the page, 0: like the background
  return 0.1 + 0.45 * Math.max(0, Math.min(1, (z - 0.3) / 0.5));
}

// ── Final refinement ─────────────────────────────────────────────────────────

/** A sub-pixel edge point found while tracking a side, with its position along the side (0...1). */
interface TrackPoint {
  x: number;
  y: number;
  t: number;
}

/**
 * Follow one side's real edge from its middle out to both corners.
 *
 * Paper is rarely a perfect rectangle in a photo: it curls, and a letter folded in thirds has
 * a kink at every fold, so its outline is three slightly different lines. Tracking lets the
 * search window drift with the edge instead of insisting on the global line.
 */
function trackSide(side: Side, want: number, s: Float32Array, w: number, h: number): TrackPoint[] {
  const line = side.line;
  const len = Math.hypot(side.b.x - side.a.x, side.b.y - side.a.y);
  const steps = Math.max(8, Math.floor(len / 1.5));
  const out: TrackPoint[] = [];
  const strengths: number[] = [];
  const probe = (t: number, centre: number, reach: number): { o: number; v: number } => {
    const bx = side.a.x + (side.b.x - side.a.x) * t;
    const by = side.a.y + (side.b.y - side.a.y) * t;
    let bestO = centre;
    let bestV = 0;
    for (let o = centre - reach; o <= centre + reach + 1e-9; o += 0.5) {
      const v =
        want *
        (sampleAt(s, w, h, bx + (o + 1) * line.nx, by + (o + 1) * line.ny) -
          sampleAt(s, w, h, bx + (o - 1) * line.nx, by + (o - 1) * line.ny));
      if (v > bestV) {
        bestV = v;
        bestO = o;
      }
    }
    // Parabolic sub-pixel peak.
    const f = (o: number): number =>
      want *
      (sampleAt(s, w, h, bx + (o + 1) * line.nx, by + (o + 1) * line.ny) -
        sampleAt(s, w, h, bx + (o - 1) * line.nx, by + (o - 1) * line.ny));
    const y0 = f(bestO - 0.5);
    const y2 = f(bestO + 0.5);
    const d = y0 - 2 * bestV + y2;
    let o = bestO;
    if (d < 0) o += Math.max(-0.5, Math.min(0.5, (0.25 * (y0 - y2)) / d));
    return { o, v: bestV };
  };
  const half = Math.floor(steps / 2);
  for (const dir of [1, -1]) {
    let centre = 0;
    for (let k = dir === 1 ? 0 : 1; k <= half; k++) {
      const idx = half + dir * k;
      const t = 0.02 + (0.96 * (idx + 0.5)) / (steps + 1);
      if (t <= 0 || t >= 1) continue;
      const r = probe(t, centre, 2.5);
      if (r.v <= 2.5) continue;
      strengths.push(r.v);
      centre = r.o;
      const bx = side.a.x + (side.b.x - side.a.x) * t;
      const by = side.a.y + (side.b.y - side.a.y) * t;
      out.push({ x: bx + r.o * line.nx, y: by + r.o * line.ny, t });
    }
  }
  // Drop weak points (texture or a neighbouring edge) relative to this side's own contrast.
  if (strengths.length) {
    const sorted = [...strengths].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    return out.filter((_, i) => strengths[i] >= 0.35 * med);
  }
  return out;
}

/**
 * For a side that is the frame border: is there a real page edge running just inside it?
 * Shots framed tight leave a sliver of desk along one edge that the Hough stage can miss
 * (it is short, or partly erased by the closing where it is thinnest), and then the border
 * stands in for it. Scan inward from the border for a bright-inside step and fit a line.
 */
function edgeInsideBorder(
  side: Side,
  sides: Side[],
  s: Float32Array,
  w: number,
  h: number,
  mx: number,
  my: number,
  L: number,
  full: number,
): { line: Line | null; pts: TrackPoint[] } | null {
  const ux = mx - (side.a.x + side.b.x) / 2;
  const uy = my - (side.a.y + side.b.y) / 2;
  const ul = Math.hypot(ux, uy) || 1;
  // Inward normal of the border (axis-aligned).
  const horizontal = Math.abs(side.a.y - side.b.y) < Math.abs(side.a.x - side.b.x);
  const ix = horizontal ? 0 : Math.sign(ux);
  const iy = horizontal ? Math.sign(uy) : 0;
  if (ix === 0 && iy === 0) return null;
  void ul;
  const depth = 0.1 * L;
  const K = 40;
  // Without a clear page/background contrast nothing can be said about the band.
  const ref = pageAndBackground(side, sides, s, w, h, mx, my);
  if (!ref || ref.page - ref.back < 8) return null;
  const minStep = Math.max(4, 0.45 * full);
  const pts: TrackPoint[] = [];
  for (let k = 0; k < K; k++) {
    const t = 0.08 + (0.84 * (k + 0.5)) / K;
    const bx = side.a.x + (side.b.x - side.a.x) * t;
    const by = side.a.y + (side.b.y - side.a.y) * t;
    let bestD = -1;
    let bestV = 0;
    for (let d = 1.5; d <= depth; d += 0.5) {
      const v =
        sampleAt(s, w, h, bx + (d + 1) * ix, by + (d + 1) * iy) - sampleAt(s, w, h, bx + (d - 1) * ix, by + (d - 1) * iy);
      if (v > bestV) {
        bestV = v;
        bestD = d;
      }
    }
    if (bestD < 0 || bestV < minStep) continue;
    // The band between the border and this edge must look like background (clearly darker
    // than the page just inside the edge), or it is shading on a page that really does run
    // off the frame.
    const inside = sampleAt(s, w, h, bx + (bestD + 4) * ix, by + (bestD + 4) * iy);
    let band = 0;
    let nb = 0;
    for (let d = 0.5; d <= Math.max(0.5, bestD - 2); d += 1) {
      band += sampleAt(s, w, h, bx + d * ix, by + d * iy);
      nb++;
    }
    band /= nb;
    if (inside - band < minStep) continue;
    // ... and it must look like the background next to the page, not like more page.
    if (band - ref.back > 0.5 * (ref.page - ref.back)) continue;
    pts.push({ x: bx + bestD * ix, y: by + bestD * iy, t });
  }
  // Too few for a whole-side edge: keep them anyway, a corner may still be refined from the
  // ones near it (a page that leaves the frame part-way along this side).
  if (pts.length < 0.35 * K) return { line: null, pts };
  const cx = w / 2;
  const cy = h / 2;
  const init = makeLine(horizontal ? Math.PI / 2 : 0, horizontal ? side.a.y - cy : side.a.x - cx);
  const l = fitRobust(
    pts.map((p) => p.x - cx),
    pts.map((p) => p.y - cy),
    init,
  );
  if (!l) return { line: null, pts };
  // Must stay roughly parallel to the border and inside the frame.
  if (Math.abs(l.nx * init.nx + l.ny * init.ny) < Math.cos(12 * DEG)) return { line: null, pts };
  // Most of the points must agree with the fit, or this is scattered texture, not an edge.
  let agree = 0;
  for (const p of pts) if (Math.abs((p.x - cx) * l.nx + (p.y - cy) * l.ny - l.rho) < 2) agree++;
  if (agree < 0.3 * K) return { line: null, pts };
  return { line: { ...l, border: false }, pts };
}

/** Re-fit the sides to sub-pixel edge positions and recompute each corner from its own neighbourhood. */
function refineQuad(c: Candidate, s: Float32Array, w: number, h: number, cx: number, cy: number, full: number): Point[] | null {
  const mx = (c.corners[0].x + c.corners[1].x + c.corners[2].x + c.corners[3].x) / 4;
  const my = (c.corners[0].y + c.corners[1].y + c.corners[2].y + c.corners[3].y) / 4;
  const tracks: (TrackPoint[] | null)[] = [];
  const globals: Line[] = [];
  for (const side of c.sides) {
    const line = side.line;
    if (line.border) {
      // The page may not actually reach the frame edge: look for a real edge just inside it.
      const inner = edgeInsideBorder(side, c.sides, s, w, h, mx, my, Math.max(w, h), full);
      tracks.push(inner?.pts.length ? inner.pts : null);
      globals.push(inner?.line ?? line);
      continue;
    }
    const interiorPlus = (mx - cx) * line.nx + (my - cy) * line.ny - line.rho > 0;
    const want = interiorPlus ? 1 : -1; // expected sign of S(+n) − S(−n) for a bright inside
    const pts = trackSide(side, want, s, w, h);
    tracks.push(pts);
    const g = fitRobust(
      pts.map((p) => p.x - cx),
      pts.map((p) => p.y - cy),
      line,
    );
    globals.push(g ?? line);
  }

  // Corner i joins side i−1 (ending at it) and side i (starting at it). Fit each of the two
  // sides using only its quarter nearest the corner, so a fold or curl elsewhere along the
  // side can't drag the corner away.
  const local = (i: number, nearStart: boolean): Line => {
    const pts = tracks[i];
    if (!pts) return globals[i];
    const sel = pts.filter((p) => (nearStart ? p.t < 0.3 : p.t > 0.7));
    if (sel.length < 8) return globals[i];
    const l = fitRobust(
      sel.map((p) => p.x - cx),
      sel.map((p) => p.y - cy),
      globals[i],
    );
    // A local direction wildly different from the side's is a stray, not a kink.
    if (!l || Math.abs(l.nx * globals[i].nx + l.ny * globals[i].ny) < Math.cos(12 * DEG)) return globals[i];
    return l;
  };
  const pts: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = (i + 3) % 4;
    const p = intersect(local(prev, false), local(i, true), cx, cy) ?? intersect(globals[prev], globals[i], cx, cy);
    if (!p) return null;
    pts.push(p);
  }
  // Reject a refinement that moved anything implausibly far (latched onto something else).
  const L = Math.max(w, h);
  for (let i = 0; i < 4; i++) {
    const before = c.corners[i];
    if (Math.hypot(pts[i].x - before.x, pts[i].y - before.y) > 0.1 * L) {
      return null;
    }
  }
  return pts;
}

function fitRobust(xs: number[], ys: number[], init: Line): Line | null {
  if (xs.length < 8) return null;
  let line = { ...init };
  let keep = xs.map(() => true);
  for (let iter = 0; iter < 3; iter++) {
    let sx = 0, sy = 0, cnt = 0;
    for (let k = 0; k < xs.length; k++) {
      if (!keep[k]) continue;
      sx += xs[k];
      sy += ys[k];
      cnt++;
    }
    if (cnt < 8) return null;
    const mx = sx / cnt;
    const my = sy / cnt;
    let sxx = 0, sxy = 0, syy = 0;
    for (let k = 0; k < xs.length; k++) {
      if (!keep[k]) continue;
      const dx = xs[k] - mx;
      const dy = ys[k] - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let nx = -Math.sin(theta);
    let ny = Math.cos(theta);
    if (nx * init.nx + ny * init.ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    line = { ...line, nx, ny, dx: -ny, dy: nx, rho: mx * nx + my * ny };
    // Drop points more than 1.5 px (or 2.5 robust sigmas) off the fit and go again.
    const res = xs.map((x, k) => Math.abs(x * nx + ys[k] * ny - line.rho));
    const sorted = res.filter((_, k) => keep[k]).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const lim = Math.max(1.5, 2.5 * 1.4826 * med);
    keep = res.map((r) => r <= lim);
  }
  return line;
}

// ── Resize ───────────────────────────────────────────────────────────────────

/** Area-average downscale (private: the shared resampler belongs to another module). */
function downscaleGray(src: GrayImage, dw: number, dh: number): GrayImage {
  const out = new Uint8Array(dw * dh);
  const sx = src.width / dw;
  const sy = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let acc = 0;
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        const row = Math.min(src.height - 1, yy) * src.width;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          acc += src.data[row + Math.min(src.width - 1, xx)] * wx * wy;
          wsum += wx * wy;
        }
      }
      out[y * dw + x] = Math.round(acc / wsum);
    }
  }
  return { width: dw, height: dh, data: out };
}
