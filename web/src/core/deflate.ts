// zlib-wrapped DEFLATE (RFC 1950), which is what PDF's /FlateDecode expects.
//
// v1 had to add the zlib header and Adler-32 by hand around Apple's raw DEFLATE. fflate
// writes the complete zlib stream itself, synchronously, and at level 9 squeezes 1-bit text
// pages noticeably harder than the platform default.

import { zlibSync } from 'fflate';

/** Returns null for empty input, mirroring v1, so callers store nothing rather than a header. */
export function zlib(input: Uint8Array, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 9): Uint8Array | null {
  if (input.length === 0) return null;
  return zlibSync(input, { level });
}
