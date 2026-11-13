// Document detection: synthetic scenes with exact corners, plus (when present on this
// machine) real phone photos with hand-annotated corners. The real photos are private and
// gitignored, so that half of the suite skips itself elsewhere.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectDocument } from '../../src/core/detect';
import { fullFrameQuad } from '../../src/core/geometry';
import type { Quad } from '../../src/core/raster';
import { cornerErrors, drawQuad, grayToRGBA, readPNG, toGray, writePNG } from './detect-helpers/io';
import { makeCase } from './detect-helpers/synth';

const PRIVATE = join(__dirname, '../fixtures/private');
const OUT = join(__dirname, '../out/detect');

describe('detectDocument — synthetic scenes', () => {
  const cases = Array.from({ length: 40 }, (_, i) => makeCase(i));

  it('finds the page within 2% of the diagonal on average', () => {
    mkdirSync(OUT, { recursive: true });
    const rows: string[] = [];
    const means: number[] = [];
    const failures: string[] = [];
    for (const c of cases) {
      const found = detectDocument(c.gray);
      const quad: Quad = found?.quad ?? fullFrameQuad(c.gray.width, c.gray.height);
      const errs = cornerErrors(quad, c.truth, c.gray.width, c.gray.height);
      const mean = errs.reduce((a, b) => a + b, 0) / 4;
      means.push(mean);
      const ok = mean < 0.02;
      if (!ok) failures.push(c.name);
      rows.push(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(30)} mean ${(mean * 100).toFixed(2)}%  max ${(Math.max(...errs) * 100).toFixed(2)}%  conf ${found ? found.confidence.toFixed(2) : 'null'}`);
      if (!ok) {
        const img = grayToRGBA(c.gray);
        drawQuad(img, c.truth, [0, 255, 0]);
        drawQuad(img, quad, [255, 0, 0]);
        writePNG(join(OUT, `${c.name}.png`), img);
      }
    }
    const overall = means.reduce((a, b) => a + b, 0) / means.length;
    console.log(rows.join('\n'));
    console.log(`synthetic: ${cases.length - failures.length}/${cases.length} under 2%, overall mean ${(overall * 100).toFixed(2)}%`);
    if (failures.length) console.log(`failures: ${failures.join(', ')}`);
    expect(overall).toBeLessThan(0.02);
    expect(failures.length).toBeLessThanOrEqual(Math.floor(cases.length * 0.1));
  });

  it('runs fast enough for a live camera view', () => {
    const t0 = performance.now();
    let runs = 0;
    for (const c of cases.slice(0, 20)) {
      detectDocument(c.gray);
      runs++;
    }
    const ms = (performance.now() - t0) / runs;
    console.log(`detect: ${ms.toFixed(1)} ms per 480px frame`);
    expect(ms).toBeLessThan(60);
  });

  it('returns null on a frame with no page', () => {
    const w = 360;
    const h = 480;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 90 + 20 * Math.sin(x * 0.07) + 10 * Math.sin(y * 0.031);
    expect(detectDocument({ width: w, height: h, data })).toBeNull();
  });

  it('maps coordinates back when given a large frame', () => {
    const c = makeCase(2);
    // Upscale 3x by pixel replication: the answer should scale with it.
    const s = 3;
    const W = c.gray.width * s;
    const H = c.gray.height * s;
    const big = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) big[y * W + x] = c.gray.data[((y / s) | 0) * c.gray.width + ((x / s) | 0)];
    const found = detectDocument({ width: W, height: H, data: big });
    expect(found).not.toBeNull();
    const truth = c.truth.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
    const errs = cornerErrors(found!.quad, truth, W, H);
    expect(Math.max(...errs)).toBeLessThan(0.03);
  });
});

const truthPath = join(PRIVATE, 'truth.json');
const havePrivate = existsSync(truthPath) && existsSync(join(PRIVATE, 'frames'));

describe.skipIf(!havePrivate)('detectDocument — real phone photos (private, local only)', () => {
  it('matches hand-annotated corners within 3% of the diagonal', () => {
    const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, { quad: number[][]; alternatives?: number[][][]; note?: string }>;
    const overlays = join(PRIVATE, 'overlays');
    mkdirSync(overlays, { recursive: true });
    const rows: string[] = [];
    let pass = 0;
    let total = 0;
    let ms = 0;
    for (const [id, t] of Object.entries(truth)) {
      if (id.startsWith('_')) continue;
      const img = readPNG(join(PRIVATE, 'frames', `${id}.png`));
      const gray = toGray(img);
      const t0 = performance.now();
      const found = detectDocument(gray);
      ms += performance.now() - t0;
      const quad: Quad = found?.quad ?? fullFrameQuad(img.width, img.height);
      // Stacks of paper have more than one right answer (top sheet, or the whole pile):
      // score against whichever annotation the detection is closest to.
      const options = [t.quad, ...(t.alternatives ?? [])].map((q) => q.map(([x, y]) => ({ x, y })) as Quad);
      let tq = options[0];
      let errs = cornerErrors(quad, tq, img.width, img.height);
      for (const o of options.slice(1)) {
        const e = cornerErrors(quad, o, img.width, img.height);
        if (Math.max(...e) < Math.max(...errs)) {
          tq = o;
          errs = e;
        }
      }
      const max = Math.max(...errs);
      const ok = max < 0.03;
      total++;
      if (ok) pass++;
      rows.push(`${ok ? 'PASS' : 'FAIL'} ${id}  max ${(max * 100).toFixed(2)}%  mean ${((errs.reduce((a, b) => a + b, 0) / 4) * 100).toFixed(2)}%  conf ${found ? found.confidence.toFixed(2) : 'null'}  ${t.note ?? ''}`);
      if (process.env.DETAIL) rows.push(`      got ${quad.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}  want ${tq.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}  err ${errs.map((e) => (e * 100).toFixed(1)).join('/')}`);
      drawQuad(img, tq, [0, 255, 0]);
      drawQuad(img, quad, [255, 0, 0], 2);
      writePNG(join(overlays, `${id}.png`), img);
    }
    console.log(rows.join('\n'));
    console.log(`real photos: ${pass}/${total} pass, ${(ms / total).toFixed(1)} ms per frame`);
    expect(pass).toBeGreaterThanOrEqual(Math.min(total, 15));
  });
});
