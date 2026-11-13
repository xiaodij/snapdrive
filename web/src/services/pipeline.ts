// Main-thread client for the pipeline worker.
import type { Quad, RGBAImage } from '../core/raster';
import type { ColorMode, ColorSelection, ProcessedPage, QualityTier } from '../core/types';
import type { DetectResult, PipelineRequest, PipelineResponse, ProcessResult, RerenderResult, Rotation } from '../workers/protocol';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), { type: 'module', name: 'pipeline' });
  worker.onmessage = (e: MessageEvent<PipelineResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    // A crash (often out-of-memory on a huge photo) fails everything in flight; the next call
    // starts a fresh worker.
    const err = new Error(e.message || 'The image worker stopped unexpectedly.');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(req: PipelineRequest, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, req }, transfer);
  });
}

/** Largest decode we attempt; iOS caps canvas area at ~16.7 MP. */
const MAX_DECODE_PIXELS = 16_000_000;

/**
 * Decode a photo with its EXIF orientation applied. Falls back to an <img> element for
 * formats createImageBitmap rejects; HEIC only decodes on Apple browsers.
 */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      bitmap = await createImageBitmap(img);
    } catch {
      throw new Error(
        blob.type.includes('heic') || blob.type.includes('heif')
          ? 'This browser cannot open HEIC photos. Use Safari on iPhone, or export the photo as JPEG.'
          : 'This file could not be opened as an image.',
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const pixels = bitmap.width * bitmap.height;
  if (pixels > MAX_DECODE_PIXELS) {
    const scale = Math.sqrt(MAX_DECODE_PIXELS / pixels);
    const smaller = await createImageBitmap(bitmap, {
      resizeWidth: Math.floor(bitmap.width * scale),
      resizeHeight: Math.floor(bitmap.height * scale),
      resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = smaller;
  }
  return bitmap;
}

export const pipeline = {
  detect(frame: RGBAImage): Promise<DetectResult> {
    return call({ type: 'detect', frame }, [frame.data.buffer]);
  },
  detectBitmap(bitmap: ImageBitmap): Promise<DetectResult> {
    return call({ type: 'detectBitmap', bitmap }, [bitmap]);
  },
  process(
    bitmap: ImageBitmap,
    quad: Quad | 'auto' | null,
    rotation: Rotation,
    selection: ColorSelection,
    tier: QualityTier,
    ocr: boolean,
  ): Promise<ProcessResult> {
    return call({ type: 'process', bitmap, quad, rotation, selection, tier, ocr }, [bitmap]);
  },
  rerender(source: Blob, selection: ColorSelection, tier: QualityTier, detectedMode?: ColorMode): Promise<RerenderResult> {
    return call({ type: 'rerender', source, selection, tier, detectedMode });
  },
  pdf(pages: ProcessedPage[], title: string): Promise<Uint8Array> {
    return call({ type: 'pdf', pages, title });
  },
};
