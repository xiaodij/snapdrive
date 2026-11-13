// JPEG encoding for page images.
//
// v1 used ImageIO. Here it is mozjpeg compiled to WebAssembly (@jsquash/jpeg), for two
// reasons a canvas `toBlob('image/jpeg')` cannot match:
//
// 1. **True greyscale.** A canvas always writes three-component YCbCr. mozjpeg's GRAYSCALE
//    colour space writes a single-component JPEG, which is what `/DeviceGray` in the PDF
//    claims, and it skips two chroma planes the page would never use.
// 2. **The same encoder on every device.** A canvas encodes with whatever library the browser
//    ships, each with its own quality scale. One encoder means the per-tier qualities in
//    types.ts (calibrated to v1's ImageIO fidelity) hold everywhere.
//
// In the browser the wasm is fetched next to the module (Vite resolves the `new URL(...)`
// inside @jsquash's glue; keep `@jsquash/jpeg` in `optimizeDeps.exclude`). In Node, call
// `initMozjpeg()` with a module compiled from the .wasm file first.

import encode, { init } from '@jsquash/jpeg/encode.js';
import type { RGBAImage } from './raster';

/** quality01 is 0...1; `grayscale` asks for a single-component JPEG. */
export type JpegEncoder = (img: RGBAImage, quality01: number, grayscale: boolean) => Promise<Uint8Array>;

/** mozjpeg colour space enum (see @jsquash/jpeg's MozJpegColorSpace). */
const GRAYSCALE = 1;
const YCBCR = 3;

/**
 * Initialise the encoder from an already-compiled module. Optional in the browser (it
 * fetches the wasm itself on first use); required under Node, where there is no fetch of a
 * relative URL.
 */
export async function initMozjpeg(wasm?: WebAssembly.Module): Promise<void> {
  // The published typings only describe the options-object form of init(); the JS also
  // accepts a precompiled WebAssembly.Module as its first argument.
  const initWith = init as unknown as (module?: WebAssembly.Module) => void | Promise<void>;
  await initWith(wasm);
}

export const mozjpegEncoder: JpegEncoder = async (img, quality01, grayscale) => {
  const imageData = { data: img.data, width: img.width, height: img.height, colorSpace: 'srgb' } as ImageData;
  const buffer = await encode(imageData, {
    quality: Math.round(Math.min(1, Math.max(0, quality01)) * 100),
    color_space: grayscale ? GRAYSCALE : YCBCR,
    // Standard JPEG (Annex K) tables rather than mozjpeg's default (ImageMagick) ones, and
    // progressive scans: calibrated against v1's ImageIO output at equal PSNR, this pair gave
    // the smallest files of every combination tried (colour balanced 296 KB vs 446 KB with the
    // default tables, 324 KB baseline). PDF has accepted progressive DCT since 1.3.
    quant_table: 0,
    progressive: true,
    baseline: false,
    optimize_coding: true,
    // 4:2:0 chroma on colour pages; ignored for greyscale.
    auto_subsample: true,
    chroma_subsample: 2,
  });
  return new Uint8Array(buffer);
};

/** Number of colour components declared in a JPEG's SOF marker (1 = grey, 3 = colour). */
export function jpegComponentCount(jpeg: Uint8Array): number | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    const length = (jpeg[i + 2] << 8) | jpeg[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return jpeg[i + 9];
    }
    i += 2 + length;
  }
  return null;
}
