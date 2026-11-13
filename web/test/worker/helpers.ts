// Shared harness for the Worker tests: a fake env, a tiny cookie jar, and request helpers
// that call the Worker's fetch handler directly (no wrangler, no network).

import { randomBytes } from 'node:crypto';
import worker from '../../worker/index';
import type { Env } from '../../worker/env';

export const ORIGIN = 'https://snapdrive.xjpc.ca';

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SEAL_KEY: randomBytes(32).toString('base64'),
    MS_CLIENT_ID: 'client-id-123',
    MS_CLIENT_SECRET: 'client-secret-xyz',
    MS_TENANT: 'consumers',
    ...overrides,
  };
}

export interface SetCookie {
  name: string;
  value: string;
  attributes: string;
  cleared: boolean;
}

export function setCookies(response: Response): SetCookie[] {
  return response.headers.getSetCookie().map((raw) => {
    const [pair, ...rest] = raw.split('; ');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const attributes = rest.join('; ');
    return { name, value, attributes, cleared: /Max-Age=0\b/.test(attributes) };
  });
}

/** Minimal browser-ish cookie jar (ignores paths; the tests only use /api routes). */
export class Jar {
  readonly cookies = new Map<string, string>();

  absorb(response: Response): SetCookie[] {
    const list = setCookies(response);
    for (const c of list) {
      if (c.cleared) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return list;
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  jar?: Jar;
  origin?: string;
}

export async function call(env: Env, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.jar && options.jar.cookies.size) headers.set('Cookie', options.jar.header());
  const request = new Request((options.origin ?? ORIGIN) + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ?? null,
    redirect: 'manual',
  });
  const response = await worker.fetch(request, env);
  options.jar?.absorb(response);
  return response;
}

/** A same-origin state-changing call, as the app makes it. */
export function post(env: Env, path: string, body: unknown, jar?: Jar, extra: Record<string, string> = {}): Promise<Response> {
  return call(env, path, {
    method: 'POST',
    headers: { 'X-SnapDrive': '1', Origin: ORIGIN, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? null : JSON.stringify(body),
    jar,
  });
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Replace global fetch with `impl`, recording every call. Restore with vi.unstubAllGlobals(). */
export function recordFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
  const calls: FetchCall[] = [];
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return impl(url, init);
  };
  return { calls, fn };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}
