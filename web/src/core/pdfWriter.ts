// Port of SnapDrive/Core/PDF/PDFWriter.swift.
//
// Writes a multi-page PDF with an invisible OCR text layer, by hand rather than through a PDF
// library, for two reasons:
//
// 1. **No recompression.** Page JPEGs are copied in as /DCTDecode streams byte for byte, and
//    bilevel pages stay 1 bit per pixel. Drawing through a canvas or a general-purpose PDF
//    library would re-encode everything at its own settings, typically inflating a B&W page
//    from ~40 KB to well over a megabyte.
//
// 2. **Unicode text extraction without embedding a font.** The text layer uses render mode 3
//    (invisible), so no glyph is ever drawn and the font file is never consulted. Character
//    codes are UTF-16BE code units mapped straight through an identity /ToUnicode CMap, so any
//    script OCR can read, including CJK, extracts correctly in Preview, Acrobat, Spotlight and
//    pdftotext with nothing embedded.

import { zlib } from './deflate';
import { pageSize, type PageSize } from './paperSize';
import type { PDFImageEncoding, ProcessedPage, RecognizedLine } from './types';

/** Written into the PDF's /Producer and /Creator fields. */
export const PRODUCER = 'SnapDrive';

export interface PDFPageInput {
  /** Already-encoded image bytes, written into the PDF stream untouched. */
  imageData: Uint8Array;
  encoding: PDFImageEncoding;
  pixelWidth: number;
  pixelHeight: number;
  /** Physical page size in PDF points (72 per inch). */
  pageSize: PageSize;
  textLines: RecognizedLine[];
}

const ENCODING = {
  jpegRGB: { colorSpace: '/DeviceRGB', bpc: 8, filter: '/DCTDecode' },
  jpegGray: { colorSpace: '/DeviceGray', bpc: 8, filter: '/DCTDecode' },
  flateBilevel: { colorSpace: '/DeviceGray', bpc: 1, filter: '/FlateDecode' },
  rawBilevel: { colorSpace: '/DeviceGray', bpc: 1, filter: null },
} as const satisfies Record<PDFImageEncoding, { colorSpace: string; bpc: number; filter: string | null }>;

/** Applies PaperSize to each page and writes the document. */
export function buildPDF(pages: ProcessedPage[], title?: string, creationDate: Date = new Date()): Uint8Array {
  return makePDF(
    pages.map((page) => ({
      imageData: page.data,
      encoding: page.encoding,
      pixelWidth: page.width,
      pixelHeight: page.height,
      pageSize: pageSize(page.width, page.height),
      textLines: page.lines,
    })),
    title,
    creationDate,
  );
}

