import CoreGraphics
import Foundation

/// How a page's image bytes are stored inside the PDF.
enum PDFImageEncoding {
    case jpegRGB        // /DCTDecode, /DeviceRGB,  8 bpc
    case jpegGray       // /DCTDecode, /DeviceGray, 8 bpc
    case flateBilevel   // /FlateDecode, /DeviceGray, 1 bpc
    case rawBilevel     // no filter,   /DeviceGray, 1 bpc  (fallback)

    var colorSpace: String {
        switch self {
        case .jpegRGB: return "/DeviceRGB"
        case .jpegGray, .flateBilevel, .rawBilevel: return "/DeviceGray"
        }
    }

    var bitsPerComponent: Int {
        switch self {
        case .jpegRGB, .jpegGray: return 8
        case .flateBilevel, .rawBilevel: return 1
        }
    }

    var filter: String? {
        switch self {
        case .jpegRGB, .jpegGray: return "/DCTDecode"
        case .flateBilevel: return "/FlateDecode"
        case .rawBilevel: return nil
        }
    }
}

struct PDFPage {
    /// Already-encoded image bytes, written into the PDF stream untouched.
    let imageData: Data
    let encoding: PDFImageEncoding
    let pixelWidth: Int
    let pixelHeight: Int
    /// Physical page size in PDF points (72 per inch).
    let pageSize: CGSize
    let textLines: [RecognizedLine]
}

/// Writes a multi-page PDF with an invisible OCR text layer.
///
/// Written by hand rather than via `UIGraphicsPDFRenderer` for two reasons:
///
/// 1. **No recompression.** Page JPEGs are copied in as `/DCTDecode` streams byte for
///    byte, and bilevel pages stay 1 bit per pixel. Drawing through a CGContext would
///    re-encode everything at Core Graphics' choice of settings, typically inflating a
///    B&W page from ~40 KB to well over a megabyte.
///
/// 2. **Unicode text extraction without embedding a font.** The text layer uses render
///    mode 3 (invisible), so no glyph is ever drawn and the font file is never consulted.
///    Character codes are UTF-16BE code units mapped straight through an identity
///    `/ToUnicode` CMap, which means any script Vision can read — including CJK — extracts
///    correctly in Preview, Acrobat, Spotlight and pdftotext, with nothing embedded.
enum PDFWriter {

    static func makePDF(pages: [PDFPage], title: String?, creationDate: Date = Date()) -> Data {
        var objects: [Data] = []

        /// Reserve an object slot and return its 1-based number.
        func reserve() -> Int {
            objects.append(Data())
            return objects.count
        }
        func put(_ number: Int, _ body: Data) {
            objects[number - 1] = body
        }

        let catalogNo = reserve()
        let pagesNo = reserve()
        let fontNo = reserve()
        let descendantNo = reserve()
        let descriptorNo = reserve()
        let toUnicodeNo = reserve()
        let infoNo = reserve()

        var pageNumbers: [Int] = []
        for page in pages {
            let pageNo = reserve()
            let contentNo = reserve()
            let imageNo = reserve()
            pageNumbers.append(pageNo)

            put(pageNo, ascii("""
                << /Type /Page /Parent \(pagesNo) 0 R \
                /MediaBox [0 0 \(num(page.pageSize.width)) \(num(page.pageSize.height))] \
                /Resources << /XObject << /Im0 \(imageNo) 0 R >> /Font << /F0 \(fontNo) 0 R >> \
                /ProcSet [/PDF /Text /ImageB /ImageC] >> \
                /Contents \(contentNo) 0 R >>
                """))

            let content = contentStream(for: page)
            if let packed = Deflate.zlib(content) {
                put(contentNo, stream(dict: "/Filter /FlateDecode", payload: packed))
            } else {
                put(contentNo, stream(dict: "", payload: content))
            }

            var imageDict = "/Type /XObject /Subtype /Image"
            imageDict += " /Width \(page.pixelWidth) /Height \(page.pixelHeight)"
            imageDict += " /ColorSpace \(page.encoding.colorSpace)"
            imageDict += " /BitsPerComponent \(page.encoding.bitsPerComponent)"
            if let filter = page.encoding.filter { imageDict += " /Filter \(filter)" }
            put(imageNo, stream(dict: imageDict, payload: page.imageData))
        }

        let kids = pageNumbers.map { "\($0) 0 R" }.joined(separator: " ")
        put(catalogNo, ascii("<< /Type /Catalog /Pages \(pagesNo) 0 R >>"))
        put(pagesNo, ascii("<< /Type /Pages /Kids [\(kids)] /Count \(pageNumbers.count) >>"))

        put(fontNo, ascii("""
            << /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H \
            /DescendantFonts [\(descendantNo) 0 R] /ToUnicode \(toUnicodeNo) 0 R >>
            """))
        put(descendantNo, ascii("""
            << /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica \
            /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> \
            /FontDescriptor \(descriptorNo) 0 R /DW 1000 /CIDToGIDMap /Identity >>
            """))
        put(descriptorNo, ascii("""
            << /Type /FontDescriptor /FontName /Helvetica /Flags 4 \
            /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 \
            /CapHeight 700 /StemV 80 >>
            """))
        put(toUnicodeNo, stream(dict: "", payload: identityToUnicodeCMap()))

        var info = "<< /Producer \(textString("Snap")) /Creator \(textString("Snap"))"
        if let title, !title.isEmpty { info += " /Title \(textString(title))" }
        info += " /CreationDate (\(pdfDate(creationDate)))"
        info += " /ModDate (\(pdfDate(creationDate))) >>"
        put(infoNo, ascii(info))

        return serialize(objects: objects, rootNumber: catalogNo, infoNumber: infoNo)
    }

