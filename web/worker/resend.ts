// Resend relay.
//
// api.resend.com sends no CORS headers, so the browser cannot call it. A user connects their
// Resend account one of two ways, and either way the credential is sealed into an HttpOnly
// cookie on their own device; nothing is stored here and page JavaScript never holds it:
//
//   1. OAuth (preferred, no copying): /api/resend/login sends them to Resend's consent screen
//      and /api/resend/callback seals the resulting grant. SnapDrive is a confidential client
//      (client_secret_basic) asking only for `emails:send`.
//   2. An API key pasted into the app (/api/resend/connect), kept as the fallback.

import { clearChunked, clearCookie, isLocalDev, parseCookies, readChunked, serializeCookie, writeChunked } from './cookies';
import type { CookieOptions } from './cookies';
import { bytesToBase64Url, randomBase64Url, timingSafeEqual, utf8 } from './encoding';
import type { Env, RequestLog } from './env';
import {
  declaredTooLarge,
  empty,
  firstLine,
  json,
  passthrough,
  readJson,
  redirect,
  safeReturnPath,
  str,
  withCookies,
  withResult,
} from './http';
import { seal, unseal } from './seal';

const RESEND_API = 'https://api.resend.com';
const USER_AGENT = 'SnapDrive/2';
export const RS_COOKIE = 'sd_rs';
export const RS_OAUTH_COOKIE = 'sd_rsoauth';
const RS_TTL = 400 * 24 * 60 * 60; // API keys: the longest lifetime browsers honour
const RS_GRANT_TTL = 60 * 24 * 60 * 60; // OAuth: Resend refresh tokens live 60 days from last issue
const RS_OAUTH_TTL = 600; // 10 minutes to finish connecting
/** Least privilege: SnapDrive only ever sends. Listing domains would need `full_access`. */
export const RESEND_SCOPE = 'emails:send';
/** Refresh when the access token (900 s) has less than this left. */
const REFRESH_MARGIN_MS = 60_000;
/** Resend's own cap on an email including base64-encoded attachments. */
export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;

export type ResendAccess = 'full' | 'sending';

interface KeySession {
  method?: 'key';
  key: string;
  access: ResendAccess;
  keyHint: string;
}

interface OAuthSession {
  method: 'oauth';
  rt: string;
  at: string;
  /** Unix milliseconds. */
  atExp: number;
  access: ResendAccess;
  keyHint: string;
}

type ResendSession = KeySession | OAuthSession;

interface OAuthState {
  state: string;
  verifier: string;
  return: string;
}

const EXPIRED_MESSAGE = 'The Resend connection expired. Connect again.';

function rsCookie(url: URL, maxAge = RS_TTL): CookieOptions {
  return { path: '/api/resend', maxAge, sameSite: 'Strict', secure: !isLocalDev(url) };
}

function rsOAuthCookie(url: URL): CookieOptions {
  // Lax: the callback is a top-level navigation coming back from Resend's consent screen.
  return { path: '/api/resend', maxAge: RS_OAUTH_TTL, sameSite: 'Lax', secure: !isLocalDev(url) };
}

export function keyHint(key: string): string {
  return `re_…${key.slice(-4)}`;
}

export function oauthConfigured(env: Env): boolean {
  return Boolean(env.RESEND_CLIENT_ID && env.RESEND_CLIENT_SECRET);
}

function redirectUri(url: URL): string {
  return `${url.origin}/api/resend/callback`;
}

/** client_secret_basic: each part URL-encoded, joined with ":", base64-encoded (RFC 6749 §2.3.1). */
function basicAuth(env: Env): string {
  const pair = `${encodeURIComponent(env.RESEND_CLIENT_ID ?? '')}:${encodeURIComponent(env.RESEND_CLIENT_SECRET ?? '')}`;
  return `Basic ${btoa(pair)}`;
}

async function readSession(request: Request, env: Env): Promise<{ cookies: Map<string, string>; session: ResendSession | null }> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await unseal<ResendSession>(env.SEAL_KEY, RS_COOKIE, readChunked(cookies, RS_COOKIE));
  if (!session) return { cookies, session: null };
  if (session.method === 'oauth') return { cookies, session: session.rt && session.at ? session : null };
  return { cookies, session: typeof session.key === 'string' && session.key ? session : null };
}

async function writeSession(env: Env, url: URL, cookies: Map<string, string>, session: ResendSession): Promise<string[]> {
  const ttl = session.method === 'oauth' ? RS_GRANT_TTL : RS_TTL;
  const sealed = await seal(env.SEAL_KEY, RS_COOKIE, session, ttl);
  return writeChunked(cookies, RS_COOKIE, sealed, rsCookie(url, ttl));
}

function clearSession(cookies: Map<string, string>, url: URL): string[] {
  return clearChunked(cookies, RS_COOKIE, rsCookie(url));
}

function resendHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, ...extra };
}

function accessFromScope(scope: string | undefined): ResendAccess {
  return (scope ?? '').split(/\s+/).includes('full_access') ? 'full' : 'sending';
}

// ── Access tokens for OAuth sessions ───────────────────────────────────────────────────────

