import { describe, expect, it } from 'vitest';
import { CHUNK_LIMIT, clearChunked, parseCookies, readChunked, writeChunked } from '../../worker/cookies';
import type { CookieOptions } from '../../worker/cookies';
import { base64ToBytes, bytesToBase64Url } from '../../worker/encoding';
import { ConfigError, seal, unseal } from '../../worker/seal';
import { makeEnv } from './helpers';

const key = makeEnv().SEAL_KEY;

describe('seal / unseal', () => {
  it('round-trips a payload', async () => {
    const sealed = await seal(key, 'sd_ms', { rt: 'refresh-token', n: 42 }, 60);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await unseal(key, 'sd_ms', sealed)).toEqual({ rt: 'refresh-token', n: 42 });
  });

  it('rejects a tampered value', async () => {
    const sealed = await seal(key, 'sd_ms', { rt: 'x' }, 60);
    const bytes = base64ToBytes(sealed);
    bytes[bytes.length - 5] ^= 0x01;
    expect(await unseal(key, 'sd_ms', bytesToBase64Url(bytes))).toBeNull();
  });

  it('binds the value to its cookie name (AAD swap fails)', async () => {
    const sealed = await seal(key, 'sd_ms', { key: 're_secret' }, 60);
    expect(await unseal(key, 'sd_rs', sealed)).toBeNull();
  });

  it('rejects an expired value', async () => {
    const now = Date.now();
    const sealed = await seal(key, 'sd_ms', { rt: 'x' }, 60, now);
    expect(await unseal(key, 'sd_ms', sealed, now + 59_000)).toEqual({ rt: 'x' });
    expect(await unseal(key, 'sd_ms', sealed, now + 61_000)).toBeNull();
  });

  it('rejects a value sealed under another key, and garbage', async () => {
    const sealed = await seal(key, 'sd_ms', { rt: 'x' }, 60);
    expect(await unseal(makeEnv().SEAL_KEY, 'sd_ms', sealed)).toBeNull();
    expect(await unseal(key, 'sd_ms', 'not-a-sealed-value')).toBeNull();
    expect(await unseal(key, 'sd_ms', '%%%')).toBeNull();
    expect(await unseal(key, 'sd_ms', '')).toBeNull();
    expect(await unseal(key, 'sd_ms', null)).toBeNull();
  });

  it('refuses a missing or malformed SEAL_KEY', async () => {
    await expect(seal(undefined, 'sd_ms', {}, 60)).rejects.toBeInstanceOf(ConfigError);
    await expect(seal('c2hvcnQ=', 'sd_ms', {}, 60)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('cookie chunking', () => {
  const opts: CookieOptions = { path: '/api', maxAge: 100, sameSite: 'Strict', secure: true };

  it('writes a short value whole and clears stale chunks', () => {
    const existing = parseCookies('sd_ms.0=aaa; sd_ms.1=bbb; other=1');
    const headers = writeChunked(existing, 'sd_ms', 'short', opts);
    expect(headers[0]).toBe('sd_ms=short; Path=/api; Max-Age=100; HttpOnly; SameSite=Strict; Secure');
    expect(headers.slice(1).map((h) => h.split('=')[0])).toEqual(['sd_ms.0', 'sd_ms.1']);
    expect(headers.slice(1).every((h) => h.includes('Max-Age=0'))).toBe(true);
  });

  it('splits a long value, clears the whole cookie and any extra old chunks', () => {
    const value = 'x'.repeat(CHUNK_LIMIT * 2 + 10);
    const existing = parseCookies('sd_ms=old; sd_ms.0=a; sd_ms.1=b; sd_ms.2=c; sd_ms.3=d');
    const headers = writeChunked(existing, 'sd_ms', value, opts);
    const written = headers.filter((h) => !h.includes('Max-Age=0')).map((h) => h.split('=')[0]);
    const cleared = headers.filter((h) => h.includes('Max-Age=0')).map((h) => h.split('=')[0]);
    expect(written).toEqual(['sd_ms.0', 'sd_ms.1', 'sd_ms.2']);
    expect(cleared.sort()).toEqual(['sd_ms', 'sd_ms.3']);
    for (const h of headers) expect(h.length).toBeLessThan(4000);
  });

  it('reads back exactly what was written', () => {
    const value = Array.from({ length: CHUNK_LIMIT * 3 + 7 }, (_, i) => 'abcdefghij'[i % 10]).join('');
    const headers = writeChunked(new Map(), 'sd_ms', value, opts);
    const jar = parseCookies(headers.map((h) => h.split(';')[0]).join('; '));
    expect(readChunked(jar, 'sd_ms')).toBe(value);
    expect(readChunked(parseCookies('sd_ms=whole'), 'sd_ms')).toBe('whole');
    expect(readChunked(parseCookies('other=1'), 'sd_ms')).toBeNull();
  });

  it('clears every shape of a cookie', () => {
    const headers = clearChunked(parseCookies('sd_ms.0=a; sd_ms.1=b'), 'sd_ms', opts);
    expect(headers.map((h) => h.split('=')[0])).toEqual(['sd_ms', 'sd_ms.0', 'sd_ms.1']);
  });
});
