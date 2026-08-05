import Compression
import Foundation

/// zlib-wrapped DEFLATE, which is what PDF's `/FlateDecode` expects.
///
/// `compression_encode_buffer(COMPRESSION_ZLIB)` emits a *raw* DEFLATE stream with no
/// RFC1950 framing, so we add the 2-byte header and trailing Adler-32 ourselves.
enum Deflate {

    static func zlib(_ input: Data) -> Data? {
        guard !input.isEmpty else { return nil }

        let capacity = input.count + (input.count / 16) + 1024
        var body = Data(count: capacity)

        let written: Int = body.withUnsafeMutableBytes { dst -> Int in
            input.withUnsafeBytes { src -> Int in
                guard let d = dst.bindMemory(to: UInt8.self).baseAddress,
                      let s = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return compression_encode_buffer(d, capacity, s, input.count, nil, COMPRESSION_ZLIB)
            }
        }
        // 0 means "didn't fit" — for our inputs that only happens on incompressible data,
        // where the caller is better off storing the bytes uncompressed anyway.
        guard written > 0 else { return nil }

        var out = Data([0x78, 0x9C])            // CM=deflate, 32K window, default level
        out.append(body.prefix(written))
        let sum = adler32(input)
        out.append(contentsOf: [
            UInt8((sum >> 24) & 0xFF), UInt8((sum >> 16) & 0xFF),
            UInt8((sum >> 8) & 0xFF), UInt8(sum & 0xFF)
        ])
        return out
    }

    static func adler32(_ data: Data) -> UInt32 {
        var a: UInt32 = 1
        var b: UInt32 = 0
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            var i = 0
            // Defer the modulo: 5552 iterations is the most that can't overflow UInt32.
            while i < bytes.count {
                let chunk = min(5552, bytes.count - i)
                for j in i..<(i + chunk) {
                    a &+= UInt32(bytes[j])
                    b &+= a
                }
                a %= 65521
                b %= 65521
                i += chunk
            }
        }
        return (b << 16) | a
    }
}
