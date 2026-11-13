// v2 must not be visibly softer than v1. For every tier and mode, encode v1's own rendered
// pixels (processed-*.png) with the shipped encoder at jpegQuality(tier, mode), and require the
// PSNR against those pixels to reach what ImageIO (v1's encoder) achieved on the same pixels at
// v1's tier quality. The ImageIO references are made on the Mac with
// `sips -s formatOptions <q>` by scripts/fetch-v1-fixtures.sh.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import decode, { init as initDecode } from '@jsquash/jpeg/decode.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { mozjpegEncoder } from '../../src/core/jpeg';
import type { RGBAImage } from '../../src/core/raster';
import { jpegQuality, QUALITY_TIERS } from '../../src/core/types';
import { ensureMozjpeg, hasV1, readPNG, V1_DIR, WEB_ROOT } from './helpers/io';

/** v1's ImageIO quality per tier (ScanTypes.swift). */
const V1_IMAGEIO_QUALITY = { small: 50, balanced: 70, high: 82 } as const;

async function decodeJpeg(bytes: Uint8Array): Promise<RGBAImage> {
  const img = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return { width: img.width, height: img.height, data: img.data };
}

function psnr(a: RGBAImage, b: RGBAImage): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c];
      se += d * d;
      n++;
    }
  }
  return 10 * Math.log10((255 * 255) / (se / n));
}

describe.skipIf(!hasV1())('JPEG fidelity matches v1 (ImageIO) per tier and mode', () => {
  const rows: string[] = [];

  beforeAll(async () => {
    await ensureMozjpeg();
    const wasm = await WebAssembly.compile(
      readFileSync(resolve(WEB_ROOT, 'node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')),
    );
    await (initDecode as unknown as (m: WebAssembly.Module) => Promise<void>)(wasm);
  });

  for (const mode of ['color', 'grayscale'] as const) {
    for (const tier of QUALITY_TIERS) {
      it(`${mode} ${tier}`, async () => {
        const pixels = readPNG(resolve(V1_DIR, `processed-${mode}.png`));
        const iio = new Uint8Array(readFileSync(resolve(V1_DIR, 'imageio', `${mode}-q${V1_IMAGEIO_QUALITY[tier]}.jpg`)));
        const target = psnr(await decodeJpeg(iio), pixels);
        const q = jpegQuality(tier, mode);
        const ours = await mozjpegEncoder(pixels, q, mode === 'grayscale');
        const got = psnr(await decodeJpeg(ours), pixels);
        rows.push(
          `${mode.padEnd(9)} ${tier.padEnd(8)} v1 ${(iio.length / 1024).toFixed(1).padStart(6)} KB ${target.toFixed(2)} dB` +
            `   v2 q${q.toFixed(2)} ${(ours.length / 1024).toFixed(1).padStart(6)} KB ${got.toFixed(2)} dB`,
        );
        expect(got).toBeGreaterThanOrEqual(target);
      });
    }
  }

  it('prints the table', () => {
    console.log(['', ...rows].join('\n'));
  });
});
