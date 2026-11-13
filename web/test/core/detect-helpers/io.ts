// PNG in/out, quad drawing and error metrics for the detector tests.

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { orderQuad } from '../../../src/core/geometry';
import type { GrayImage, Quad, RGBAImage } from '../../../src/core/raster';

export function readPNG(path: string): RGBAImage {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function writePNG(path: string, img: RGBAImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(path, PNG.sync.write(png));
}

export function toGray(img: RGBAImage): GrayImage {
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = Math.round(0.2126 * img.data[j] + 0.7152 * img.data[j + 1] + 0.0722 * img.data[j + 2]);
  }
  return { width: img.width, height: img.height, data: out };
}

export function grayToRGBA(g: GrayImage): RGBAImage {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g.data[i];
    out[i * 4 + 3] = 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/** Per-corner distances as a fraction of the image diagonal (corners matched after ordering). */
export function cornerErrors(found: Quad, truth: Quad, w: number, h: number): number[] {
  const a = orderQuad(found);
  const b = orderQuad(truth);
  const diag = Math.hypot(w, h);
  return a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) / diag);
}

export function drawQuad(img: RGBAImage, q: Quad, rgb: [number, number, number], thickness = 1): void {
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2) + 1;
    for (let s = 0; s <= steps; s++) {
      const x = a.x + ((b.x - a.x) * s) / steps;
      const y = a.y + ((b.y - a.y) * s) / steps;
      for (let dy = -thickness + 1; dy < thickness; dy++)
        for (let dx = -thickness + 1; dx < thickness; dx++) {
          const xx = Math.round(x - 0.5) + dx;
          const yy = Math.round(y - 0.5) + dy;
          if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
          const o = (yy * img.width + xx) * 4;
          img.data[o] = rgb[0];
          img.data[o + 1] = rgb[1];
          img.data[o + 2] = rgb[2];
          img.data[o + 3] = 255;
        }
    }
  }
}
