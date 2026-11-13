// Sealed cookie values: AES-256-GCM under SEAL_KEY, with the cookie's name as additional
// authenticated data, so a value lifted from one cookie cannot be replayed as another.
//
// Wire format: base64url( iv[12] || ciphertext+tag ). Plaintext is JSON
// { v: 1, exp: <unix seconds>, d: <payload> }. Anything that fails to decrypt, parse, match the
// version, or is past its expiry is treated as absent — never as an error the caller must handle.

import { base64ToBytes, bytesToBase64Url, utf8 } from './encoding';

const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The Worker is missing or has a malformed secret. Surfaces as a 500 "misconfigured". */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

async function importKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new ConfigError('SEAL_KEY is not set');
  let pending = keyCache.get(secret);
  if (!pending) {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = base64ToBytes(secret.trim());
    } catch {
      throw new ConfigError('SEAL_KEY is not valid base64');
    }
    if (raw.length !== 32) throw new ConfigError('SEAL_KEY must decode to exactly 32 bytes');
    pending = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    keyCache.set(secret, pending);
  }
  return pending;
}

export async function seal(
  secret: string | undefined,
  name: string,
  data: unknown,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = utf8(JSON.stringify({ v: SEAL_VERSION, exp: Math.floor(now / 1000) + ttlSeconds, d: data }));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(name) }, key, plain),
  );
  const out = new Uint8Array(IV_BYTES + cipher.length);
  out.set(iv);
  out.set(cipher, IV_BYTES);
  return bytesToBase64Url(out);
}

export async function unseal<T>(
  secret: string | undefined,
  name: string,
  value: string | null | undefined,
  now: number = Date.now(),
): Promise<T | null> {
  if (!value) return null;
  const key = await importKey(secret); // configuration errors propagate; bad values do not
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length < IV_BYTES + TAG_BYTES) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: utf8(name) },
      key,
      bytes.slice(IV_BYTES),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as { v?: unknown; exp?: unknown; d?: unknown };
    if (!parsed || parsed.v !== SEAL_VERSION || typeof parsed.exp !== 'number') return null;
    if (parsed.exp * 1000 <= now) return null;
    return (parsed.d ?? null) as T | null;
  } catch {
    return null;
  }
}
