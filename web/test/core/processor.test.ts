import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzlibSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { flatField, gaussianBlur, gaussianExact, ocrInput, packBilevel, processPage } from '../../src/core/imageProcessor';
import { jpegComponentCount, mozjpegEncoder } from '../../src/core/jpeg';
import { analyze } from '../../src/core/pageAnalyzer';
import { createFloat, type GrayImage, type RGBAImage } from '../../src/core/raster';
import { COLOR_MODES, type ColorMode } from '../../src/core/types';
import { ensureMozjpeg, hasV1, outPath, readPNG, V1_DIR, writePNG } from './helpers/io';
import { makePage, patchLuminance } from './helpers/synthetic';

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

let shadowed: RGBAImage;
beforeAll(async () => {
  await ensureMozjpeg();
  shadowed = makePage({ width: 2550, height: 3300, shadow: true, colorAccent: false, grayPhoto: false });
});

describe('blur', () => {
  it('fast large-sigma Gaussian matches a direct kernel', () => {
    // Smooth-but-structured field: lighting-like ramps plus blobs and hard edges.
    const w = 640;
    const h = 480;
    const img = createFloat(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const blob = Math.exp(-((x - 200) ** 2 + (y - 150) ** 2) / 4000);
        const edge = x > 420 && y > 260 ? 0.4 : 0;
        img.data[y * w + x] = 0.3 + 0.4 * (x / w) + 0.2 * blob + edge;
      }
    }
    const sigma = 24;
    const fast = gaussianBlur(img, sigma);
    const exact = gaussianExact(img, sigma);
    let maxErr = 0;
    let sumErr = 0;
    for (let i = 0; i < img.data.length; i++) {
      const e = Math.abs(fast.data[i] - exact.data[i]);
      maxErr = Math.max(maxErr, e);
      sumErr += e;
    }
    console.log(`gaussian σ=${sigma}: max err ${maxErr.toFixed(4)}, mean err ${(sumErr / img.data.length).toFixed(5)}`);
    expect(maxErr).toBeLessThan(0.02);
    expect(sumErr / img.data.length).toBeLessThan(0.003);
  });
});

describe('flat-field correction (shadowed text page)', () => {
  it('removes most of the shadow', async () => {
    const corners: [number, number][] = [
      [0.06, 0.94],
      [0.94, 0.06],
    ];
    const before = corners.map(([x, y]) => patchLuminance(shadowed, x, y));
    const out = await processPage(shadowed, 'grayscale', 'balanced', mozjpegEncoder);
    const after = corners.map(([x, y]) => patchLuminance(out.preview, x, y));
    const spreadBefore = Math.abs(before[0] - before[1]);
    const spreadAfter = Math.abs(after[0] - after[1]);
    console.log(
      `raw capture  ${before[0].toFixed(3)} / ${before[1].toFixed(3)} spread ${spreadBefore.toFixed(3)}\n` +
        `flat-fielded ${after[0].toFixed(3)} / ${after[1].toFixed(3)} spread ${spreadAfter.toFixed(3)}  (v1: 0.149 → 0.000)`,
    );
    expect(spreadAfter).toBeLessThan(spreadBefore * 0.4);
  });

  it('lands paper at white under a strong vignette', () => {
    const w = 400;
    const h = 300;
    const img = createFloat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data[y * w + x] = 0.9 * (0.5 + 0.5 * (x / w));
    const flat = flatField(img);
    let min = 1;
    for (const v of flat.data) min = Math.min(min, v);
    expect(min).toBeGreaterThan(0.97);
  });
});

