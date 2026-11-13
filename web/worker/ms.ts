// OneDrive token broker.
//
// Microsoft gives browser-only (SPA) apps 24-hour refresh tokens, fixed and non-sliding. As a
// confidential client (client secret, Web platform redirect URI) the Worker gets the normal
// 90-day sliding refresh token instead. That token is sealed into an HttpOnly cookie on the
// user's own device and never stored here. The page only ever sees short-lived access tokens
// and calls Microsoft Graph itself.

import { clearChunked, clearCookie, isLocalDev, parseCookies, readChunked, serializeCookie, writeChunked } from './cookies';
import type { CookieOptions } from './cookies';
import { bytesToBase64Url, randomBase64Url, timingSafeEqual, utf8 } from './encoding';
import type { Env, RequestLog } from './env';
import { declaredTooLarge, empty, firstLine, json, passthrough, readJson, redirect, str } from './http';
import { seal, unseal } from './seal';

export const SCOPES = 'Files.ReadWrite User.Read offline_access';
export const OAUTH_COOKIE = 'sd_oauth';
export const MS_COOKIE = 'sd_ms';
const OAUTH_TTL = 600; // 10 minutes to finish signing in
const MS_TTL = 90 * 24 * 60 * 60; // matches Microsoft's sliding refresh-token window
const MAX_CHUNK_BYTES = 60 * 1024 * 1024;

/** Token-endpoint errors that mean the refresh token can never work again without the user. */
const SIGNED_OUT_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required']);

interface OAuthState {
  state: string;
  verifier: string;
  return: string;
}

interface MsSession {
  rt: string;
}

function oauthCookie(url: URL): CookieOptions {
  // Lax: the callback is a top-level navigation coming back from login.microsoftonline.com.
  return { path: '/api/ms', maxAge: OAUTH_TTL, sameSite: 'Lax', secure: !isLocalDev(url) };
}

function msCookie(url: URL): CookieOptions {
  return { path: '/api', maxAge: MS_TTL, sameSite: 'Strict', secure: !isLocalDev(url) };
}

function authority(env: Env): string {
  const tenant = (env.MS_TENANT || 'consumers').trim();
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

function redirectUri(url: URL): string {
  return `${url.origin}/api/ms/callback`;
}

/** A same-origin path to come back to after sign-in; anything else collapses to "/". */
export function safeReturnPath(raw: string | null | undefined, origin: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  try {
    const target = new URL(raw, origin);
    if (target.origin !== origin) return '/';
    return target.pathname + target.search;
  } catch {
    return '/';
  }
}

function fragment(path: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${path}#${query}`;
}

async function readSession(request: Request, env: Env): Promise<{ cookies: Map<string, string>; session: MsSession | null }> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await unseal<MsSession>(env.SEAL_KEY, MS_COOKIE, readChunked(cookies, MS_COOKIE));
  return { cookies, session: session && typeof session.rt === 'string' && session.rt ? session : null };
}

// ── GET /api/ms/login ──────────────────────────────────────────────────────────────────────

export async function login(_request: Request, env: Env, url: URL): Promise<Response> {
  const ret = safeReturnPath(url.searchParams.get('return'), url.origin);
  if (!env.MS_CLIENT_ID) {
    return redirect(fragment(ret, { ms: 'error', message: 'OneDrive sign-in is not configured on this server.' }));
  }

  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64); // 86 chars, inside RFC 7636's 43–128
  const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
  const sealed = await seal(env.SEAL_KEY, OAUTH_COOKIE, { state, verifier, return: ret } satisfies OAuthState, OAUTH_TTL);

  const authorize = new URL(`${authority(env)}/authorize`);
  authorize.searchParams.set('client_id', env.MS_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri(url));
  authorize.searchParams.set('response_mode', 'query');
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('prompt', 'select_account');

  return redirect(authorize.toString(), [serializeCookie(OAUTH_COOKIE, sealed, oauthCookie(url))]);
}

// ── GET /api/ms/callback ───────────────────────────────────────────────────────────────────

