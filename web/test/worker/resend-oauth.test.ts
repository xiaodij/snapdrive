import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seal, unseal } from '../../worker/seal';
import { Jar, call, headerOf, jsonResponse, makeEnv, post, recordFetch, setCookies } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const RS = { RESEND_CLIENT_ID: 'rs-client-id', RESEND_CLIENT_SECRET: 'rs secret/with:chars' };
const rsEnv = () => makeEnv(RS);
const expectedBasic = `Basic ${Buffer.from(`${encodeURIComponent(RS.RESEND_CLIENT_ID)}:${encodeURIComponent(RS.RESEND_CLIENT_SECRET)}`).toString('base64')}`;

interface Saved {
  state: string;
  verifier: string;
  return: string;
}

async function startLogin(env = rsEnv()) {
  const jar = new Jar();
  const res = await call(env, `/api/resend/login?return=${encodeURIComponent('/?resume=review')}`, { jar });
  return { env, jar, res };
}

async function oauthCookie(env: ReturnType<typeof rsEnv>, session: Record<string, unknown>) {
  return seal(env.SEAL_KEY, 'sd_rs', { method: 'oauth', access: 'sending', keyHint: 'Resend account', ...session }, 3600);
}

describe('GET /api/resend/login', () => {
  it('redirects to Resend with PKCE S256 and a sealed, Lax state cookie', async () => {
    const { env, jar, res } = await startLogin();
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get('Location')!);
    expect(target.origin + target.pathname).toBe('https://api.resend.com/oauth/authorize');
    const q = target.searchParams;
    expect(q.get('client_id')).toBe('rs-client-id');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('https://snapdrive.xjpc.ca/api/resend/callback');
    expect(q.get('scope')).toBe('emails:send');
    expect(q.get('code_challenge_method')).toBe('S256');

    const cookie = setCookies(res).find((c) => c.name === 'sd_rsoauth')!;
    expect(cookie.attributes).toContain('SameSite=Lax');
    expect(cookie.attributes).toContain('Path=/api/resend');
    expect(cookie.attributes).toContain('HttpOnly');
    const saved = await unseal<Saved>(env.SEAL_KEY, 'sd_rsoauth', jar.cookies.get('sd_rsoauth'));
    expect(saved?.state).toBe(q.get('state'));
    expect(saved?.return).toBe('/?resume=review');
    const challenge = createHash('sha256').update(saved!.verifier).digest('base64url');
    expect(q.get('code_challenge')).toBe(challenge);
  });

  it('sends the user back with an error when the server has no Resend client', async () => {
    const res = await call(makeEnv(), '/api/resend/login?return=/');
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location.startsWith('/?resend=error&message=')).toBe(true);
    expect(location).not.toContain('#');
  });
});

