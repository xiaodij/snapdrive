import { writeFileSync } from 'node:fs';
import { unzlibSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { zlib } from '../../src/core/deflate';
import { processPage, type ProcessOutput } from '../../src/core/imageProcessor';
import { mozjpegEncoder } from '../../src/core/jpeg';
import { pageSize, paperName } from '../../src/core/paperSize';
import { buildPDF, makePDF } from '../../src/core/pdfWriter';
import { COLOR_MODES, type ColorMode, type ProcessedPage, type RecognizedLine } from '../../src/core/types';
import { ensureMozjpeg, outPath, tool } from './helpers/io';
import { bodyLineBoxes, makePage } from './helpers/synthetic';

const renders = new Map<ColorMode, ProcessOutput>();
let lines: RecognizedLine[];

beforeAll(async () => {
  await ensureMozjpeg();
  const page = makePage({ width: 2550, height: 3300, shadow: true, colorAccent: false, grayPhoto: false });
  lines = bodyLineBoxes(2550, 3300);
  for (const mode of COLOR_MODES) renders.set(mode, await processPage(page, mode, 'balanced', mozjpegEncoder));
});

const asPage = (r: ProcessOutput, l: RecognizedLine[]): ProcessedPage => ({ ...r, detectedMode: r.mode, lines: l });

function write(name: string, pdf: Uint8Array): string {
  const path = outPath(name);
  writeFileSync(path, pdf);
  return path;
}

/** The checks every PDF gets: strict parse, page info, renders. */
function validate(path: string) {
  const check = tool('qpdf', ['--check', path]);
  expect(check).toMatch(/No syntax or stream encoding errors found/);
  const info = tool('pdfinfo', [path]);
  tool('pdftoppm', ['-r', '20', '-png', '-singlefile', path, path.replace(/\.pdf$/, '-render')]);
  return info;
}

describe('PDF assembly', () => {
  for (const mode of COLOR_MODES) {
    it(`single page, ${mode}`, () => {
      const r = renders.get(mode)!;
      const pdf = buildPDF([asPage(r, lines)], `SnapDrive test — ${mode}`);
      const path = write(`test-${mode}.pdf`, pdf);
      const info = validate(path);
      expect(info).toMatch(/Page size:\s+612 x 792 pts \(letter\)/);
      expect(info).toMatch(/Title:\s+SnapDrive test — /);
      expect(info).toMatch(/Producer:\s+SnapDrive/);

      const text = tool('pdftotext', ['-layout', path, '-']);
      for (const probe of ['INVOICE 2026-0814', 'Calgary', '723.98', 'Subtotal']) expect(text).toContain(probe);

      const images = tool('pdfimages', ['-list', path]);
      const row = images.split('\n')[2].trim().split(/\s+/);
      // page num type width height color comp bpc enc ...
      const [, , , width, height, color, comp, bpc, enc] = row;
      expect([+width, +height]).toEqual([r.width, r.height]);
      if (mode === 'color') expect([color, comp, bpc, enc]).toEqual(['rgb', '3', '8', 'jpeg']);
      if (mode === 'grayscale') expect([color, comp, bpc, enc]).toEqual(['gray', '1', '8', 'jpeg']);
      if (mode === 'blackAndWhite') expect([color, comp, bpc, enc]).toEqual(['gray', '1', '1', 'image']);
      console.log(`${mode.padEnd(14)} ${(pdf.length / 1024).toFixed(1)} KB  ${color}/${comp}/${bpc}/${enc}`);
    });
  }

  it('3-page mixed', () => {
    const pages = COLOR_MODES.map((m) => asPage(renders.get(m)!, lines));
    const pdf = buildPDF(pages, 'SnapDrive multi-page test');
    const path = write('test-multipage.pdf', pdf);
    const info = validate(path);
    expect(info).toMatch(/Pages:\s+3/);
    const images = tool('pdfimages', ['-list', path]).split('\n').slice(2).filter(Boolean);
    expect(images.map((r) => r.trim().split(/\s+/)[5])).toEqual(['rgb', 'gray', 'gray']);
    const pageTexts = [1, 2, 3].map((p) => tool('pdftotext', ['-f', `${p}`, '-l', `${p}`, path, '-']));
    for (const t of pageTexts) expect(t).toContain('Total due');
    console.log(`3-page mixed   ${(pdf.length / 1024).toFixed(1)} KB  (v1: 589.4 KB)`);
  });

  it('unicode text layer (CJK + accented)', () => {
    const cjk: RecognizedLine[] = [
      { text: '发票编号 2026-0814', box: { x: 0.1, y: 0.8, width: 0.5, height: 0.02 }, confidence: 0.9 },
      { text: '卡尔加里市 阿尔伯塔省', box: { x: 0.1, y: 0.76, width: 0.6, height: 0.02 }, confidence: 0.9 },
      { text: 'Grüße — naïve café', box: { x: 0.1, y: 0.72, width: 0.4, height: 0.02 }, confidence: 0.9 },
    ];
    const pdf = buildPDF([asPage(renders.get('blackAndWhite')!, cjk)], '中文测试');
    const path = write('test-unicode.pdf', pdf);
    const info = validate(path);
    expect(info).toMatch(/Title:\s+中文测试/);
    // -raw keeps content-stream order. pdftotext's default reflow breaks a CJK run from the
    // Latin that follows it onto separate lines; v1's own PDF does exactly the same.
    const text = tool('pdftotext', ['-raw', path, '-']);
    for (const l of cjk) expect(text).toContain(l.text);
  });

  it('page with no text layer is still valid', () => {
    const pdf = buildPDF([asPage(renders.get('grayscale')!, [])]);
    validate(write('test-notext.pdf', pdf));
  });

  it('raw (unfiltered) bilevel fallback is valid', () => {
    const r = renders.get('blackAndWhite')!;
    const raw = unzlibSync(r.data);
    const pdf = makePDF([
      {
        imageData: raw,
        encoding: 'rawBilevel',
        pixelWidth: r.width,
        pixelHeight: r.height,
        pageSize: pageSize(r.width, r.height),
        textLines: [],
      },
    ]);
    const path = write('test-rawbilevel.pdf', pdf);
    validate(path);
    const row = tool('pdfimages', ['-list', path]).split('\n')[2].trim().split(/\s+/);
    expect(row.slice(5, 8)).toEqual(['gray', '1', '1']);
  });

  it('xref offsets point at their objects', () => {
    const pdf = buildPDF([asPage(renders.get('blackAndWhite')!, lines)], 'xref');
    const text = new TextDecoder('latin1').decode(pdf);
    const startxref = +text.slice(text.lastIndexOf('startxref') + 10).trim().split('\n')[0];
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = text.slice(startxref).split('\n').slice(3).filter((l) => / n $/.test(l));
    entries.forEach((entry, i) => {
      const offset = +entry.slice(0, 10);
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });
});

describe('deflate', () => {
  it('writes zlib (RFC 1950) that round-trips', () => {
    const input = new Uint8Array(10000).map((_, i) => (i * 7) % 13);
    const z = zlib(input)!;
    expect(z[0]).toBe(0x78);
    expect(((z[0] << 8) | z[1]) % 31).toBe(0);
    expect(Array.from(unzlibSync(z))).toEqual(Array.from(input));
    expect(zlib(new Uint8Array(0))).toBeNull();
  });
});

describe('paper size', () => {
  it('matches common papers and falls back to an 11-inch long edge', () => {
    expect(pageSize(2550, 3300)).toEqual({ width: 612, height: 792 });
    expect(pageSize(3300, 2550)).toEqual({ width: 792, height: 612 });
    expect(paperName(2480, 3508)).toBe('A4');
    expect(paperName(2550, 4200)).toBe('Legal');
    const receipt = pageSize(800, 3000);
    expect(receipt.height).toBe(792);
    expect(receipt.width).toBeCloseTo(792 * (800 / 3000), 6);
    expect(pageSize(0, 10)).toEqual({ width: 612, height: 792 });
  });
});
