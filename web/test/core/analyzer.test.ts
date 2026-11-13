import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/pageAnalyzer';
import type { RGBAImage } from '../../src/core/raster';
import { COLOR_MODE_LABEL, type ColorMode } from '../../src/core/types';
import { hasPrivateFrames, hasV1, PRIVATE_FRAMES, readPNG, swiftStats, V1_DIR } from './helpers/io';
import { makePage, type PageOptions } from './helpers/synthetic';

const base = { width: 2550, height: 3300 };
const FIXTURES: { name: string; options: PageOptions; expected: ColorMode }[] = [
  { name: 'text-only', options: { ...base, shadow: true, colorAccent: false, grayPhoto: false }, expected: 'blackAndWhite' },
  { name: 'text-no-shadow', options: { ...base, shadow: false, colorAccent: false, grayPhoto: false }, expected: 'blackAndWhite' },
  // Tungsten light with nothing actually coloured on the page.
  { name: 'warm-cast', options: { ...base, shadow: true, colorAccent: false, grayPhoto: false, warmCast: true }, expected: 'blackAndWhite' },
  { name: 'with-gray-photo', options: { ...base, shadow: true, colorAccent: false, grayPhoto: true }, expected: 'grayscale' },
  // A photo covering ~6% of the page: only passes if a single saturated tile carries the decision.
  { name: 'small-gray-photo', options: { ...base, shadow: true, colorAccent: false, grayPhoto: true, photoScale: 0.4 }, expected: 'grayscale' },
  // Flat shaded block rather than a photo: thresholding wipes it out just the same.
  { name: 'gray-box', options: { ...base, shadow: true, colorAccent: false, grayPhoto: false, grayBox: true }, expected: 'grayscale' },
  { name: 'with-color-logo', options: { ...base, shadow: true, colorAccent: true, grayPhoto: false }, expected: 'color' },
];

const f3 = (v: number) => v.toFixed(3);

describe('colour-mode detection on TS-drawn fixtures', () => {
  for (const fx of FIXTURES) {
    it(`${fx.name} → ${fx.expected}`, () => {
      const { mode, stats } = analyze(makePage(fx.options));
      console.log(
        `${fx.name.padEnd(18)} → ${mode.padEnd(14)} colour ${f3(stats.coloredFraction)} vivid ${f3(stats.vividFraction)} ` +
          `midtone ${f3(stats.midtoneFraction)} maxTile ${f3(stats.maxTileMidtone)}`,
      );
      expect(mode).toBe(fx.expected);
    });
  }
});

// Same pixels as v1: the source PNGs its own harness drew with CoreGraphics + CoreText.
// Refresh with `bash scripts/fetch-v1-fixtures.sh` (needs the Mac mini).
describe.skipIf(!hasV1())('parity with v1 (Swift) on its own fixture PNGs', () => {
  const reference = hasV1() ? swiftStats() : new Map();
  const rows: string[] = [];

  for (const fx of FIXTURES) {
    it(fx.name, () => {
      const ref = reference.get(fx.name);
      expect(ref, `swift stats for ${fx.name}`).toBeDefined();
      const { mode, stats } = analyze(readPNG(resolve(V1_DIR, `source-${fx.name}.png`)));
      rows.push(
        `${fx.name.padEnd(18)} mode ${COLOR_MODE_LABEL[mode].padEnd(13)}/${ref!.mode.padEnd(13)} ` +
          `colour ${f3(stats.coloredFraction)}/${f3(ref!.colour)}  vivid ${f3(stats.vividFraction)}/${f3(ref!.vivid)}  ` +
          `midtone ${f3(stats.midtoneFraction)}/${f3(ref!.midtone)}  maxTile ${f3(stats.maxTileMidtone)}/${f3(ref!.maxTile)}`,
      );
      expect(COLOR_MODE_LABEL[mode]).toBe(ref!.mode);
      // Colour fractions come from a 256px thumbnail: CoreGraphics' "medium" interpolation vs
      // an exact area average shifts a handful of edge pixels, i.e. a few thousandths.
      expect(Math.abs(stats.coloredFraction - ref!.colour)).toBeLessThan(0.004);
      expect(Math.abs(stats.vividFraction - ref!.vivid)).toBeLessThan(0.004);
      // Midtones are counted at 2400px on anti-aliased glyph edges, where resampling kernels
      // differ most. Measured agreement is within 0.001; the bounds leave room for the
      // printed three-decimal rounding and nothing more.
      expect(Math.abs(stats.midtoneFraction - ref!.midtone)).toBeLessThan(Math.max(0.004, ref!.midtone * 0.05));
      expect(Math.abs(stats.maxTileMidtone - ref!.maxTile)).toBeLessThan(Math.max(0.006, ref!.maxTile * 0.05));
    });
  }

  it('prints the side-by-side table (TS/Swift)', () => {
    console.log(['', 'TS / Swift', ...rows].join('\n'));
  });
});

