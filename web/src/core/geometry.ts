// Perspective geometry for turning a photographed page into a flat, upright one.
//
// v1 got this from VisionKit. Here it is three small pieces: a homography solver, a
// perspective warp that samples the photo through it, and an output-size estimate that
// recovers the page's true aspect ratio from the four corners (Zhang & He, "Whiteboard
// scanning and image enhancement", 2007), since foreshortening makes the measured edge
// lengths lie about it.

import type { Point, Quad, RGBAImage } from './raster';

// ── Homography ───────────────────────────────────────────────────────────────

/**
 * The 3x3 projective map taking each `from` corner onto the matching `to` corner, row-major,
 * normalised so the last element is 1.
 */
export function homography(from: Quad, to: Quad): Float64Array {
  // Eight equations in h0...h7 (h8 = 1), solved by Gaussian elimination with partial
  // pivoting. Coordinates are normalised first so a 4000 px photo doesn't put 1e7-sized
  // products next to 1s in the same matrix.
  const nf = normaliser(from);
  const nt = normaliser(to);
  const a = new Float64Array(8 * 9); // augmented [A | b]
  for (let i = 0; i < 4; i++) {
    const x = (from[i].x - nf.cx) * nf.s;
    const y = (from[i].y - nf.cy) * nf.s;
    const u = (to[i].x - nt.cx) * nt.s;
    const v = (to[i].y - nt.cy) * nt.s;
    a.set([x, y, 1, 0, 0, 0, -u * x, -u * y, u], (2 * i) * 9);
    a.set([0, 0, 0, x, y, 1, -v * x, -v * y, v], (2 * i + 1) * 9);
  }
  const h = solve8(a);
  // H = Tto⁻¹ · Hn · Tfrom, where T(p) = s·(p − c).
  const hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const tf = [nf.s, 0, -nf.s * nf.cx, 0, nf.s, -nf.s * nf.cy, 0, 0, 1];
  const ttInv = [1 / nt.s, 0, nt.cx, 0, 1 / nt.s, nt.cy, 0, 0, 1];
  const m = mul3(ttInv, mul3(hn, tf));
  const out = new Float64Array(9);
  for (let i = 0; i < 9; i++) out[i] = m[i] / m[8];
  return out;
}

/** Apply a homography to a point. */
export function applyHomography(h: ArrayLike<number>, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

function normaliser(q: Quad): { cx: number; cy: number; s: number } {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  let d = 0;
  for (const p of q) d += Math.hypot(p.x - cx, p.y - cy);
  d /= 4;
  return { cx, cy, s: d > 0 ? Math.SQRT2 / d : 1 };
}

function solve8(a: Float64Array): Float64Array {
  const n = 8;
  const w = 9;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col * w + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * w + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) throw new Error('homography: degenerate quad (three corners collinear?)');
    if (pivot !== col) {
      for (let k = 0; k < w; k++) {
        const t = a[col * w + k];
        a[col * w + k] = a[pivot * w + k];
        a[pivot * w + k] = t;
      }
    }
    const inv = 1 / a[col * w + col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r * w + col] * inv;
      if (f === 0) continue;
      for (let k = col; k < w; k++) a[r * w + k] -= f * a[col * w + k];
    }
  }
  const x = new Float64Array(n);
  for (let r = 0; r < n; r++) x[r] = a[r * w + 8] / a[r * w + r];
  return x;
}

function mul3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
}

// ── Warp ─────────────────────────────────────────────────────────────────────

/**
 * Resample the region of `src` inside `quad` into an upright `outW` x `outH` image.
 *
 * Bilinear sampling, with k x k supersampling wherever the page is being shrunk by more than
 * ~1.4x: plain bilinear reads only four source pixels per output pixel, so a strong
 * downscale skips most of the ink and small type breaks up into aliasing. The factor is
 * chosen per output row from the local source footprint, so a page shot at a steep angle
 * only pays for supersampling on its near (larger) half.
 */