    // MARK: - Page content

    private static func contentStream(for page: PDFPage) -> Data {
        let w = page.pageSize.width
        let h = page.pageSize.height

        var s = ""
        // Stretch the image across the whole MediaBox. `Do` draws an XObject into the
        // unit square, so the CTM does all the scaling.
        s += "q\n\(num(w)) 0 0 \(num(h)) 0 0 cm\n/Im0 Do\nQ\n"

        let runs = page.textLines.filter { !$0.text.isEmpty && $0.boundingBox.width > 0 && $0.boundingBox.height > 0 }
        if !runs.isEmpty {
            s += "BT\n3 Tr\n"    // Tr 3 = render nothing, but stay selectable and searchable
            for line in runs {
                let box = line.boundingBox
                let units = Array(line.text.utf16)
                guard !units.isEmpty else { continue }

                let fontSize = max(1.0, box.height * h)
                let targetWidth = box.width * w
                // Every glyph advances by /DW (1000/1000 em) since no real font is
                // consulted, so horizontal scaling is what makes the invisible run cover
                // the same span as the ink underneath it.
                let naturalWidth = CGFloat(units.count) * fontSize
                let tz = min(1000.0, max(1.0, targetWidth / naturalWidth * 100.0))

                let x = box.minX * w
                let y = box.minY * h

                s += "/F0 \(num(fontSize)) Tf\n"
                s += "\(num(tz)) Tz\n"
                s += "1 0 0 1 \(num(x)) \(num(y)) Tm\n"
                s += "<\(hexUTF16(units))> Tj\n"
            }
            s += "ET\n"
        }
        return ascii(s)
    }

    // MARK: - Serialisation

    private static func serialize(objects: [Data], rootNumber: Int, infoNumber: Int) -> Data {
        var out = Data()
        out.append(ascii("%PDF-1.7\n"))
        // Binary marker so tools treat the file as binary rather than text.
        out.append(Data([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]))

        var offsets: [Int] = []
        for (index, body) in objects.enumerated() {
            offsets.append(out.count)
            out.append(ascii("\(index + 1) 0 obj\n"))
            out.append(body)
            out.append(ascii("\nendobj\n"))
        }

        let xrefOffset = out.count
        out.append(ascii("xref\n0 \(objects.count + 1)\n"))
        out.append(ascii("0000000000 65535 f \n"))
        for offset in offsets {
            out.append(ascii(String(format: "%010d 00000 n \n", offset)))
        }
        out.append(ascii("""
            trailer
            << /Size \(objects.count + 1) /Root \(rootNumber) 0 R /Info \(infoNumber) 0 R >>
            startxref
            \(xrefOffset)
            %%EOF

            """))
        return out
    }

    private static func stream(dict: String, payload: Data) -> Data {
        var out = Data()
        let head = dict.isEmpty ? "<< /Length \(payload.count) >>" : "<< \(dict) /Length \(payload.count) >>"
        out.append(ascii(head + "\nstream\n"))
        out.append(payload)
        out.append(ascii("\nendstream"))
        return out
    }

    /// Maps every 2-byte code straight to the same Unicode scalar.
    ///
    /// Emitted one high-byte range at a time: `bfrange` entries may only vary in their
    /// low byte, and a block holds at most 100 of them.
    private static func identityToUnicodeCMap() -> Data {
        var s = """
            /CIDInit /ProcSet findresource begin
            12 dict begin
            begincmap
            /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
            /CMapName /Adobe-Identity-UCS def
            /CMapType 2 def
            1 begincodespacerange
            <0000> <FFFF>
            endcodespacerange

            """
        var high = 0
        while high < 256 {
            let count = min(100, 256 - high)
            s += "\(count) beginbfrange\n"
            for i in high..<(high + count) {
                let prefix = String(format: "%02X", i)
                s += "<\(prefix)00> <\(prefix)FF> <\(prefix)00>\n"
            }
            s += "endbfrange\n"
            high += count
        }
        s += """
            endcmap
            CMapName currentdict /CMap defineresource pop
            end
            end

            """
        return ascii(s)
    }

    // MARK: - Primitives

    private static func ascii(_ s: String) -> Data {
        s.data(using: .isoLatin1) ?? Data(s.utf8)
    }

    private static func num(_ value: CGFloat) -> String {
        String(format: "%.4f", Double(value))
    }

    private static func hexUTF16(_ units: [UInt16]) -> String {
        units.map { String(format: "%04X", $0) }.joined()
    }

    /// PDF text strings are written as UTF-16BE hex so the file itself stays pure ASCII.
    private static func textString(_ s: String) -> String {
        var units: [UInt16] = [0xFEFF]
        units.append(contentsOf: Array(s.utf16))
        return "<\(hexUTF16(units))>"
    }

    private static func pdfDate(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let offset = TimeZone.current.secondsFromGMT(for: date)
        let sign = offset < 0 ? "-" : "+"
        let absolute = abs(offset)
        return String(
            format: "D:%04d%02d%02d%02d%02d%02d%@%02d'%02d'",
            c.year ?? 2000, c.month ?? 1, c.day ?? 1,
            c.hour ?? 0, c.minute ?? 0, c.second ?? 0,
            sign, absolute / 3600, (absolute % 3600) / 60
        )
    }
}
