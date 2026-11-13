// On-device text recognition with tesseract.js (WASM). Nothing leaves the phone except the
// one-time download of a language model.
//
// The engine and the English model are self-hosted (public/tesseract, public/tessdata) so the
// common case works offline after first use. Other languages come from jsDelivr on first use;
// tesseract.js caches every model in IndexedDB.
import { createWorker, OEM, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import { pageSize } from '../core/paperSize';
import type { RecognizedLine } from '../core/types';

let current: { key: string; worker: Promise<TesseractWorker> } | null = null;
let progressListener: ((p: number) => void) | null = null;

function workerFor(langs: string[]): Promise<TesseractWorker> {
  const list = langs.length ? langs : ['eng'];
  const key = list.join('+');
  if (current?.key === key) return current.worker;
  if (current) void current.worker.then((w) => w.terminate()).catch(() => {});
  const englishOnly = key === 'eng';
  const worker = createWorker(list, OEM.LSTM_ONLY, {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/',
    // Omitting langPath makes tesseract.js fetch each language from jsDelivr.
    ...(englishOnly ? { langPath: '/tessdata' } : {}),
    // CSP allows workers from 'self'; a blob: worker URL is unnecessary.
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === 'recognizing text') progressListener?.(m.progress);
    },
  });
  // tesseract.js defaults to single-block segmentation, which silently drops whole regions of a
  // real page (it lost the heading of the e2e invoice). Fully automatic layout analysis is what
  // the tesseract CLI uses and what a scanned page needs.
  const ready = worker.then(async (w) => {
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    return w;
  });
  current = { key, worker: ready };
  ready.catch(() => {
    if (current?.worker === ready) current = null;
  });
  return ready;
}

/** Warm the engine up (downloads core + model) so the first real page is not slow. */
export function preloadOcr(langs: string[]): void {
  void workerFor(langs).catch(() => {});
}

/**
 * Recognise one page image. Boxes come back normalised with a bottom-left origin, the
 * convention the PDF writer expects (Tesseract reports top-left pixels).
 */
export async function recognize(
  image: Blob,
  width: number,
  height: number,
  langs: string[],
  onProgress?: (fraction: number) => void,
  minimumConfidence = 0.3,
): Promise<RecognizedLine[]> {
  const worker = await workerFor(langs);
  progressListener = onProgress ?? null;
  try {
    // Tell Tesseract the real resolution (pixels over the inferred paper size) instead of
    // letting it guess, which it logs as an error and sometimes gets wrong.
    const points = pageSize(width, height);
    const dpi = Math.round((height / points.height) * 72);
    await worker.setParameters({ user_defined_dpi: String(Math.min(600, Math.max(70, dpi))) });
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
    const lines: RecognizedLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const text = line.text.replace(/\s+/g, ' ').trim();
          const confidence = line.confidence / 100;
          if (!text || confidence < minimumConfidence) continue;
          const { x0, y0, x1, y1 } = line.bbox;
          if (x1 <= x0 || y1 <= y0) continue;
          lines.push({
            text,
            confidence,
            box: {
              x: x0 / width,
              y: 1 - y1 / height,
              width: (x1 - x0) / width,
              height: (y1 - y0) / height,
            },
          });
        }
      }
    }
    return lines;
  } finally {
    progressListener = null;
  }
}
