import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unseal } from '../../worker/seal';
import { ORIGIN, Jar, call, headerOf, jsonResponse, makeEnv, post, recordFetch, setCookies } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Run /api/ms/login and return the authorize URL plus the jar holding sd_oauth. */
async function startLogin(env = makeEnv(), returnPath = '/review?x=1') {
  const jar = new Jar();
  const res = await call(env, `/api/ms/login?return=${encodeURIComponent(returnPath)}`, { jar });
  expect(res.status).toBe(302);
  return { env, jar, res, authorize: new URL(res.headers.get('Location')!) };
}

/** Complete a sign-in with a stubbed token endpoint. */
async function signIn(refreshToken = 'RT-secret-1', env = makeEnv()) {
  const { jar, authorize } = await startLogin(env);
  const stub = recordFetch(() => jsonResponse({ access_token: 'AT-secret-1', refresh_token: refreshToken, expires_in: 3600 }));
  vi.stubGlobal('fetch', stub.fn);
  const state = authorize.searchParams.get('state')!;
  const res = await call(env, `/api/ms/callback?code=CODE-123&state=${state}`, { jar });
  vi.unstubAllGlobals();
  return { env, jar, res, stub };
}

describe('GET /api/ms/login', () => {
  it('redirects to Microsoft with PKCE S256 and sets a sealed, short-lived state cookie', async () => {
    const { env, res, authorize } = await startLogin();
    expect(authorize.origin + authorize.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    const p = authorize.searchParams;
    expect(p.get('client_id')).toBe('client-id-123');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('response_mode')).toBe('query');
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/ms/callback`);
    expect(p.get('scope')).toBe('Files.ReadWrite User.Read offline_access');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('prompt')).toBe('select_account');

    const [cookie] = setCookies(res);
    expect(cookie.name).toBe('sd_oauth');
    expect(cookie.attributes).toContain('Path=/api/ms');
    expect(cookie.attributes).toContain('Max-Age=600');
    expect(cookie.attributes).toContain('HttpOnly');
    expect(cookie.attributes).toContain('SameSite=Lax');
    expect(cookie.attributes).toContain('Secure');

    const saved = await unseal<{ state: string; verifier: string; return: string }>(env.SEAL_KEY, 'sd_oauth', cookie.value);
    expect(saved).not.toBeNull();
    expect(saved!.state).toBe(p.get('state'));
    expect(saved!.return).toBe('/review?x=1');
    expect(saved!.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.get('code_challenge')).toBe(b64url(createHash('sha256').update(saved!.verifier).digest()));
  });

  it('only accepts same-origin return paths', async () => {
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      const { env, res } = await startLogin(makeEnv(), bad);
      const saved = await unseal<{ return: string }>(env.SEAL_KEY, 'sd_oauth', setCookies(res)[0].value);
      expect(saved!.return).toBe('/');
    }
  });

  it('omits Secure on plain-http localhost', async () => {
    const res = await call(makeEnv(), '/api/ms/login', { origin: 'http://localhost:8794' });
    expect(setCookies(res)[0].attributes).not.toContain('Secure');
    expect(new URL(res.headers.get('Location')!).searchParams.get('redirect_uri')).toBe('http://localhost:8794/api/ms/callback');
  });
});

describe('GET /api/ms/callback', () => {
  it('refuses a state mismatch without calling Microsoft', async () => {
    const { env, jar } = await startLogin();
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    const res = await call(env, '/api/ms/callback?code=CODE&state=wrong-state', { jar });
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location.startsWith('/review?x=1#ms=error&message=')).toBe(true);
    expect(decodeURIComponent(location)).toContain('state mismatch');
    expect(stub.calls).toHaveLength(0);
    const cookies = setCookies(res);
    expect(cookies.find((c) => c.name === 'sd_oauth')?.cleared).toBe(true);
    expect(cookies.some((c) => c.name.startsWith('sd_ms') && !c.cleared)).toBe(false);
  });

  it('reports a missing state cookie and Microsoft errors', async () => {
    const env = makeEnv();
    const missing = await call(env, '/api/ms/callback?code=CODE&state=abc');
    expect(missing.headers.get('Location')).toMatch(/^\/#ms=error&message=Sign-in%20expired/);

    const { jar } = await startLogin(env);
    const denied = await call(env, '/api/ms/callback?error=access_denied&error_description=User%20declined.%0D%0ATrace%20ID%3A%20abc', { jar });
    expect(denied.headers.get('Location')).toBe('/review?x=1#ms=error&message=User%20declined.');
  });

  it('redeems the code with secret + verifier, sets sd_ms, and never leaks tokens in the URL', async () => {
    const { env, jar, res, stub } = await signIn();
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toBe('/review?x=1#ms=ok');
    for (const secret of ['AT-secret-1', 'RT-secret-1', 'CODE-123']) expect(location).not.toContain(secret);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    const form = new URLSearchParams(String(stub.calls[0].init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('CODE-123');
    expect(form.get('client_secret')).toBe('client-secret-xyz');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/ms/callback`);
    expect(form.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);

    const ms = setCookies(res).find((c) => c.name === 'sd_ms')!;
    expect(ms.attributes).toContain('Path=/api');
    expect(ms.attributes).toContain('SameSite=Strict');
    expect(ms.attributes).toContain('HttpOnly');
    expect(ms.attributes).toContain(`Max-Age=${90 * 86400}`);
    expect(await unseal(env.SEAL_KEY, 'sd_ms', jar.cookies.get('sd_ms'))).toEqual({ rt: 'RT-secret-1' });
    expect(jar.cookies.has('sd_oauth')).toBe(false);
  });

  it('chunks a very long refresh token and reads it back on refresh', async () => {
    const longToken = 'R'.repeat(6000);
    const { env, jar } = await signIn(longToken);
    expect(jar.cookies.has('sd_ms')).toBe(false);
    expect(jar.cookies.has('sd_ms.0')).toBe(true);
    expect(jar.cookies.has('sd_ms.1')).toBe(true);

    const stub = recordFetch(() => jsonResponse({ access_token: 'AT-2', expires_in: 3599, refresh_token: 'short-rt' }));
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/ms/token', undefined, jar);
    expect(res.status).toBe(200);
    expect(new URLSearchParams(String(stub.calls[0].init.body)).get('refresh_token')).toBe(longToken);
    // The short replacement is written whole and the old chunks are cleared.
    expect(jar.cookies.has('sd_ms')).toBe(true);
    expect(jar.cookies.has('sd_ms.0')).toBe(false);
    expect(jar.cookies.has('sd_ms.1')).toBe(false);
  });
});