type Bearer = { ok: true; token: string; cookies: string[]; refreshed: boolean } | { ok: false; response: Response };

/**
 * The token to call Resend with: the API key, or the OAuth access token, refreshed when it
 * has under a minute left (or when `force` is set after Resend rejected it).
 *
 * Refreshes must never run concurrently for one grant. Resend rotates the refresh token on
 * every use and treats a second use of an already-rotated token as theft, revoking the whole
 * grant, so two refreshes racing would silently disconnect the user. A Worker cannot lock
 * across isolates without a Durable Object; instead the access token is reused for its full
 * 15 minutes so refreshes are rare, and the app sends its /api/resend calls one at a time.
 */
async function bearer(
  env: Env,
  url: URL,
  log: RequestLog,
  cookies: Map<string, string>,
  session: ResendSession,
  force = false,
): Promise<Bearer> {
  if (session.method !== 'oauth') return { ok: true, token: session.key, cookies: [], refreshed: false };
  if (!force && session.atExp - Date.now() > REFRESH_MARGIN_MS) {
    return { ok: true, token: session.at, cookies: [], refreshed: false };
  }
  if (!oauthConfigured(env)) {
    return { ok: false, response: json({ error: 'not_configured', message: 'Resend sign-in is not configured on this server.' }, 503) };
  }

  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: basicAuth(env), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.rt }),
    });
  } catch {
    return { ok: false, response: json({ error: 'upstream', status: 0 }, 502) };
  }
  log.upstream = response.status;
  const body = await readJson(response);

  if (!response.ok) {
    const code = str(body?.error);
    if (code === 'invalid_grant') {
      // Expired (60 days unused), revoked in Resend's team settings, or reuse-detected.
      return { ok: false, response: json({ error: 'not_connected', message: EXPIRED_MESSAGE }, 401, clearSession(cookies, url)) };
    }
    // Resend down, or our client credentials broken: not the user's fault, keep their grant.
    return { ok: false, response: json({ error: 'upstream', status: response.status, ...(code ? { code } : {}) }, 502) };
  }

  const at = str(body?.access_token);
  if (!at) return { ok: false, response: json({ error: 'upstream', status: response.status }, 502) };
  const expiresIn = Number(body?.expires_in);
  const next: OAuthSession = {
    ...session,
    at,
    // Resend always rotates; if a response ever lacks one, the old token is the best we have.
    rt: str(body?.refresh_token) ?? session.rt,
    atExp: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    access: str(body?.scope) ? accessFromScope(str(body?.scope)) : session.access,
  };
  Object.assign(session, next); // a forced retry in the same request must see the new tokens
  return { ok: true, token: at, cookies: await writeSession(env, url, cookies, next), refreshed: true };
}

// ── GET /api/resend/login ──────────────────────────────────────────────────────────────────

export async function login(_request: Request, env: Env, url: URL): Promise<Response> {
  const ret = safeReturnPath(url.searchParams.get('return'), url.origin);
  if (!oauthConfigured(env)) {
    return redirect(withResult(ret, { resend: 'error', message: 'Connecting a Resend account is not set up on this server.' }));
  }

  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64); // 86 chars, inside the 43–128 PKCE range
  const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
  const sealed = await seal(env.SEAL_KEY, RS_OAUTH_COOKIE, { state, verifier, return: ret } satisfies OAuthState, RS_OAUTH_TTL);

  const authorize = new URL(`${RESEND_API}/oauth/authorize`);
  authorize.searchParams.set('client_id', env.RESEND_CLIENT_ID!);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri(url));
  authorize.searchParams.set('scope', RESEND_SCOPE);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  return redirect(authorize.toString(), [serializeCookie(RS_OAUTH_COOKIE, sealed, rsOAuthCookie(url))]);
}

// ── GET /api/resend/callback ───────────────────────────────────────────────────────────────