describe('GET /api/resend/callback', () => {
  it('refuses a state mismatch without calling Resend', async () => {
    const { env, jar } = await startLogin();
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    const res = await call(env, '/api/resend/callback?code=CODE&state=wrong', { jar });
    const location = res.headers.get('Location')!;
    expect(location.startsWith('/?resume=review&resend=error&message=')).toBe(true);
    expect(new URLSearchParams(location.split('?')[1]).get('message')).toContain('state mismatch');
    expect(stub.calls).toHaveLength(0);
    expect(setCookies(res).find((c) => c.name === 'sd_rsoauth')?.cleared).toBe(true);
    expect(setCookies(res).some((c) => c.name.startsWith('sd_rs') && c.name !== 'sd_rsoauth' && !c.cleared)).toBe(false);
  });

  it('maps a declined consent to a readable message', async () => {
    const { env, jar } = await startLogin();
    const res = await call(env, '/api/resend/callback?error=access_denied&state=x', { jar });
    expect(new URLSearchParams(res.headers.get('Location')!.split('?')[1]).get('message')).toBe('Access was not granted in Resend.');
  });

  it('redeems the code with Basic auth only, seals the grant, and keeps tokens out of the URL', async () => {
    const { env, jar, res: start } = await startLogin();
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const saved = await unseal<Saved>(env.SEAL_KEY, 'sd_rsoauth', jar.cookies.get('sd_rsoauth'));
    const stub = recordFetch(() =>
      jsonResponse({ access_token: 'AT-1', token_type: 'Bearer', expires_in: 900, refresh_token: 'RT-1', scope: 'emails:send' }),
    );
    vi.stubGlobal('fetch', stub.fn);

    const res = await call(env, `/api/resend/callback?code=CODE-9&state=${state}`, { jar });
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toBe('/?resume=review&resend=ok');
    for (const secret of ['AT-1', 'RT-1', 'CODE-9']) expect(location).not.toContain(secret);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('https://api.resend.com/oauth/token');
    expect(headerOf(stub.calls[0].init, 'Authorization')).toBe(expectedBasic);
    const form = new URLSearchParams(String(stub.calls[0].init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('CODE-9');
    expect(form.get('code_verifier')).toBe(saved!.verifier);
    expect(form.get('redirect_uri')).toBe('https://snapdrive.xjpc.ca/api/resend/callback');
    expect(form.has('client_secret')).toBe(false); // one auth mechanism only
    expect(form.has('client_id')).toBe(false);

    const session = await unseal<Record<string, unknown>>(env.SEAL_KEY, 'sd_rs', jar.cookies.get('sd_rs'));
    expect(session).toMatchObject({ method: 'oauth', rt: 'RT-1', at: 'AT-1', access: 'sending', keyHint: 'Resend account' });
    expect(jar.cookies.has('sd_rsoauth')).toBe(false);

    const status = await call(env, '/api/resend/status', { jar });
    expect(await status.json()).toEqual({ connected: true, method: 'oauth', access: 'sending', keyHint: 'Resend account' });
  });
});

describe('sending with an OAuth grant', () => {
  const email = { from: 'SnapDrive <scans@xjpc.ca>', to: ['delivered@resend.dev'], subject: 's', text: 't' };

  it('uses a fresh access token without refreshing', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-1', at: 'AT-fresh', atExp: Date.now() + 600_000 }));
    const stub = recordFetch(() => jsonResponse({ id: 'email-1' }));
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/resend/emails', email, jar, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('https://api.resend.com/emails');
    expect(headerOf(stub.calls[0].init, 'Authorization')).toBe('Bearer AT-fresh');
    expect(headerOf(stub.calls[0].init, 'Idempotency-Key')).toBe('k1');
    expect(setCookies(res).filter((c) => c.name.startsWith('sd_rs'))).toHaveLength(0);
  });

  it('refreshes an expiring token once, sends with the new one, and rotates the cookie', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-old', at: 'AT-old', atExp: Date.now() + 10_000 }));
    const stub = recordFetch((url) =>
      url.endsWith('/oauth/token')
        ? jsonResponse({ access_token: 'AT-new', expires_in: 900, refresh_token: 'RT-new', scope: 'emails:send' })
        : jsonResponse({ id: 'email-2' }),
    );
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/resend/emails', email, jar);
    expect(res.status).toBe(200);
    expect(stub.calls.map((c) => c.url)).toEqual(['https://api.resend.com/oauth/token', 'https://api.resend.com/emails']);
    const form = new URLSearchParams(String(stub.calls[0].init.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('RT-old');
    expect(form.has('client_secret')).toBe(false);
    expect(headerOf(stub.calls[0].init, 'Authorization')).toBe(expectedBasic);
    expect(headerOf(stub.calls[1].init, 'Authorization')).toBe('Bearer AT-new');
    const session = await unseal<Record<string, unknown>>(env.SEAL_KEY, 'sd_rs', jar.cookies.get('sd_rs'));
    expect(session).toMatchObject({ rt: 'RT-new', at: 'AT-new' });
  });

  it('clears the grant and asks to reconnect on invalid_grant', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-dead', at: 'AT-old', atExp: Date.now() - 1 }));
    const stub = recordFetch(() => jsonResponse({ error: 'invalid_grant', error_description: 'reused' }, 400));
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/resend/emails', email, jar);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_connected', message: 'The Resend connection expired. Connect again.' });
    expect(stub.calls).toHaveLength(1); // never reached /emails
    expect(jar.cookies.has('sd_rs')).toBe(false);
  });

  it('keeps the grant when Resend is down', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-1', at: 'AT-old', atExp: Date.now() - 1 }));
    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ error: 'server_error' }, 503)).fn);
    const res = await post(env, '/api/resend/emails', email, jar);
    expect(res.status).toBe(502);
    expect(jar.cookies.has('sd_rs')).toBe(true);
  });

  it('refreshes and retries once when Resend refuses an unexpired token', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-1', at: 'AT-revoked', atExp: Date.now() + 600_000 }));
    let sends = 0;
    const stub = recordFetch((url, init) => {
      if (url.endsWith('/oauth/token')) return jsonResponse({ access_token: 'AT-2', expires_in: 900, refresh_token: 'RT-2' });
      sends++;
      return headerOf(init, 'Authorization') === 'Bearer AT-2' ? jsonResponse({ id: 'email-3' }) : jsonResponse({ message: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/resend/emails', email, jar);
    expect(res.status).toBe(200);
    expect(sends).toBe(2);
    expect((await unseal<Record<string, unknown>>(env.SEAL_KEY, 'sd_rs', jar.cookies.get('sd_rs')))?.rt).toBe('RT-2');
  });

  it('refuses to list domains with a send-only grant', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-1', at: 'AT-1', atExp: Date.now() + 600_000 }));
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    const res = await call(env, '/api/resend/domains', { jar });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('insufficient_scope');
    expect(stub.calls).toHaveLength(0);
  });

  it('disconnect revokes the grant at Resend and clears the cookie', async () => {
    const env = rsEnv();
    const jar = new Jar();
    jar.cookies.set('sd_rs', await oauthCookie(env, { rt: 'RT-1', at: 'AT-1', atExp: Date.now() + 600_000 }));
    const stub = recordFetch(() => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/resend/disconnect', undefined, jar);
    expect(res.status).toBe(204);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('https://api.resend.com/oauth/revoke');
    expect(headerOf(stub.calls[0].init, 'Authorization')).toBe(expectedBasic);
    const form = new URLSearchParams(String(stub.calls[0].init.body));
    expect(form.get('token')).toBe('RT-1');
    expect(form.get('token_type_hint')).toBe('refresh_token');
    expect(jar.cookies.has('sd_rs')).toBe(false);
  });
});
