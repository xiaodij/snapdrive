// Copies tesseract.js's worker, the LSTM-only WASM cores and the English model into public/,
// so OCR is self-hosted (works offline, no third-party script). Runs before dev and build.
// Only one core variant is downloaded per device (relaxed-SIMD, SIMD or plain, chosen at
// runtime by tesseract.js). The output folders are gitignored: node_modules is the source.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const copies = [
  ['tesseract.js/dist/worker.min.js', 'public/tesseract/worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'public/tesseract/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'public/tesseract/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'public/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'public/tessdata/eng.traineddata.gz'],
];
for (const [from, to] of copies) {
  const src = join(nm, from);
  const dst = join(root, to);
  if (!existsSync(src)) throw new Error(`missing ${src}: run npm install`);
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log(`ocr asset: ${to}`);
}