describe('POST /api/ms/token', () => {
  it('refreshes, returns only the access token, and rotates the cookie', async () => {
    const { env, jar } = await signIn();
    const before = jar.cookies.get('sd_ms');
    const stub = recordFetch(() => jsonResponse({ access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3599 }));
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/ms/token', undefined, jar);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'AT-2', expires_in: 3599 });
    const form = new URLSearchParams(String(stub.calls[0].init.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('RT-secret-1');
    expect(form.get('client_secret')).toBe('client-secret-xyz');
    expect(jar.cookies.get('sd_ms')).not.toBe(before);
    expect(await unseal(env.SEAL_KEY, 'sd_ms', jar.cookies.get('sd_ms'))).toEqual({ rt: 'RT-2' });
  });

  it('keeps the old refresh token when Microsoft does not return a new one', async () => {
    const { env, jar } = await signIn();
    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ access_token: 'AT-2', expires_in: 3600 })).fn);
    expect((await post(env, '/api/ms/token', undefined, jar)).status).toBe(200);
    expect(await unseal(env.SEAL_KEY, 'sd_ms', jar.cookies.get('sd_ms'))).toEqual({ rt: 'RT-secret-1' });
  });

  it('signs out and clears the cookie on invalid_grant', async () => {
    const { env, jar } = await signIn();
    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ error: 'invalid_grant', error_description: 'AADSTS70000' }, 400)).fn);
    const res = await post(env, '/api/ms/token', undefined, jar);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'signed_out' });
    expect(jar.cookies.has('sd_ms')).toBe(false);
  });

  it('keeps the session when Microsoft is down or the client secret is rejected', async () => {
    const { env, jar } = await signIn();
    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ error: 'temporarily_unavailable' }, 503)).fn);
    let res = await post(env, '/api/ms/token', undefined, jar);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream', status: 503, code: 'temporarily_unavailable' });
    expect(jar.cookies.has('sd_ms')).toBe(true);

    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ error: 'invalid_client' }, 401)).fn);
    res = await post(env, '/api/ms/token', undefined, jar);
    expect(res.status).toBe(502);
    expect(jar.cookies.has('sd_ms')).toBe(true);

    vi.stubGlobal('fetch', recordFetch(() => Promise.reject(new TypeError('network'))).fn);
    res = await post(env, '/api/ms/token', undefined, jar);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream', status: 0 });
    expect(jar.cookies.has('sd_ms')).toBe(true);
  });

  it('answers signed_out without a cookie, or with one sealed under another key', async () => {
    const res = await post(makeEnv(), '/api/ms/token', undefined);
    expect(res.status).toBe(401);
    const { jar } = await signIn();
    const other = await post(makeEnv(), '/api/ms/token', undefined, jar);
    expect(other.status).toBe(401);
    expect(jar.cookies.has('sd_ms')).toBe(false);
  });

  it('logout clears the session', async () => {
    const { env, jar } = await signIn();
    const res = await post(env, '/api/ms/logout', undefined, jar);
    expect(res.status).toBe(204);
    expect(jar.cookies.has('sd_ms')).toBe(false);
  });
});

