// Synthetic "phone photos" of documents with known corners, for the detector tests.
//
// A page (paper tone, text-like strokes, sometimes a shaded box or a fold) is rendered
// through a random perspective onto one of several backgrounds, at 2x and then area-averaged
// down, so edges are anti-aliased like a real camera's. Lighting gradients and sensor noise
// go on top. Everything is driven by a seeded RNG so the set is identical on every run.

import { applyHomography, homography } from '../../../src/core/geometry';
import type { GrayImage, Point, Quad } from '../../../src/core/raster';

export type Background = 'wood' | 'white' | 'dark' | 'clutter';
export type DocKind = 'letter' | 'cheque' | 'receipt';

export interface SynthCase {
  name: string;
  gray: GrayImage;
  truth: Quad;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Render the page itself, upright, at (dw, dh). */
function renderDoc(r: () => number, dw: number, dh: number, kind: DocKind): Float32Array {
  const paper = 228 + r() * 20;
  const d = new Float32Array(dw * dh).fill(paper);
  const ink = 25 + r() * 50;
  const margin = 0.08 * dw;
  const lineH = kind === 'cheque' ? dh / 9 : dh / (28 + r() * 16);
  const stroke = Math.max(1, lineH * 0.35);
  for (let y = margin; y < dh - margin; y += lineH) {
    if (r() < 0.15) continue; // paragraph gap
    let x = margin;
    const end = dw - margin - r() * dw * 0.3;
    while (x < end) {
      const word = (0.03 + r() * 0.1) * dw;
      const x1 = Math.min(end, x + word);
      for (let yy = Math.round(y); yy < Math.min(dh, Math.round(y + stroke)); yy++) {
        for (let xx = Math.round(x); xx < Math.round(x1); xx++) {
          // Broken strokes, like glyphs.
          if (((xx * 7 + yy * 3) % 11) < 8) d[yy * dw + xx] = ink;
        }
      }
      x = x1 + 0.02 * dw;
    }
  }
  if (r() < 0.4) {
    // Shaded box or photo block.
    const bx = margin + r() * dw * 0.3;
    const by = margin + r() * dh * 0.5;
    const bw = dw * (0.2 + r() * 0.3);
    const bh = dh * (0.08 + r() * 0.15);
    const tone = 90 + r() * 90;
    for (let yy = Math.round(by); yy < Math.min(dh, by + bh); yy++)
      for (let xx = Math.round(bx); xx < Math.min(dw, bx + bw); xx++) d[yy * dw + xx] = tone + 20 * Math.sin(xx * 0.1) * Math.cos(yy * 0.13);
  }
  if (kind === 'letter' && r() < 0.5) {
    // Fold crease: a faint shading step across the page.
    const fy = Math.round(dh * (0.3 + r() * 0.4));
    for (let yy = fy; yy < Math.min(dh, fy + 3); yy++) for (let xx = 0; xx < dw; xx++) d[yy * dw + xx] -= 12;
  }
  return d;
}

function renderBackground(r: () => number, w: number, h: number, bg: Background): Float32Array {
  const b = new Float32Array(w * h);
  switch (bg) {
    case 'wood': {
      const base = 85 + r() * 40;
      const ang = r() * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const f1 = 0.05 + r() * 0.08;
      const phase = r() * 10;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const u = x * ca + y * sa;
          const v = -x * sa + y * ca;
          const grain = Math.sin(u * f1 + 3 * Math.sin(v * 0.01 + phase)) * 14 + Math.sin(u * f1 * 3.1) * 6;
          b[y * w + x] = base + grain + Math.sin(v * 0.004) * 10;
        }
      break;
    }
    case 'white': {
      const base = 200 + r() * 18;
      for (let i = 0; i < b.length; i++) b[i] = base;
      // Speckle.
      const dots = (w * h) / 60;
      for (let k = 0; k < dots; k++) {
        const x = (r() * w) | 0;
        const y = (r() * h) | 0;
        const s = 1 + ((r() * 3) | 0);
        const tone = r() < 0.5 ? base - 30 - r() * 60 : Math.min(255, base + 25);
        for (let yy = y; yy < Math.min(h, y + s); yy++) for (let xx = x; xx < Math.min(w, x + s); xx++) b[yy * w + xx] = tone;
      }
      break;
    }
    case 'dark': {
      const base = 30 + r() * 35;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = base + 8 * Math.sin(x * 0.02 + y * 0.015);
      break;
    }
    case 'clutter': {
      const base = 100 + r() * 50;
      for (let i = 0; i < b.length; i++) b[i] = base;
      const items = 6 + ((r() * 6) | 0);
      for (let k = 0; k < items; k++) {
        const tone = r() < 0.5 ? 20 + r() * 60 : 170 + r() * 70;
        if (r() < 0.5) {
          // A pen or cable: thick line.
          const x0 = r() * w, y0 = r() * h;
          const ang = r() * Math.PI;
          const len = (0.2 + r() * 0.5) * Math.max(w, h);
          const th = 4 + r() * 10;
          for (let t = 0; t < len; t += 0.5) {
            const cx = x0 + Math.cos(ang) * t;
            const cy = y0 + Math.sin(ang) * t;
            for (let yy = Math.round(cy - th / 2); yy < cy + th / 2; yy++)
              for (let xx = Math.round(cx - th / 2); xx < cx + th / 2; xx++)
                if (xx >= 0 && yy >= 0 && xx < w && yy < h) b[yy * w + xx] = tone;
          }
        } else {
          // A box or another object.
          const bx = r() * w, by = r() * h, bw = (0.05 + r() * 0.2) * w, bh = (0.05 + r() * 0.2) * h;
          for (let yy = Math.round(by); yy < Math.min(h, by + bh); yy++)
            for (let xx = Math.round(bx); xx < Math.min(w, bx + bw); xx++) b[yy * w + xx] = tone;
        }
      }
      break;
    }
  }
  return b;
}

