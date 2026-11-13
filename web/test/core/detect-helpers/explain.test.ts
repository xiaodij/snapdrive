// Dev tool, skipped unless asked for: prints what the detector saw for one frame and writes
// its smoothed and edge images to test/out/explain/.
//
//   ID=07 npx vitest run test/core/detect-helpers/explain.test.ts --disableConsoleIntercept
//   SYN=13 npx vitest run test/core/detect-helpers/explain.test.ts --disableConsoleIntercept
//   bash test/core/detect-helpers/why.sh 15 16      (winner vs the candidate nearest the truth)
//
// ID = a private real frame (test/fixtures/private/frames/ID.png); SYN = a synthetic case.
// TRUTH='[[x,y],...]' adds the candidates nearest that quad.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { detectDocument, setDetectTrace, type DetectTrace } from '../../../src/core/detect';
import type { Point } from '../../../src/core/raster';
import { readPNG, toGray, writePNG } from './io';
import { makeCase } from './synth';

const id = process.env.ID;
const syn = process.env.SYN;
const path = join(__dirname, '../../fixtures/private/frames', `${id}.png`);

const fmt = (q: Point[]): string => q.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');

it.skipIf(!syn && (!id || !existsSync(path)))('explain', () => {
  const outDir = join(__dirname, '../../out/explain');
  mkdirSync(outDir, { recursive: true });
  const c = syn ? makeCase(Number(syn)) : null;
  if (c) console.log('truth', fmt(c.truth));
  let t: DetectTrace | null = null;
  setDetectTrace((tr) => (t = tr));
  const r = detectDocument(c ? c.gray : toGray(readPNG(path)));
  setDetectTrace(null);
  const tr = t as DetectTrace | null;
  if (!tr) return;

  if (tr.smooth && tr.edges) {
    const n = tr.width * tr.height;
    const a = new Uint8ClampedArray(n * 4);
    const b = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = tr.smooth[i];
      b[i * 4] = b[i * 4 + 1] = b[i * 4 + 2] = tr.edges[i] ? 255 : 0;
      a[i * 4 + 3] = b[i * 4 + 3] = 255;
    }
    writePNG(join(outDir, `${syn ?? id}-smooth.png`), { width: tr.width, height: tr.height, data: a });
    writePNG(join(outDir, `${syn ?? id}-edges.png`), { width: tr.width, height: tr.height, data: b });
  }
  console.log('lines:', (tr.lines ?? []).map((l) => `${l.border ? 'B' : ''}${l.theta.toFixed(1)}/${l.rho.toFixed(0)}/${l.votes}`).join(' '));
  const sides = (cand: NonNullable<DetectTrace['candidates']>[number]): string =>
    cand.sides.map((sd) => (sd.border ? 'B' : 'L') + sd.support.toFixed(2)).join(',');
  const cands = tr.candidates ?? [];
  for (const cand of cands.slice(0, 3)) console.log('top', cand.score.toFixed(3), cand.support.toFixed(3), sides(cand), fmt(cand.corners));

  const truth: Point[] | null = c ? c.truth : process.env.TRUTH ? JSON.parse(process.env.TRUTH).map(([x, y]: number[]) => ({ x, y })) : null;
  if (truth) {
    // Max corner distance under the best cyclic matching (candidates aren't ordered TL-first).
    const dist = (q: Point[]): number => {
      let best = Infinity;
      for (let rot = 0; rot < 4; rot++)
        for (const dir of [1, -1]) {
          let d = 0;
          for (let i = 0; i < 4; i++) {
            const p = q[(rot + dir * i + 8) % 4];
            d = Math.max(d, Math.hypot(p.x - truth[i].x, p.y - truth[i].y));
          }
          best = Math.min(best, d);
        }
      return best;
    };
    const ranked = cands.map((cand, i) => ({ cand, i, d: dist(cand.corners) })).sort((a, b) => a.d - b.d).slice(0, 3);
    for (const { cand, i, d } of ranked)
      console.log(`near-truth rank ${i} maxdist ${d.toFixed(1)} score ${cand.score.toFixed(3)} support ${cand.support.toFixed(3)} sides ${sides(cand)} ${fmt(cand.corners)}`);
  }
  console.log('result', JSON.stringify(r));
});
