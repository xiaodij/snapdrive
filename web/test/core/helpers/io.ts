// Node-only helpers for the core tests: PNG I/O, mozjpeg init, output folder, tool runner.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { initMozjpeg } from '../../../src/core/jpeg';
import type { GrayImage, RGBAImage } from '../../../src/core/raster';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(here, '../../..');
export const OUT_DIR = resolve(WEB_ROOT, 'test/out');
export const V1_DIR = resolve(WEB_ROOT, 'test/fixtures/v1');
export const PRIVATE_FRAMES = resolve(WEB_ROOT, 'test/fixtures/private/analysis');

export function outPath(name: string): string {
  mkdirSync(OUT_DIR, { recursive: true });
  return resolve(OUT_DIR, name);
}

export function readPNG(path: string): RGBAImage {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export function writePNG(path: string, img: RGBAImage | GrayImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  if (img.data.length === img.width * img.height * 4) {
    png.data = Buffer.from(img.data);
  } else {
    for (let i = 0; i < img.width * img.height; i++) {
      const v = img.data[i];
      png.data[i * 4] = v;
      png.data[i * 4 + 1] = v;
      png.data[i * 4 + 2] = v;
      png.data[i * 4 + 3] = 255;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

let mozjpegReady: Promise<void> | null = null;
/** Compile mozjpeg's wasm off disk once; Node cannot fetch the relative URL the glue uses. */
export function ensureMozjpeg(): Promise<void> {
  if (!mozjpegReady) {
    const wasmPath = resolve(WEB_ROOT, 'node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm');
    mozjpegReady = WebAssembly.compile(readFileSync(wasmPath)).then((m) => initMozjpeg(m));
  }
  return mozjpegReady;
}

/** Run a CLI tool; returns stdout+stderr. Throws with output on non-zero exit. */
export function tool(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`${cmd} ${args.join(' ')} exited ${err.status}:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

export const hasV1 = () => existsSync(resolve(V1_DIR, 'swift-stats.txt'));
export const hasPrivateFrames = () => existsSync(PRIVATE_FRAMES);

/** v1's printed analyser stats, keyed by fixture name. */
export function swiftStats(): Map<string, { mode: string; colour: number; vivid: number; midtone: number; maxTile: number }> {
  const text = readFileSync(resolve(V1_DIR, 'swift-stats.txt'), 'utf8');
  const out = new Map<string, { mode: string; colour: number; vivid: number; midtone: number; maxTile: number }>();
  const re =
    /^(?:PASS|FAIL) (\S+)\s+-> (.+?)\s+\(want .+?\) colour ([\d.]+) vivid ([\d.]+) midtone ([\d.]+) maxTile ([\d.]+)/gm;
  for (const m of text.matchAll(re)) {
    out.set(m[1], {
      mode: m[2].trim(),
      colour: +m[3],
      vivid: +m[4],
      midtone: +m[5],
      maxTile: +m[6],
    });
  }
  return out;
}