export function warpPerspective(src: RGBAImage, quad: Quad, outW: number, outH: number): RGBAImage {
  outW = Math.max(1, Math.round(outW));
  outH = Math.max(1, Math.round(outH));
  const rect: Quad = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const h = homography(rect, quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  const maxX = sw - 1;
  const maxY = sh - 1;

  // Accumulators for one output pixel.
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let aa = 0;
  const sample = (fx: number, fy: number): void => {
    // Pixel-centre convention: source pixel i covers [i, i+1), centre at i + 0.5.
    let x = fx - 0.5;
    let y = fy - 0.5;
    if (x < 0) x = 0;
    else if (x > maxX) x = maxX;
    if (y < 0) y = 0;
    else if (y > maxY) y = maxY;
    const x0 = x | 0;
    const y0 = y | 0;
    const x1 = x0 < maxX ? x0 + 1 : x0;
    const y1 = y0 < maxY ? y0 + 1 : y0;
    const tx = x - x0;
    const ty = y - y0;
    const i00 = (y0 * sw + x0) << 2;
    const i10 = (y0 * sw + x1) << 2;
    const i01 = (y1 * sw + x0) << 2;
    const i11 = (y1 * sw + x1) << 2;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    ar += sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
    ag += sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
    ab += sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
    aa += sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11;
  };

  for (let j = 0; j < outH; j++) {
    const k = rowSupersampling(h, j, outW);
    const inv = 1 / (k * k);
    for (let i = 0; i < outW; i++) {
      ar = ag = ab = aa = 0;
      if (k === 1) {
        const px = i + 0.5;
        const py = j + 0.5;
        const w = h[6] * px + h[7] * py + h[8];
        sample((h[0] * px + h[1] * py + h[2]) / w, (h[3] * px + h[4] * py + h[5]) / w);
      } else {
        for (let sy = 0; sy < k; sy++) {
          const py = j + (sy + 0.5) / k;
          for (let sx = 0; sx < k; sx++) {
            const px = i + (sx + 0.5) / k;
            const w = h[6] * px + h[7] * py + h[8];
            sample((h[0] * px + h[1] * py + h[2]) / w, (h[3] * px + h[4] * py + h[5]) / w);
          }
        }
      }
      const o = (j * outW + i) << 2;
      out[o] = ar * inv;
      out[o + 1] = ag * inv;
      out[o + 2] = ab * inv;
      out[o + 3] = aa * inv;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** Supersampling factor for one output row: the largest source footprint along that row. */
function rowSupersampling(h: Float64Array, row: number, outW: number): number {
  let worst = 0;
  const py = row + 0.5;
  for (const px of [0.5, outW / 2, outW - 0.5]) {
    const p = applyHomography(h, px, py);
    const dx = applyHomography(h, px + 1, py);
    const dy = applyHomography(h, px, py + 1);
    worst = Math.max(worst, Math.hypot(dx.x - p.x, dx.y - p.y), Math.hypot(dy.x - p.x, dy.y - p.y));
  }
  if (worst <= 1.4) return 1;
  return Math.min(4, Math.ceil(worst));
}

// ── Output size ──────────────────────────────────────────────────────────────

/**
 * Pixel size of the flattened page.
 *
 * The aspect ratio comes from the projective geometry of the four corners rather than from
 * their edge lengths: a Letter page photographed from below the top edge measures far
 * shorter than it is, and averaging edges would print it squashed. Resolution matches the
 * best-sampled part of the quad (the near edge), so nothing is thrown away, then the long
 * edge is capped at `maxLongEdge`.
 */
export function outputSize(
  quad: Quad,
  imgW: number,
  imgH: number,
  maxLongEdge: number,
  focalPx?: number,
): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const top = dist(tl, tr);
  const bottom = dist(bl, br);
  const left = dist(tl, bl);
  const right = dist(tr, br);
  const w0 = Math.max(top, bottom);
  const h0 = Math.max(left, right);

  const ratio = aspectRatio(quad, imgW, imgH, focalPx) ?? (top + bottom) / Math.max(1e-6, left + right);

  let width = Math.max(w0, h0 * ratio);
  let height = width / ratio;
  const long = Math.max(width, height);
  if (long > maxLongEdge) {
    const s = maxLongEdge / long;
    width *= s;
    height *= s;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** Focal length assumed when the quad can't pin it down, as a fraction of the image's long edge. */
export const DEFAULT_FOCAL_FACTOR = 0.8;

/**
 * Width / height of the real rectangle behind `quad`, or null when the corners are unusable.
 *
 * Zhang & He: with corners m1 = TL, m2 = TR, m3 = BL, m4 = BR in homogeneous pixel
 * coordinates, the vanishing geometry gives the focal length f (principal point assumed at
 * the image centre, square pixels), and then (w/h)² = |A⁻¹n2|² / |A⁻¹n3|².
 *
 * f is only measurable when both pairs of opposite edges converge. The most common phone
 * shot (camera tipped forward, page square to it) has the left and right edges converging
 * but the top and bottom parallel; then f comes from `focalPx` (EXIF, when known) or a
 * typical phone camera's (DEFAULT_FOCAL_FACTOR x long edge). The ratio is far less sensitive
 * to f than edge averaging is to the tilt, and for a true parallelogram it doesn't depend on
 * f at all.
 */
export function aspectRatio(quad: Quad, imgW: number, imgH: number, focalPx?: number): number | null {
  const [tl, tr, br, bl] = quad;
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m1 = [tl.x, tl.y, 1];
  const m2 = [tr.x, tr.y, 1];
  const m3 = [bl.x, bl.y, 1];
  const m4 = [br.x, br.y, 1];

  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3) || k2 <= 0 || k3 <= 0) return null;

  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  const L = Math.max(imgW, imgH);
  let f = focalPx && focalPx > 0 ? focalPx : DEFAULT_FOCAL_FACTOR * L;
  // Relative size of the projective terms: when either is ~0 that pair of edges is parallel
  // and the focal length can't be measured from the quad.
  const scale2 = Math.hypot(n2[0], n2[1]) / L;
  const scale3 = Math.hypot(n3[0], n3[1]) / L;
  if (Math.abs(n2[2]) > 2e-3 * scale2 && Math.abs(n3[2]) > 2e-3 * scale3) {
    const f2 =
      -(
        n2[0] * n3[0] -
        (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
        n2[2] * n3[2] * u0 * u0 +
        (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)
      ) /
      (n2[2] * n3[2]);
    // Phone cameras sit around 0.7-1.2 x the long edge; an estimate far outside that is the
    // formula amplifying corner noise, not a real lens, so keep the assumed value.
    if (Number.isFinite(f2) && f2 > 0) {
      const est = Math.sqrt(f2);
      if (est > 0.3 * L && est < 5 * L) f = est;
    }
  }

  const norm = (n: number[]): number => {
    const a = (n[0] - u0 * n[2]) / f;
    const b = (n[1] - v0 * n[2]) / f;
    return a * a + b * b + n[2] * n[2];
  };
  const r2 = norm(n2) / norm(n3);
  if (!Number.isFinite(r2) || r2 <= 0) return null;
  return Math.sqrt(r2);
}

// ── Quads ────────────────────────────────────────────────────────────────────

/** Order four points as top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error('orderQuad needs exactly four points');
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  // Clockwise on screen (y down) = increasing atan2 angle, starting from the upper left.
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < best) {
      best = s;
      start = i;
    }
  }
  const q = [0, 1, 2, 3].map((k) => ({ ...sorted[(start + k) % 4] }));
  return q as Quad;
}

/** The whole image as a quad. */
export function fullFrameQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/** Scale a quad from one image size to another (e.g. preview frame → full-resolution photo). */
export function scaleQuad(quad: Quad, sx: number, sy: number = sx): Quad {
  return quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
}

/** Signed area (positive for TL, TR, BR, BL on a y-down screen). */
export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return a / 2;
}

/** True when the quad is strictly convex and wound TL, TR, BR, BL. */
export function isConvex(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z <= 0) return false;
  }
  return true;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