// Informational: real phone photos, background and all (not deskewed), so there is no
// right answer to assert. Frames are private and never committed (see .gitignore).
describe.skipIf(!hasPrivateFrames())('real photos (informational)', () => {
  it('reports the mode chosen for each photo', () => {
    const files = readdirSync(PRIVATE_FRAMES).filter((f) => f.endsWith('.png')).sort();
    const lines: string[] = [];
    for (const f of files) {
      const t = performance.now();
      const { mode, stats } = analyze(readPNG(resolve(PRIVATE_FRAMES, f)));
      lines.push(
        `${f.padEnd(44)} ${mode.padEnd(14)} colour ${f3(stats.coloredFraction)} vivid ${f3(stats.vividFraction)} ` +
          `midtone ${f3(stats.midtoneFraction)} maxTile ${f3(stats.maxTileMidtone)}  (${Math.round(performance.now() - t)} ms)`,
      );
    }
    console.log(['', ...lines].join('\n'));
    expect(files.length).toBeGreaterThan(0);
  });

  // The page alone: crop each photo to the axis-aligned rectangle inside its hand-marked
  // corners (test/fixtures/private/truth.json, on the 360x480 detection frames), inset 2%, so
  // the table or desk is gone. Closer to what the analyser sees after deskewing.
  const truthPath = resolve(PRIVATE_FRAMES, '..', 'truth.json');
  const framesIndex = resolve(PRIVATE_FRAMES, '..', 'frames', 'index.json');
  it.skipIf(!existsSync(truthPath) || !existsSync(framesIndex))('reports the mode for the page region only', () => {
    const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, { quad?: number[][] }>;
    const frames = JSON.parse(readFileSync(framesIndex, 'utf8')) as { id: string; source: string; width: number; height: number }[];
    const ours = JSON.parse(readFileSync(resolve(PRIVATE_FRAMES, 'index.json'), 'utf8')) as Record<string, { source: string }>;
    const lines: string[] = [];
    for (const [file, { source }] of Object.entries(ours)) {
      const frame = frames.find((f) => f.source.replace(/\\/g, '/') === source);
      const quad = frame && truth[frame.id]?.quad;
      if (!frame || !quad) continue;
      const img = readPNG(resolve(PRIVATE_FRAMES, file));
      const s = img.width / frame.width;
      const [tl, tr, br, bl] = quad;
      let x0 = Math.max(tl[0], bl[0]) * s;
      let x1 = Math.min(tr[0], br[0]) * s;
      let y0 = Math.max(tl[1], tr[1]) * s;
      let y1 = Math.min(bl[1], br[1]) * s;
      const ix = (x1 - x0) * 0.02;
      const iy = (y1 - y0) * 0.02;
      [x0, x1, y0, y1] = [x0 + ix, x1 - ix, y0 + iy, y1 - iy].map(Math.round);
      const crop = cropRGBA(img, x0, y0, x1 - x0, y1 - y0);
      const { mode, stats } = analyze(crop);
      lines.push(
        `${file.padEnd(44)} ${mode.padEnd(14)} colour ${f3(stats.coloredFraction)} vivid ${f3(stats.vividFraction)} ` +
          `midtone ${f3(stats.midtoneFraction)} maxTile ${f3(stats.maxTileMidtone)}  (${crop.width}x${crop.height})`,
      );
    }
    console.log(['', 'page region only:', ...lines].join('\n'));
    expect(lines.length).toBeGreaterThan(0);
  });
});

function cropRGBA(img: RGBAImage, x: number, y: number, w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}
