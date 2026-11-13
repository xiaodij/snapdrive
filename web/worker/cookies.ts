// Cookie parsing and writing, including transparent chunking for values too long for one
// cookie (a sealed Microsoft refresh token can approach the ~4 KB per-cookie limit).
//
// A chunked value is written as name.0, name.1, … and read back by concatenating from .0
// until the first gap. Writing always clears whatever shape (whole or chunked) is now stale.

export interface CookieOptions {
  path: string;
  maxAge: number;
  sameSite: 'Strict' | 'Lax';
  secure: boolean;
}

/** Longest value written into a single cookie before chunking kicks in. */
export const CHUNK_LIMIT = 3800;

/** Plain-HTTP local development, where a Secure cookie would be dropped by Safari. */
export function isLocalDev(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    // When the same name arrives twice (two paths), the most specific path comes first.
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    `SameSite=${options.sameSite}`,
  ];
  if (options.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string, options: CookieOptions): string {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

function chunkIndexes(cookies: Map<string, string>, name: string): number[] {
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
  const found: number[] = [];
  for (const key of cookies.keys()) {
    const match = pattern.exec(key);
    if (match) found.push(Number(match[1]));
  }
  return found.sort((a, b) => a - b);
}

export function readChunked(cookies: Map<string, string>, name: string): string | null {
  const whole = cookies.get(name);
  if (whole) return whole;
  if (!cookies.has(`${name}.0`)) return null;
  let value = '';
  for (let i = 0; cookies.has(`${name}.${i}`); i++) value += cookies.get(`${name}.${i}`);
  return value || null;
}

/** Set-Cookie headers that store `value` under `name`, chunked if needed, clearing stale parts. */
export function writeChunked(
  cookies: Map<string, string>,
  name: string,
  value: string,
  options: CookieOptions,
  limit: number = CHUNK_LIMIT,
): string[] {
  const headers: string[] = [];
  const stale = chunkIndexes(cookies, name);
  if (value.length <= limit) {
    headers.push(serializeCookie(name, value, options));
    for (const i of stale) headers.push(clearCookie(`${name}.${i}`, options));
    return headers;
  }
  const count = Math.ceil(value.length / limit);
  for (let i = 0; i < count; i++) {
    headers.push(serializeCookie(`${name}.${i}`, value.slice(i * limit, (i + 1) * limit), options));
  }
  if (cookies.has(name)) headers.push(clearCookie(name, options));
  for (const i of stale) if (i >= count) headers.push(clearCookie(`${name}.${i}`, options));
  return headers;
}

/** Set-Cookie headers that remove `name` in every shape it currently exists in. */
export function clearChunked(cookies: Map<string, string>, name: string, options: CookieOptions): string[] {
  const headers = [clearCookie(name, options)];
  for (const i of chunkIndexes(cookies, name)) headers.push(clearCookie(`${name}.${i}`, options));
  return headers;
}
