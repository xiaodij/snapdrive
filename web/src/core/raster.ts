// Plain pixel buffers. Structurally compatible with the DOM's ImageData, so a real ImageData
// can be passed wherever an RGBAImage is expected, and these can be built in Node tests.

/** 8-bit RGBA, row-major, top-left origin, 4 bytes per pixel. Alpha is ignored by the pipeline. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 8-bit single channel, row-major, top-left origin. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Float single channel on 0...1, used for intermediate filter stages. */
export interface FloatImage {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A page outline in source pixel coordinates, always ordered
 * top-left, top-right, bottom-right, bottom-left (as seen in the upright image).
 */
export type Quad = [Point, Point, Point, Point];

export function createRGBA(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Uint8Array(width * height) };
}

export function createFloat(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height) };
}

/** Scale (w, h) so the long edge is at most `maxEdge`. Never scales up. */
export function fitLongEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Rec. 709 luma, the weights v1 used throughout. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;