export async function callback(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const saved = await unseal<OAuthState>(env.SEAL_KEY, OAUTH_COOKIE, cookies.get(OAUTH_COOKIE));
  const ret = safeReturnPath(saved?.return, url.origin);
  const clearState = [clearCookie(OAUTH_COOKIE, oauthCookie(url))];
  const fail = (message: string) => redirect(fragment(ret, { ms: 'error', message }), clearState);

  const error = url.searchParams.get('error');
  if (error) return fail(firstLine(url.searchParams.get('error_description') ?? undefined) || error);
  if (!saved) return fail('Sign-in expired or was started in another window. Please try again.');

  const state = url.searchParams.get('state');
  if (!state || !timingSafeEqual(state, saved.state)) {
    return fail('Sign-in could not be verified (state mismatch). Please try again.');
  }
  const code = url.searchParams.get('code');
  if (!code) return fail('Microsoft did not return an authorisation code.');
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return fail('OneDrive sign-in is not configured on this server.');

  let response: Response;
  try {
    response = await fetch(`${authority(env)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(url),
        code_verifier: saved.verifier,
        scope: SCOPES,
      }),
    });
  } catch {
    return fail('Could not reach Microsoft. Please try again.');
  }
  log.upstream = response.status;
  const body = await readJson(response);

  if (!response.ok) {
    return fail(firstLine(str(body?.error_description) ?? str(body?.error)) || `Microsoft returned ${response.status}.`);
  }
  const refreshToken = str(body?.refresh_token);
  if (!refreshToken) return fail('Microsoft did not return a refresh token (offline_access was not granted).');

  const sealed = await seal(env.SEAL_KEY, MS_COOKIE, { rt: refreshToken } satisfies MsSession, MS_TTL);
  return redirect(fragment(ret, { ms: 'ok' }), [...clearState, ...writeChunked(cookies, MS_COOKIE, sealed, msCookie(url))]);
}

// ── POST /api/ms/token ─────────────────────────────────────────────────────────────────────

export async function token(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const { cookies, session } = await readSession(request, env);
  if (!session) return json({ error: 'signed_out' }, 401, clearChunked(cookies, MS_COOKIE, msCookie(url)));
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return json({ error: 'not_configured' }, 503);

  let response: Response;
  try {
    response = await fetch(`${authority(env)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: session.rt,
        scope: SCOPES,
      }),
    });
  } catch {
    return json({ error: 'upstream', status: 0 }, 502);
  }
  log.upstream = response.status;
  const body = await readJson(response);

  if (!response.ok) {
    const code = str(body?.error);
    if (response.status < 500 && code && SIGNED_OUT_ERRORS.has(code)) {
      return json({ error: 'signed_out' }, 401, clearChunked(cookies, MS_COOKIE, msCookie(url)));
    }
    // Anything else (Microsoft down, our client secret expired) is not the user's fault and
    // must not cost them their session: keep the cookie and let the app retry later.
    return json({ error: 'upstream', status: response.status, ...(code ? { code } : {}) }, 502);
  }

  const accessToken = str(body?.access_token);
  if (!accessToken) return json({ error: 'upstream', status: response.status }, 502);

  // Microsoft usually rotates the refresh token; when it doesn't, the old one stays valid.
  const nextRefresh = str(body?.refresh_token) ?? session.rt;
  const sealed = await seal(env.SEAL_KEY, MS_COOKIE, { rt: nextRefresh } satisfies MsSession, MS_TTL);
  const expiresIn = Number(body?.expires_in);
  return json(
    { access_token: accessToken, expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600 },
    200,
    writeChunked(cookies, MS_COOKIE, sealed, msCookie(url)),
  );
}

// ── POST /api/ms/logout ────────────────────────────────────────────────────────────────────

export function logout(request: Request, _env: Env, url: URL): Response {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return empty(204, clearChunked(cookies, MS_COOKIE, msCookie(url)));
}

// ── PUT /api/ms/chunk ──────────────────────────────────────────────────────────────────────

const UPLOAD_HOST_SUFFIXES = ['.microsoftpersonalcontent.com', '.1drv.com', '.files.1drv.com', '.sharepoint.com'];
const UPLOAD_HOSTS = ['api.onedrive.com'];

/** The upload-session URL, if it points at Microsoft storage over https; otherwise null. */
export function allowedUploadUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const target = new URL(raw);
    if (target.protocol !== 'https:' || target.username || target.password) return null;
    if (target.port && target.port !== '443') return null;
    const host = target.hostname.toLowerCase();
    const ok =
      UPLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ||
      UPLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
    return ok ? target : null;
  } catch {
    return null;
  }
}

/**
 * Relay one upload-session chunk for browsers that cannot PUT to the upload URL directly.
 * The URL carries its own credential, so no Authorization header is sent. A signed-in
 * OneDrive session is still required, so this is never an anonymous open relay.
 */
export async function chunk(request: Request, env: Env, _url: URL, log: RequestLog): Promise<Response> {
  const { session } = await readSession(request, env);
  if (!session) return json({ error: 'signed_out' }, 401);

  const target = allowedUploadUrl(request.headers.get('X-Upload-Url'));
  if (!target) return json({ error: 'bad_upload_url' }, 400);
  const range = request.headers.get('Content-Range');
  if (!range) return json({ error: 'missing_content_range' }, 400);
  if (declaredTooLarge(request, MAX_CHUNK_BYTES)) return json({ error: 'too_large', max: MAX_CHUNK_BYTES }, 413);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CHUNK_BYTES) return json({ error: 'too_large', max: MAX_CHUNK_BYTES }, 413);

  let response: Response;
  try {
    response = await fetch(target.toString(), { method: 'PUT', headers: { 'Content-Range': range }, body });
  } catch {
    return json({ error: 'upstream', status: 0 }, 502);
  }
  log.upstream = response.status;
  return passthrough(response);
}