describe('rendering and encoding (2550x3300 shadowed text page, balanced)', () => {
  const sizes = new Map<ColorMode, number>();

  for (const mode of COLOR_MODES) {
    it(mode, async () => {
      const t = performance.now();
      const out = await processPage(shadowed, mode, 'balanced', mozjpegEncoder);
      const ms = performance.now() - t;
      sizes.set(mode, out.data.length);
      console.log(`${mode.padEnd(14)} ${out.width} x ${out.height}  ${out.encoding.padEnd(13)} ${kb(out.data.length)}  ${ms.toFixed(0)} ms`);
      writePNG(outPath(`processed-${mode}.png`), out.preview);

      // Same pixel caps as v1: 1932x2500, 2164x2800, 2550x3300.
      const expected = { color: [1932, 2500], grayscale: [2164, 2800], blackAndWhite: [2550, 3300] }[mode];
      expect([out.width, out.height]).toEqual(expected);

      if (mode === 'blackAndWhite') {
        expect(out.encoding).toBe('flateBilevel');
        expect(out.data[0]).toBe(0x78); // zlib header
        const raw = unzlibSync(out.data);
        expect(raw.length).toBe(((out.width + 7) >> 3) * out.height);
      } else {
        expect(out.data[0]).toBe(0xff);
        expect(out.data[1]).toBe(0xd8);
        expect(jpegComponentCount(out.data)).toBe(mode === 'grayscale' ? 1 : 3);
        expect(out.encoding).toBe(mode === 'grayscale' ? 'jpegGray' : 'jpegRGB');
      }
    });
  }

  it('B&W is several times smaller than either JPEG mode', () => {
    const bw = sizes.get('blackAndWhite')!;
    const smallestJpeg = Math.min(sizes.get('color')!, sizes.get('grayscale')!);
    console.log(
      `sizes: colour ${kb(sizes.get('color')!)}, grey ${kb(sizes.get('grayscale')!)}, B&W ${kb(bw)}` +
        `  (v1 on its own fixture: 274.9 / 271.4 / 31.8 KB)`,
    );
    expect(bw).toBeLessThan(smallestJpeg / 3);
  });
});

describe.skipIf(!hasV1())('against v1 output on the identical source page', () => {
  it('renders all three modes of v1 source-text-only.png and compares with v1 previews', async () => {
    const source = readPNG(resolve(V1_DIR, 'source-text-only.png'));
    const lines: string[] = [];
    for (const mode of COLOR_MODES) {
      const out = await processPage(source, mode, 'balanced', mozjpegEncoder);
      const refPath = resolve(V1_DIR, `processed-${mode}.png`);
      if (!existsSync(refPath)) continue;
      const ref = readPNG(refPath);
      expect([out.width, out.height]).toEqual([ref.width, ref.height]);
      let diff = 0;
      let agree = 0;
      const n = ref.width * ref.height;
      for (let i = 0; i < n; i++) {
        const a = luma(out.preview, i);
        const b = luma(ref, i);
        diff += Math.abs(a - b);
        if ((a >= 128) === (b >= 128)) agree++;
      }
      lines.push(
        `${mode.padEnd(14)} ${kb(out.data.length).padStart(9)}   mean |Δ| ${(diff / n).toFixed(2)} /255   ink/paper agreement ${((agree / n) * 100).toFixed(2)}%`,
      );
      writePNG(outPath(`v1src-processed-${mode}.png`), out.preview);
      expect(diff / n).toBeLessThan(mode === 'blackAndWhite' ? 6 : 8);
      expect(agree / n).toBeGreaterThan(0.99);
    }
    console.log(['', 'TS render of v1 source vs v1 render:', ...lines, '(v1: 274.9 / 271.4 / 31.8 KB)'].join('\n'));
  });
});

describe('bilevel packing', () => {
  it('packs MSB first, 0 = black, rows padded to whole bytes', () => {
    const g: GrayImage = { width: 10, height: 2, data: new Uint8Array(20) };
    // Row 0: white at x = 0, 2, 9. Row 1: all white.
    g.data[0] = 255;
    g.data[2] = 255;
    g.data[9] = 255;
    for (let x = 0; x < 10; x++) g.data[10 + x] = 255;
    const packed = packBilevel(g);
    expect(Array.from(packed)).toEqual([0b10100000, 0b01000000, 0xff, 0b11000000]);
  });
});

describe('OCR input', () => {
  it('is flat-fielded grey capped at 2600px', () => {
    const g = ocrInput(shadowed);
    expect(Math.max(g.width, g.height)).toBe(2600);
    // Paper in both corners now reads white.
    const at = (ux: number, uy: number) => g.data[Math.floor(uy * g.height) * g.width + Math.floor(ux * g.width)];
    expect(at(0.03, 0.03)).toBeGreaterThan(240);
    expect(at(0.97, 0.97)).toBeGreaterThan(240);
    writePNG(outPath('ocr-input.png'), g);
  });
});

describe('timing (Node, 2550x3300)', () => {
  it('reports analyse and render times', async () => {
    const t0 = performance.now();
    analyze(shadowed);
    const tAnalyze = performance.now() - t0;
    const parts = [`analyze ${tAnalyze.toFixed(0)} ms`];
    for (const mode of COLOR_MODES) {
      const t = performance.now();
      await processPage(shadowed, mode, 'balanced', mozjpegEncoder);
      parts.push(`${mode} ${(performance.now() - t).toFixed(0)} ms`);
    }
    console.log(parts.join(', '));
  });
});

function luma(img: RGBAImage, i: number): number {
  const o = i * 4;
  return 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
}