export function makePDF(pages: PDFPageInput[], title?: string, creationDate: Date = new Date()): Uint8Array {
  const objects: Uint8Array[] = [];

  /** Reserve an object slot and return its 1-based number. */
  const reserve = () => {
    objects.push(new Uint8Array(0));
    return objects.length;
  };
  const put = (n: number, body: Uint8Array) => {
    objects[n - 1] = body;
  };

  const catalogNo = reserve();
  const pagesNo = reserve();
  const fontNo = reserve();
  const descendantNo = reserve();
  const descriptorNo = reserve();
  const toUnicodeNo = reserve();
  const infoNo = reserve();

  const pageNumbers: number[] = [];
  for (const page of pages) {
    const pageNo = reserve();
    const contentNo = reserve();
    const imageNo = reserve();
    pageNumbers.push(pageNo);

    put(
      pageNo,
      ascii(
        `<< /Type /Page /Parent ${pagesNo} 0 R ` +
          `/MediaBox [0 0 ${num(page.pageSize.width)} ${num(page.pageSize.height)}] ` +
          `/Resources << /XObject << /Im0 ${imageNo} 0 R >> /Font << /F0 ${fontNo} 0 R >> ` +
          `/ProcSet [/PDF /Text /ImageB /ImageC] >> ` +
          `/Contents ${contentNo} 0 R >>`,
      ),
    );

    const content = contentStream(page);
    const packed = zlib(content, 9);
    put(contentNo, packed ? stream('/Filter /FlateDecode', packed) : stream('', content));

    const enc = ENCODING[page.encoding];
    let imageDict = '/Type /XObject /Subtype /Image';
    imageDict += ` /Width ${page.pixelWidth} /Height ${page.pixelHeight}`;
    imageDict += ` /ColorSpace ${enc.colorSpace}`;
    imageDict += ` /BitsPerComponent ${enc.bpc}`;
    if (enc.filter) imageDict += ` /Filter ${enc.filter}`;
    put(imageNo, stream(imageDict, page.imageData));
  }

  const kids = pageNumbers.map((n) => `${n} 0 R`).join(' ');
  put(catalogNo, ascii(`<< /Type /Catalog /Pages ${pagesNo} 0 R >>`));
  put(pagesNo, ascii(`<< /Type /Pages /Kids [${kids}] /Count ${pageNumbers.length} >>`));

  put(
    fontNo,
    ascii(
      `<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H ` +
        `/DescendantFonts [${descendantNo} 0 R] /ToUnicode ${toUnicodeNo} 0 R >>`,
    ),
  );
  put(
    descendantNo,
    ascii(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${descriptorNo} 0 R /DW 1000 /CIDToGIDMap /Identity >>`,
    ),
  );
  put(
    descriptorNo,
    ascii(
      `<< /Type /FontDescriptor /FontName /Helvetica /Flags 4 ` +
        `/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 ` +
        `/CapHeight 700 /StemV 80 >>`,
    ),
  );
  put(toUnicodeNo, stream('', identityToUnicodeCMap()));

  let info = `<< /Producer ${textString(PRODUCER)} /Creator ${textString(PRODUCER)}`;
  if (title) info += ` /Title ${textString(title)}`;
  info += ` /CreationDate (${pdfDate(creationDate)})`;
  info += ` /ModDate (${pdfDate(creationDate)}) >>`;
  put(infoNo, ascii(info));

  return serialize(objects, catalogNo, infoNo);
}

// ── Page content ────────────────────────────────────────────────────────────────────────

function contentStream(page: PDFPageInput): Uint8Array {
  const w = page.pageSize.width;
  const h = page.pageSize.height;

  // Stretch the image across the whole MediaBox. `Do` draws an XObject into the unit square,
  // so the CTM does all the scaling.
  let s = `q\n${num(w)} 0 0 ${num(h)} 0 0 cm\n/Im0 Do\nQ\n`;

  const runs = page.textLines.filter((l) => l.text.length > 0 && l.box.width > 0 && l.box.height > 0);
  if (runs.length > 0) {
    s += 'BT\n3 Tr\n'; // Tr 3 = render nothing, but stay selectable and searchable
    for (const line of runs) {
      const units = utf16Units(line.text);
      if (units.length === 0) continue;
      const box = line.box;

      const fontSize = Math.max(1, box.height * h);
      const targetWidth = box.width * w;
      // Every glyph advances by /DW (1000/1000 em) since no real font is consulted, so
      // horizontal scaling is what makes the invisible run cover the same span as the ink.
      const naturalWidth = units.length * fontSize;
      const tz = Math.min(1000, Math.max(1, (targetWidth / naturalWidth) * 100));

      const x = box.x * w;
      const y = box.y * h;

      s += `/F0 ${num(fontSize)} Tf\n`;
      s += `${num(tz)} Tz\n`;
      s += `1 0 0 1 ${num(x)} ${num(y)} Tm\n`;
      s += `<${hexUTF16(units)}> Tj\n`;
    }
    s += 'ET\n';
  }
  return ascii(s);
}

// ── Serialisation ───────────────────────────────────────────────────────────────────────

function serialize(objects: Uint8Array[], rootNumber: number, infoNumber: number): Uint8Array {
  const out = new ByteWriter();
  out.ascii('%PDF-1.7\n');
  // Binary marker so tools treat the file as binary rather than text.
  out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out.ascii(`${index + 1} 0 obj\n`);
    out.bytes(body);
    out.ascii('\nendobj\n');
  });

  const xrefOffset = out.length;
  out.ascii(`xref\n0 ${objects.length + 1}\n`);
  out.ascii('0000000000 65535 f \n');
  for (const offset of offsets) out.ascii(`${String(offset).padStart(10, '0')} 00000 n \n`);
  out.ascii(
    `trailer\n<< /Size ${objects.length + 1} /Root ${rootNumber} 0 R /Info ${infoNumber} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return out.finish();
}

function stream(dict: string, payload: Uint8Array): Uint8Array {
  const head = dict ? `<< ${dict} /Length ${payload.length} >>` : `<< /Length ${payload.length} >>`;
  const w = new ByteWriter();
  w.ascii(`${head}\nstream\n`);
  w.bytes(payload);
  w.ascii('\nendstream');
  return w.finish();
}

/**
 * Maps every 2-byte code straight to the same Unicode code unit.
 *
 * Emitted one high-byte range at a time: `bfrange` entries may only vary in their low byte,
 * and a block holds at most 100 of them.
 */
function identityToUnicodeCMap(): Uint8Array {
  let s =
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\n' +
    'begincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n' +
    '/CMapType 2 def\n' +
    '1 begincodespacerange\n' +
    '<0000> <FFFF>\n' +
    'endcodespacerange\n';
  for (let high = 0; high < 256; ) {
    const count = Math.min(100, 256 - high);
    s += `${count} beginbfrange\n`;
    for (let i = high; i < high + count; i++) {
      const prefix = hex2(i);
      s += `<${prefix}00> <${prefix}FF> <${prefix}00>\n`;
    }
    s += 'endbfrange\n';
    high += count;
  }
  s += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  return ascii(s);
}

// ── Primitives ──────────────────────────────────────────────────────────────────────────

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;
  bytes(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.length;
  }
  ascii(s: string) {
    this.bytes(ascii(s));
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** Latin-1 bytes. Every string written here is ASCII by construction. */
function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function num(v: number): string {
  return v.toFixed(4);
}

function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

function utf16Units(s: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
  return units;
}

function hexUTF16(units: number[]): string {
  return units.map((u) => u.toString(16).toUpperCase().padStart(4, '0')).join('');
}

/** PDF text strings are written as UTF-16BE hex with a BOM, so the file itself stays ASCII. */
function textString(s: string): string {
  return `<${hexUTF16([0xfeff, ...utf16Units(s)])}>`;
}

/** D:YYYYMMDDHHmmSS+HH'mm' in local time. */
function pdfDate(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    `D:${String(date.getFullYear()).padStart(4, '0')}${p2(date.getMonth() + 1)}${p2(date.getDate())}` +
    `${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}` +
    `${sign}${p2(Math.floor(abs / 60))}'${p2(abs % 60)}'`
  );
}