describe('PUT /api/ms/chunk', () => {
  async function put(env: ReturnType<typeof makeEnv>, jar: Jar | undefined, uploadUrl: string) {
    return call(env, '/api/ms/chunk', {
      method: 'PUT',
      headers: { 'X-SnapDrive': '1', Origin: ORIGIN, 'X-Upload-Url': uploadUrl, 'Content-Range': 'bytes 0-3/10' },
      body: new Uint8Array([1, 2, 3, 4]),
      jar,
    });
  }

  it('relays to Microsoft storage hosts without an Authorization header', async () => {
    const { env, jar } = await signIn();
    for (const target of [
      'https://my.microsoftpersonalcontent.com/personal/abc/_api/v2.0/uploadSession?guid=1',
      'https://api.onedrive.com/rup/abc',
      'https://abc.files.1drv.com/x',
      'https://contoso-my.sharepoint.com/personal/x/_api/v2.0/drive/items/y/uploadSession',
    ]) {
      const stub = recordFetch(() => jsonResponse({ nextExpectedRanges: ['4-'] }, 202));
      vi.stubGlobal('fetch', stub.fn);
      const res = await put(env, jar, target);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ nextExpectedRanges: ['4-'] });
      expect(stub.calls[0].url).toBe(target);
      expect(stub.calls[0].init.method).toBe('PUT');
      expect(headerOf(stub.calls[0].init, 'Content-Range')).toBe('bytes 0-3/10');
      expect(headerOf(stub.calls[0].init, 'Authorization')).toBeNull();
    }
  });

  it('refuses any other host or scheme', async () => {
    const { env, jar } = await signIn();
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    for (const target of [
      'https://evil.example/upload',
      'http://api.onedrive.com/rup/abc',
      'https://api.onedrive.com.evil.example/x',
      'https://microsoftpersonalcontent.com.evil.example/x',
      'https://user:pw@api.onedrive.com/x',
      'not a url',
    ]) {
      const res = await put(env, jar, target);
      expect(res.status).toBe(400);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('requires a signed-in session', async () => {
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    const res = await put(makeEnv(), undefined, 'https://api.onedrive.com/rup/abc');
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });
});
