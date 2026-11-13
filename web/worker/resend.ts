// Resend relay.
//
// api.resend.com sends no CORS headers, so the browser cannot call it. The user's own API key
// is validated once, sealed into an HttpOnly cookie on their device, and unsealed per request.
// Nothing is stored here; page JavaScript never holds the key after connecting.

import { clearCookie, isLocalDev, parseCookies, serializeCookie } from './cookies';
import type { CookieOptions } from './cookies';
import type { Env, RequestLog } from './env';
import { declaredTooLarge, empty, json, passthrough, readJson, str } from './http';
import { seal, unseal } from './seal';

const RESEND_API = 'https://api.resend.com';
const USER_AGENT = 'SnapDrive/2';
export const RS_COOKIE = 'sd_rs';
const RS_TTL = 400 * 24 * 60 * 60; // the longest lifetime browsers honour
/** Resend's own cap on an email including base64-encoded attachments. */
export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;

export type ResendAccess = 'full' | 'sending';

interface ResendSession {
  key: string;
  access: ResendAccess;
  keyHint: string;
}

function rsCookie(url: URL): CookieOptions {
  return { path: '/api/resend', maxAge: RS_TTL, sameSite: 'Strict', secure: !isLocalDev(url) };
}

export function keyHint(key: string): string {
  return `re_…${key.slice(-4)}`;
}

async function readSession(request: Request, env: Env): Promise<ResendSession | null> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await unseal<ResendSession>(env.SEAL_KEY, RS_COOKIE, cookies.get(RS_COOKIE));
  return session && typeof session.key === 'string' && session.key ? session : null;
}

function resendHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT, ...extra };
}

// ── POST /api/resend/connect ───────────────────────────────────────────────────────────────

export async function connect(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Expected JSON {"apiKey": "re_…"}.' }, 400);
  }
  const raw = (input as { apiKey?: unknown } | null)?.apiKey;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!/^re_[A-Za-z0-9_-]{8,200}$/.test(key)) {
    return json({ error: 'invalid_key', message: 'That does not look like a Resend API key (they start with re_).' }, 400);
  }

  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/domains`, { headers: resendHeaders(key) });
  } catch {
    return json({ error: 'upstream', status: 0 }, 502);
  }
  log.upstream = response.status;
  const body = await readJson(response);

  let access: ResendAccess;
  let domains: { name: string; status: string }[] | undefined;
  if (response.ok) {
    access = 'full';
    const list = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : [];
    domains = list.map((d) => ({ name: String(d.name ?? ''), status: String(d.status ?? '') })).filter((d) => d.name);
  } else if (response.status === 401 && body?.name === 'restricted_api_key') {
    // A valid key that may only send. It cannot list domains, so the app asks for a From address.
    access = 'sending';
  } else if (response.status >= 500 || response.status === 429) {
    return json({ error: 'upstream', status: response.status, message: str(body?.message) }, 502);
  } else {
    return json({ error: 'invalid_key', message: str(body?.message) ?? `Resend returned ${response.status}.` }, 400);
  }

  const hint = keyHint(key);
  const sealed = await seal(env.SEAL_KEY, RS_COOKIE, { key, access, keyHint: hint } satisfies ResendSession, RS_TTL);
  return json(
    { ok: true, access, keyHint: hint, ...(domains ? { domains } : {}) },
    200,
    [serializeCookie(RS_COOKIE, sealed, rsCookie(url))],
  );
}

// ── GET /api/resend/status ─────────────────────────────────────────────────────────────────

export async function status(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return json({ connected: false });
  return json({ connected: true, access: session.access, keyHint: session.keyHint });
}

// ── GET /api/resend/domains ────────────────────────────────────────────────────────────────

export async function domains(request: Request, env: Env, _url: URL, log: RequestLog): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return json({ error: 'not_connected' }, 401);
  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/domains`, { headers: resendHeaders(session.key) });
  } catch {
    return json({ error: 'upstream', status: 0 }, 502);
  }
  log.upstream = response.status;
  return passthrough(response);
}

// ── POST /api/resend/emails ────────────────────────────────────────────────────────────────

export async function emails(request: Request, env: Env, _url: URL, log: RequestLog): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return json({ error: 'not_connected' }, 401);
  if (declaredTooLarge(request, MAX_EMAIL_BYTES)) return json({ error: 'too_large', max: MAX_EMAIL_BYTES }, 413);

  // Forwarded as bytes without parsing: Resend validates the payload, and parsing a large
  // attachment here would only burn the Worker's CPU budget.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_EMAIL_BYTES) return json({ error: 'too_large', max: MAX_EMAIL_BYTES }, 413);

  const extra: Record<string, string> = { 'Content-Type': 'application/json' };
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey) extra['Idempotency-Key'] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/emails`, { method: 'POST', headers: resendHeaders(session.key, extra), body });
  } catch {
    return json({ error: 'upstream', status: 0 }, 502);
  }
  log.upstream = response.status;
  return passthrough(response);
}

// ── POST /api/resend/disconnect ────────────────────────────────────────────────────────────

export function disconnect(_request: Request, _env: Env, url: URL): Response {
  return empty(204, [clearCookie(RS_COOKIE, rsCookie(url))]);
}