export async function callback(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const saved = await unseal<OAuthState>(env.SEAL_KEY, RS_OAUTH_COOKIE, cookies.get(RS_OAUTH_COOKIE));
  const ret = safeReturnPath(saved?.return, url.origin);
  const clearState = [clearCookie(RS_OAUTH_COOKIE, rsOAuthCookie(url))];
  const fail = (message: string) => redirect(withResult(ret, { resend: 'error', message }), clearState);

  const error = url.searchParams.get('error');
  if (error) {
    if (error === 'access_denied') return fail('Access was not granted in Resend.');
    return fail(firstLine(url.searchParams.get('error_description') ?? undefined) || error);
  }
  if (!saved) return fail('Connecting expired or was started in another window. Please try again.');

  const state = url.searchParams.get('state');
  if (!state || !timingSafeEqual(state, saved.state)) {
    return fail('The connection could not be verified (state mismatch). Please try again.');
  }
  const code = url.searchParams.get('code');
  if (!code) return fail('Resend did not return an authorisation code.');
  if (!oauthConfigured(env)) return fail('Connecting a Resend account is not set up on this server.');

  let response: Response;
  try {
    // client_secret_basic only: the secret travels in the Authorization header, never also in
    // the body (Resend rejects a request that uses two mechanisms).
    response = await fetch(`${RESEND_API}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: basicAuth(env), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(url),
        code_verifier: saved.verifier,
      }),
    });
  } catch {
    return fail('Could not reach Resend. Please try again.');
  }
  log.upstream = response.status;
  const body = await readJson(response);
  if (!response.ok) {
    return fail(firstLine(str(body?.error_description) ?? str(body?.error)) || `Resend returned ${response.status}.`);
  }

  const at = str(body?.access_token);
  const rt = str(body?.refresh_token);
  if (!at || !rt) return fail('Resend did not return the expected tokens.');
  const expiresIn = Number(body?.expires_in);
  const session: OAuthSession = {
    method: 'oauth',
    rt,
    at,
    atExp: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    access: accessFromScope(str(body?.scope)),
    keyHint: 'Resend account',
  };
  return redirect(withResult(ret, { resend: 'ok' }), [...clearState, ...(await writeSession(env, url, cookies, session))]);
}

// ── POST /api/resend/connect (API key) ─────────────────────────────────────────────────────

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
  const cookies = parseCookies(request.headers.get('Cookie'));
  const setCookies = await writeSession(env, url, cookies, { method: 'key', key, access, keyHint: hint });
  return json({ ok: true, access, keyHint: hint, ...(domains ? { domains } : {}) }, 200, setCookies);
}

// ── GET /api/resend/status ─────────────────────────────────────────────────────────────────

export async function status(request: Request, env: Env): Promise<Response> {
  const { session } = await readSession(request, env);
  if (!session) return json({ connected: false });
  return json({
    connected: true,
    method: session.method === 'oauth' ? 'oauth' : 'key',
    access: session.access,
    keyHint: session.keyHint,
  });
}

// ── GET /api/resend/domains ────────────────────────────────────────────────────────────────

export async function domains(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const { cookies, session } = await readSession(request, env);
  if (!session) return json({ error: 'not_connected' }, 401);
  if (session.method === 'oauth' && session.access !== 'full') {
    // `emails:send` cannot list domains; the app asks the user for their From address instead.
    return json({ error: 'insufficient_scope', message: 'This Resend connection can send email but cannot list domains.' }, 403);
  }
  const auth = await bearer(env, url, log, cookies, session);
  if (!auth.ok) return auth.response;
  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/domains`, { headers: resendHeaders(auth.token) });
  } catch {
    return json({ error: 'upstream', status: 0 }, 502, auth.cookies);
  }
  log.upstream = response.status;
  return withCookies(await passthrough(response), auth.cookies);
}

// ── POST /api/resend/emails ────────────────────────────────────────────────────────────────

export async function emails(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const { cookies, session } = await readSession(request, env);
  if (!session) return json({ error: 'not_connected' }, 401);
  if (declaredTooLarge(request, MAX_EMAIL_BYTES)) return json({ error: 'too_large', max: MAX_EMAIL_BYTES }, 413);

  // Forwarded as bytes without parsing: Resend validates the payload, and parsing a large
  // attachment here would only burn the Worker's CPU budget.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_EMAIL_BYTES) return json({ error: 'too_large', max: MAX_EMAIL_BYTES }, 413);

  const extra: Record<string, string> = { 'Content-Type': 'application/json' };
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey) extra['Idempotency-Key'] = idempotencyKey;

  const send = (token: string) => fetch(`${RESEND_API}/emails`, { method: 'POST', headers: resendHeaders(token, extra), body });

  const first = await bearer(env, url, log, cookies, session);
  if (!first.ok) return first.response;
  // Set-Cookie headers for a rotated grant: must reach the browser on every outcome below,
  // or the next call would present a refresh token Resend has already retired.
  let rotated = first.cookies;
  let response: Response;
  try {
    response = await send(first.token);
    // An OAuth access token Resend refuses before its expiry (e.g. the grant was revoked in
    // Resend's settings): refresh once. A dead grant then surfaces as "connect again".
    if (response.status === 401 && session.method === 'oauth' && !first.refreshed) {
      const retry = await bearer(env, url, log, cookies, session, true);
      if (!retry.ok) return retry.response;
      rotated = retry.cookies;
      response = await send(retry.token);
    }
  } catch {
    return json({ error: 'upstream', status: 0 }, 502, rotated);
  }
  log.upstream = response.status;
  return withCookies(await passthrough(response), rotated);
}

// ── POST /api/resend/disconnect ────────────────────────────────────────────────────────────

export async function disconnect(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const { cookies, session } = await readSession(request, env);
  if (session?.method === 'oauth' && oauthConfigured(env)) {
    // Best effort: revoking the refresh token ends the whole grant at Resend (RFC 7009 always
    // answers 200). The cookie is cleared whatever happens.
    try {
      const response = await fetch(`${RESEND_API}/oauth/revoke`, {
        method: 'POST',
        headers: { Authorization: basicAuth(env), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ token: session.rt, token_type_hint: 'refresh_token' }),
      });
      log.upstream = response.status;
    } catch {
      /* the grant still expires after 60 days unused */
    }
  }
  return empty(204, clearSession(cookies, url));
}
