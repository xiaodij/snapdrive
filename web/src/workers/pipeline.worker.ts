/// <reference lib="webworker" />
// All pixel work happens here, off the main thread, so the camera view and the review screen
// stay responsive. Core algorithms live in src/core (pure TS, tested under Node); this file
// only adapts them to browser primitives (ImageBitmap, OffscreenCanvas, Blob).
import { detectDocument } from '../core/detect';
import { outputSize, warpPerspective } from '../core/geometry';
import { processPage, ocrInput } from '../core/imageProcessor';
import { mozjpegEncoder } from '../core/jpeg';
import { analyze } from '../core/pageAnalyzer';
import { buildPDF } from '../core/pdfWriter';
import { createRGBA, fitLongEdge, type GrayImage, type Quad, type RGBAImage } from '../core/raster';
import { resizeRGBA, toGray } from '../core/resample';
import { resolveMode, SOURCE_MAX_LONG_EDGE } from '../core/types';
import type { DetectResult, PipelineRequest, PipelineResponse, ProcessResult, RerenderResult, Rotation } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

/** Long edge of the frame the detector sees. */
const DETECT_EDGE = 512;
/** Long edge of the greyscale image handed to Tesseract. */
const OCR_EDGE = 2400;
const PREVIEW_EDGE = 1600;
const THUMB_EDGE = 360;

self.onmessage = async (event: MessageEvent<{ id: number; req: PipelineRequest }>) => {
  const { id, req } = event.data;
  try {
    const { result, transfer } = await handle(req);
    self.postMessage({ id, ok: true, result } satisfies PipelineResponse, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ id, ok: false, error: message } satisfies PipelineResponse);
  }
};

async function handle(req: PipelineRequest): Promise<{ result: unknown; transfer: Transferable[] }> {
  switch (req.type) {
    case 'detect': {
      const found = detectDocument(toGray(req.frame));
      const result: DetectResult = { quad: found?.quad ?? null, confidence: found?.confidence ?? 0 };
      return { result, transfer: [] };
    }
    case 'detectBitmap': {
      const rgba = bitmapToRGBA(req.bitmap);
      req.bitmap.close();
      return { result: detectIn(rgba), transfer: [] };
    }
    case 'process':
      return processCapture(req);
    case 'rerender':
      return rerender(req);
    case 'pdf': {
      const pdf = buildPDF(req.pages, req.title);
      return { result: pdf, transfer: [pdf.buffer] };
    }
  }
}

function detectIn(rgba: RGBAImage): DetectResult {
  const small = fitLongEdge(rgba.width, rgba.height, DETECT_EDGE);
  const scaled = small.width === rgba.width ? rgba : resizeRGBA(rgba, small.width, small.height);
  const found = detectDocument(toGray(scaled));
  if (!found) return { quad: null, confidence: 0 };
  const sx = rgba.width / scaled.width;
  const sy = rgba.height / scaled.height;
  const quad = found.quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
  return { quad, confidence: found.confidence };
}

async function processCapture(req: Extract<PipelineRequest, { type: 'process' }>) {
  const rgba = bitmapToRGBA(req.bitmap);
  req.bitmap.close();

  let autoQuad: Quad | null = null;
  let quad: Quad | null = null;
  if (req.quad === 'auto') {
    autoQuad = detectIn(rgba).quad;
    quad = autoQuad;
  } else {
    quad = req.quad;
  }

  // Deskew. With no quad the whole frame is the page, only capped in size.
  let page: RGBAImage;
  if (quad) {
    const size = outputSize(quad, rgba.width, rgba.height, SOURCE_MAX_LONG_EDGE);
    page = warpPerspective(rgba, quad, size.width, size.height);
  } else {
    const size = fitLongEdge(rgba.width, rgba.height, SOURCE_MAX_LONG_EDGE);
    page = size.width === rgba.width ? rgba : resizeRGBA(rgba, size.width, size.height);
  }
  page = rotate(page, req.rotation);

  const source = await encodeCanvasJpeg(page, 0.92);
  const thumbSize = fitLongEdge(page.width, page.height, THUMB_EDGE);
  const thumb = await encodeCanvasJpeg(resizeRGBA(page, thumbSize.width, thumbSize.height), 0.8);

  const detectedMode = analyze(page).mode;
  const rendered = await processPage(page, resolveMode(req.selection, detectedMode), req.tier, mozjpegEncoder);
  const preview = await previewBlob(rendered.preview);

  let ocrImage: Blob | undefined;
  let ocrWidth: number | undefined;
  let ocrHeight: number | undefined;
  if (req.ocr) {
    const gray = ocrInput(page, OCR_EDGE);
    ocrImage = await encodeCanvasJpeg(grayToRGBA(gray), 0.92);
    ocrWidth = gray.width;
    ocrHeight = gray.height;
  }

  const { preview: _drop, ...renderedPage } = rendered;
  void _drop;
  const result: ProcessResult = {
    width: rgba.width,
    height: rgba.height,
    autoQuad,
    quad,
    source,
    sourceWidth: page.width,
    sourceHeight: page.height,
    thumb,
    detectedMode,
    rendered: renderedPage,
    preview,
    ocrImage,
    ocrWidth,
    ocrHeight,
  };
  return { result, transfer: [renderedPage.data.buffer] };
}

async function rerender(req: Extract<PipelineRequest, { type: 'rerender' }>) {
  const bitmap = await createImageBitmap(req.source);
  const page = bitmapToRGBA(bitmap);
  bitmap.close();
  const detectedMode = req.detectedMode ?? analyze(page).mode;
  const rendered = await processPage(page, resolveMode(req.selection, detectedMode), req.tier, mozjpegEncoder);
  const preview = await previewBlob(rendered.preview);
  const { preview: _drop, ...renderedPage } = rendered;
  void _drop;
  const result: RerenderResult = { detectedMode, rendered: renderedPage, preview };
  return { result, transfer: [renderedPage.data.buffer] };
}

// ── Browser adapters ─────────────────────────────────────────────────────────

function bitmapToRGBA(bitmap: ImageBitmap): RGBAImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot read image pixels (no 2D canvas in workers).');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: data.width, height: data.height, data: data.data };
}

async function encodeCanvasJpeg(img: RGBAImage, quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  // Pixel buffers here are always backed by a plain ArrayBuffer, never a SharedArrayBuffer.
  ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

async function previewBlob(img: RGBAImage): Promise<Blob> {
  const size = fitLongEdge(img.width, img.height, PREVIEW_EDGE);
  const small = size.width === img.width ? img : resizeRGBA(img, size.width, size.height);
  return encodeCanvasJpeg(small, 0.85);
}

function grayToRGBA(gray: GrayImage): RGBAImage {
  const out = createRGBA(gray.width, gray.height);
  const src = gray.data;
  const dst = out.data;
  for (let i = 0, o = 0; i < src.length; i++, o += 4) {
    const v = src[i];
    dst[o] = v;
    dst[o + 1] = v;
    dst[o + 2] = v;
    dst[o + 3] = 255;
  }
  return out;
}

function rotate(img: RGBAImage, rotation: Rotation): RGBAImage {
  if (rotation === 0) return img;
  const { width: w, height: h } = img;
  const turned = rotation === 90 || rotation === 270;
  const out = createRGBA(turned ? h : w, turned ? w : h);
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  const dst = new Uint32Array(out.data.buffer);
  const ow = out.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      let nx: number;
      let ny: number;
      if (rotation === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (rotation === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      dst[ny * ow + nx] = v;
    }
  }
  return out;
}
