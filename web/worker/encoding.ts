// base64 / base64url helpers that work the same in Workers and Node.

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts standard base64 or base64url, padded or not. Throws on invalid input. */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBase64Url(byteCount: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  // Copied into a fresh ArrayBuffer: workers-types types encode() as ArrayBufferLike-backed,
  // which WebCrypto's BufferSource parameters reject.
  return new Uint8Array(new TextEncoder().encode(value));
}

/** Length-checked constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