/** One synthetic scene. `index` picks the background and document kind deterministically. */
export function makeCase(index: number): SynthCase {
  const r = rng(1000 + index * 7919);
  const backgrounds: Background[] = ['wood', 'white', 'dark', 'clutter'];
  const bg = backgrounds[index % 4];
  const kind: DocKind = index % 5 === 3 ? 'cheque' : index % 7 === 5 ? 'receipt' : 'letter';
  const portrait = r() < 0.7;
  const W = portrait ? 360 : 480;
  const H = portrait ? 480 : 360;
  const S = 2; // supersampling
  const w = W * S;
  const h = H * S;

  const aspect = kind === 'letter' ? 8.5 / 11 : kind === 'cheque' ? 2.35 : 0.38;
  const dw = kind === 'cheque' ? 700 : kind === 'receipt' ? 240 : 500;
  const dh = Math.round(dw / aspect);
  const doc = renderDoc(r, dw, dh, kind);

  // Place the page: random scale, rotation (sometimes a quarter turn), and corner jitter for
  // perspective. Retry until every corner sits inside the frame with a margin.
  let quad: Quad | null = null;
  for (let attempt = 0; attempt < 200 && !quad; attempt++) {
    const quarter = r() < 0.2 ? Math.PI / 2 : 0;
    const rot = quarter + (r() - 0.5) * (40 * Math.PI) / 180;
    const fill = kind === 'letter' ? 0.55 + r() * 0.35 : kind === 'cheque' ? 0.5 + r() * 0.35 : 0.45 + r() * 0.35;
    // Long side of the page as a fraction of the frame's matching dimension.
    const docLong = Math.max(dw, dh);
    const rotLongAlongY = Math.abs(Math.cos(rot)) > 0.7 ? dh >= dw : dw > dh;
    const frameDim = rotLongAlongY ? h : w;
    const scale = (fill * frameDim) / docLong;
    const cx = w / 2 + (r() - 0.5) * w * 0.15;
    const cy = h / 2 + (r() - 0.5) * h * 0.15;
    const jitter = 0.07 * Math.max(dw, dh) * scale;
    const base = [
      { x: -dw / 2, y: -dh / 2 },
      { x: dw / 2, y: -dh / 2 },
      { x: dw / 2, y: dh / 2 },
      { x: -dw / 2, y: dh / 2 },
    ];
    const pts = base.map((p) => {
      const x = p.x * scale;
      const y = p.y * scale;
      return {
        x: cx + x * Math.cos(rot) - y * Math.sin(rot) + (r() - 0.5) * 2 * jitter,
        y: cy + x * Math.sin(rot) + y * Math.cos(rot) + (r() - 0.5) * 2 * jitter,
      };
    });
    const m = 0.03 * Math.max(w, h);
    if (pts.every((p) => p.x > m && p.y > m && p.x < w - m && p.y < h - m)) quad = pts as Quad;
  }
  if (!quad) throw new Error(`could not place page for case ${index}`);

  const docQuad: Quad = [
    { x: 0, y: 0 },
    { x: dw, y: 0 },
    { x: dw, y: dh },
    { x: 0, y: dh },
  ];
  const inv = homography(quad, docQuad);
  const back = renderBackground(r, w, h, bg);
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = applyHomography(inv, x + 0.5, y + 0.5);
      if (p.x >= 0 && p.y >= 0 && p.x < dw && p.y < dh) img[y * w + x] = doc[(p.y | 0) * dw + (p.x | 0)];
      else img[y * w + x] = back[y * w + x];
    }
  }

  // Lighting: a soft shadow ramp across the frame, sometimes.
  if (r() < 0.5) {
    const ang = r() * 2 * Math.PI;
    const depth = 0.25 + r() * 0.2;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const span = Math.abs(ux) * w + Math.abs(uy) * h;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const t = ((x - w / 2) * ux + (y - h / 2) * uy) / span + 0.5;
        img[y * w + x] *= 1 - depth * Math.max(0, Math.min(1, t));
      }
  }

  // Downscale 2x by box average, add sensor noise.
  const noise = 2 + r() * 4;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * S * w + x * S;
      const v = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4 + gauss(r) * noise;
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  const truth = quad.map((p: Point) => ({ x: p.x / S, y: p.y / S })) as Quad;
  return { name: `synth-${String(index).padStart(2, '0')}-${bg}-${kind}`, gray: { width: W, height: H, data: out }, truth };
}
