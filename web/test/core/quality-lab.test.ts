// Quality lab: v1's greyscale/B&W rendering vs v2's, scored by OCR word accuracy (Tesseract CLI)
// and written out for visual comparison.
//
// Inputs (all gitignored, regenerate as needed):
//   test/fixtures/quality/soft-page.png   synthetic soft ~212 dpi capture with exact ground truth
//                                         (python -P -E scripts/make-quality-fixture.py)
//   test/fixtures/private/analysis + truth.json   real phone photos, deskewed with hand-marked corners
// Output: test/out/quality/<page>-<v1|v2>-<mode>.png and scores.txt
//
// The synthetic page is a hard gate (v2 must not read worse than v1); real pages are reported.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { outputSize, warpPerspective } from '../../src/core/geometry';
import { processPage, QUALITY } from '../../src/core/imageProcessor';
import { mozjpegEncoder } from '../../src/core/jpeg';
import type { Quad, RGBAImage } from '../../src/core/raster';
import type { ColorMode } from '../../src/core/types';
import { processPage as processPageV1 } from './helpers/imageProcessorV1';
import { ensureMozjpeg, PRIVATE_FRAMES, readPNG, WEB_ROOT, writePNG } from './helpers/io';

const OUT = resolve(WEB_ROOT, 'test/out/quality');
const SOFT = resolve(WEB_ROOT, 'test/fixtures/quality/soft-page.png');
const hasTesseract = (() => {
  try {
    execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9.,]*[a-z0-9]|[a-z0-9]/g) ?? []).map((w) => w.replace(/[.,]/g, '')).filter((w) => w.length >= 3);
}

/** Share of reference words found in the candidate (multiset recall). */
function recall(reference: string[], candidate: string[]): number {
  const bag = new Map<string, number>();
  for (const w of candidate) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of reference) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  return reference.length ? hit / reference.length : 0;
}

function ocr(png: string): string {
  return execFileSync('tesseract', [png, 'stdout', '--psm', '3'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

async function render(page: RGBAImage, name: string, mode: ColorMode, version: 'v1' | 'v2') {
  const fn = version === 'v1' ? processPageV1 : processPage;
  const out = await fn(page, mode, 'balanced', mozjpegEncoder);
  const file = resolve(OUT, `${name}-${version}-${mode}.png`);
  writePNG(file, out.preview);
  return { file, bytes: out.data.length, width: out.width, height: out.height };
}

const scores: string[] = [];

describe.skipIf(!hasTesseract)('quality lab', () => {
  beforeAll(async () => {
    // Tuning: SNAPDRIVE_QUALITY='{"graySharpenAmount":1.4}' overrides v2 settings for this run.
    if (process.env.SNAPDRIVE_QUALITY) Object.assign(QUALITY, JSON.parse(process.env.SNAPDRIVE_QUALITY));
    mkdirSync(OUT, { recursive: true });
    await ensureMozjpeg();
  });

  it.skipIf(!existsSync(SOFT))('soft synthetic capture: v2 reads at least as well as v1, B&W clearly better', async () => {
    const truth = words(readFileSync(SOFT.replace('.png', '.txt'), 'utf8'));
    const page = readPNG(SOFT);
    const result: Record<string, number> = {};
    for (const mode of ['blackAndWhite', 'grayscale'] as ColorMode[]) {
      for (const v of ['v1', 'v2'] as const) {
        const r = await render(page, 'soft', mode, v);
        const score = recall(truth, words(ocr(r.file)));
        result[`${v}-${mode}`] = score;
        scores.push(`soft  ${v} ${mode.padEnd(13)} ${r.width}x${r.height} ${(r.bytes / 1024).toFixed(1).padStart(7)} KB  word recall ${(score * 100).toFixed(1)}%`);
      }
    }
    expect(result['v2-blackAndWhite']).toBeGreaterThanOrEqual(result['v1-blackAndWhite'] + 0.03);
    expect(result['v2-grayscale']).toBeGreaterThanOrEqual(result['v1-grayscale'] - 0.01);
  });

  it.skipIf(!existsSync(PRIVATE_FRAMES))('real photos (report only)', async () => {
    const truth = JSON.parse(readFileSync(resolve(WEB_ROOT, 'test/fixtures/private/truth.json'), 'utf8'));
    const pick = (process.env.SNAPDRIVE_QUALITY_PAGES ?? '02,08,14,07').split(',');
    for (const file of readdirSync(PRIVATE_FRAMES).sort()) {
      const id = file.slice(0, 2);
      if (!pick.includes(id) || !truth[id]) continue;
      const img = readPNG(resolve(PRIVATE_FRAMES, file));
      const corners: number[][] = truth[id].quad;
      const sx = img.width / (img.width > img.height ? 480 : 360);
      const sy = img.height / (img.width > img.height ? 360 : 480);
      const quad = corners.map(([x, y]) => ({ x: x * sx, y: y * sy })) as Quad;
      const size = outputSize(quad, img.width, img.height, 4200);
      const page = warpPerspective(img, quad, size.width, size.height);
      // Reference text: Tesseract on the deskewed colour page enlarged 2x (its best case).
      const refFile = resolve(OUT, `real${id}-reference.png`);
      writePNG(refFile, page);
      const reference = words(ocr(refFile));
      for (const mode of ['blackAndWhite', 'grayscale'] as ColorMode[]) {
        for (const v of ['v1', 'v2'] as const) {
          const r = await render(page, `real${id}`, mode, v);
          const score = recall(reference, words(ocr(r.file)));
          scores.push(`real${id} ${v} ${mode.padEnd(13)} ${r.width}x${r.height} ${(r.bytes / 1024).toFixed(1).padStart(7)} KB  recall vs colour ${(score * 100).toFixed(1)}%`);
        }
      }
    }
  });

  it('writes the score table', () => {
    writeFileSync(resolve(OUT, 'scores.txt'), scores.join('\n') + '\n');
    console.log('\n' + scores.join('\n'));
  });
});
