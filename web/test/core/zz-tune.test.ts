// Local tuning aid (skipped unless SNAPDRIVE_TUNE=1): deskew the private photos with their
// hand-marked corners and report what the page analyser decides for each.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { outputSize, warpPerspective } from '../../src/core/geometry';
import { analyze } from '../../src/core/pageAnalyzer';
import type { Quad } from '../../src/core/raster';
import { resizeRGBA } from '../../src/core/resample';
import { PRIVATE_FRAMES, readPNG, writePNG, WEB_ROOT } from './helpers/io';

test.skipIf(!process.env.SNAPDRIVE_TUNE)('real-page analyser decisions', () => {
  const truth = JSON.parse(readFileSync(resolve(WEB_ROOT, 'test/fixtures/private/truth.json'), 'utf8'));
  const rows: string[] = [];
  for (const file of readdirSync(PRIVATE_FRAMES).sort()) {
    const id = file.slice(0, 2);
    const t = truth[id];
    if (!t) continue;
    const img = readPNG(resolve(PRIVATE_FRAMES, file));
    const corners: number[][] = t.corners ?? t.quad ?? t;
    const s = img.width / 360 > img.height / 480 ? img.width / Math.min(360, 480) : img.height / 480;
    const sx = img.width / (img.width > img.height ? 480 : 360);
    const sy = img.height / (img.width > img.height ? 360 : 480);
    void s;
    const quad = corners.map(([x, y]) => ({ x: x * sx, y: y * sy })) as Quad;
    const size = outputSize(quad, img.width, img.height, 2400);
    const page = warpPerspective(img, quad, size.width, size.height);
    const { mode, stats } = analyze(page);
    const small = resizeRGBA(page, Math.round(page.width * 500 / page.height), 500);
    writePNG(resolve(WEB_ROOT, `test/out/tune/${id}.png`), small);
    if (process.env.SNAPDRIVE_TUNE_GRID?.split(',').includes(id)) {
      const g = stats.tileMidtones.map((v) => (v > 0.3 ? String(Math.min(9, Math.floor(v * 10))) : '.'));
      for (let r = 0; r < 10; r++) console.log(`   ${id} ${g.slice(r * 10, r * 10 + 10).join(' ')}`);
    }
    rows.push(`${id} ${mode.padEnd(13)} col ${stats.coloredFraction.toFixed(3)} viv ${stats.vividFraction.toFixed(3)} mid ${stats.midtoneFraction.toFixed(3)} maxTile ${stats.maxTileMidtone.toFixed(3)} hot ${stats.tileMidtones.filter((v) => v > 0.3).length}`);
  }
  writeFileSync(resolve(WEB_ROOT, 'test/out/tune/stats.txt'), rows.join('\n'));
  console.log(rows.join('\n'));
});
