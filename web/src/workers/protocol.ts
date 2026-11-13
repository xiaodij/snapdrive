import type { RGBAImage, Quad } from '../core/raster';
import type { ColorMode, ColorSelection, ProcessedPage, QualityTier, RenderedPage } from '../core/types';

export type Rotation = 0 | 90 | 180 | 270;

export type PipelineRequest =
  /** Live camera: find the page in a small RGBA frame. Quad comes back in frame pixels. */
  | { type: 'detect'; frame: RGBAImage }
  /** Find the page in a decoded photo. Quad in bitmap pixels. */
  | { type: 'detectBitmap'; bitmap: ImageBitmap }
  /** Capture → deskewed source page → rendered page (+ OCR input). */
  | {
      type: 'process';
      bitmap: ImageBitmap;
      /** 'auto' runs detection; null means the whole frame. */
      quad: Quad | 'auto' | null;
      rotation: Rotation;
      selection: ColorSelection;
      tier: QualityTier;
      ocr: boolean;
    }
  /** Colour-mode or quality change: re-render from the stored source page; OCR is kept. */
  | { type: 'rerender'; source: Blob; selection: ColorSelection; tier: QualityTier; detectedMode?: ColorMode }
  | { type: 'pdf'; pages: ProcessedPage[]; title: string };

export interface DetectResult {
  quad: Quad | null;
  confidence: number;
}

export interface ProcessResult {
  /** Size of the decoded capture the quad refers to. */
  width: number;
  height: number;
  autoQuad: Quad | null;
  quad: Quad | null;
  source: Blob;
  sourceWidth: number;
  sourceHeight: number;
  thumb: Blob;
  detectedMode: ColorMode;
  rendered: RenderedPage;
  preview: Blob;
  ocrImage?: Blob;
  ocrWidth?: number;
  ocrHeight?: number;
}

export interface RerenderResult {
  detectedMode: ColorMode;
  rendered: RenderedPage;
  preview: Blob;
}

export type PipelineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
