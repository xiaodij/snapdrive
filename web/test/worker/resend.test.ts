import { afterEach, describe, expect, it, vi } from 'vitest';
import { unseal } from '../../worker/seal';
import { Jar, call, headerOf, jsonResponse, makeEnv, post, recordFetch, setCookies } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

const FULL_KEY = 're_fullAccess_0000abcd';
const SEND_KEY = 're_sendOnly_1111wxyz';

async function connect(env = makeEnv(), key = FULL_KEY) {
  const jar = new Jar();
  const stub = recordFetch((_url, init) => {
    const auth = headerOf(init, 'Authorization');
    if (auth === `Bearer ${FULL_KEY}`) {
      return jsonResponse({ object: 'list', data: [{ id: '1', name: 'xjpc.ca', status: 'verified', region: 'us-east-1' }, { id: '2', name: 'pending.example', status: 'pending' }] });
    }
    if (auth === `Bearer ${SEND_KEY}`) {
      return jsonResponse({ statusCode: 401, message: 'This API key is restricted to only send emails', name: 'restricted_api_key' }, 401);
    }
    return jsonResponse({ statusCode: 400, message: 'API key is invalid', name: 'validation_error' }, 400);
  });
  vi.stubGlobal('fetch', stub.fn);
  const res = await post(env, '/api/resend/connect', { apiKey: key }, jar);
  vi.unstubAllGlobals();
  return { env, jar, res, stub };
}

describe('POST /api/resend/connect', () => {
  it('accepts a full-access key and lists its domains', async () => {
    const { env, jar, res, stub } = await connect();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      access: 'full',
      keyHint: 're_…abcd',
      domains: [
        { name: 'xjpc.ca', status: 'verified' },
        { name: 'pending.example', status: 'pending' },
      ],
    });
    expect(stub.calls[0].url).toBe('https://api.resend.com/domains');
    expect(headerOf(stub.calls[0].init, 'User-Agent')).toBe('SnapDrive/2');
    const cookie = setCookies(res).find((c) => c.name === 'sd_rs')!;
    expect(cookie.attributes).toContain('Path=/api/resend');
    expect(cookie.attributes).toContain('SameSite=Strict');
    expect(cookie.attributes).toContain('HttpOnly');
    expect(cookie.attributes).toContain(`Max-Age=${400 * 86400}`);
    expect(cookie.value).not.toContain('fullAccess');
    expect(await unseal(env.SEAL_KEY, 'sd_rs', jar.cookies.get('sd_rs'))).toEqual({ key: FULL_KEY, access: 'full', keyHint: 're_…abcd' });
  });

  it('accepts a sending-only key as access "sending"', async () => {
    const { res } = await connect(makeEnv(), SEND_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, access: 'sending', keyHint: 're_…wxyz' });
  });

  it('rejects an invalid key with Resend\'s message and sets no cookie', async () => {
    const { res, jar } = await connect(makeEnv(), 're_doesNotExist_9999');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_key', message: 'API key is invalid' });
    expect(jar.cookies.size).toBe(0);
  });

  it('rejects a malformed key without calling Resend', async () => {
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    for (const apiKey of ['', 'sk_live_123456789', 're_', 're_has spaces in it', 42]) {
      const res = await post(makeEnv(), '/api/resend/connect', { apiKey });
      expect(res.status).toBe(400);
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe('status, domains, emails, disconnect', () => {
  it('reports connection status', async () => {
    const env = makeEnv();
    expect(await (await call(env, '/api/resend/status')).json()).toEqual({ connected: false });
    const { jar } = await connect(env);
    expect(await (await call(env, '/api/resend/status', { jar })).json()).toEqual({ connected: true, access: 'full', keyHint: 're_…abcd' });
  });

  it('refuses to send or list without a connection', async () => {
    const env = makeEnv();
    const send = await post(env, '/api/resend/emails', { to: 'a@b.c' });
    expect(send.status).toBe(401);
    expect(await send.json()).toEqual({ error: 'not_connected' });
    expect((await call(env, '/api/resend/domains')).status).toBe(401);
  });

  it('forwards the email body untouched with the key and Idempotency-Key', async () => {
    const { env, jar } = await connect();
    const stub = recordFetch(() => jsonResponse({ id: 'email-id-1' }));
    vi.stubGlobal('fetch', stub.fn);
    const payload = {
      from: 'SnapDrive <snapdrive@xjpc.ca>',
      to: ['delivered@resend.dev'],
      subject: 'Scan',
      html: '<p>Scan attached</p>',
      attachments: [{ filename: 'scan.pdf', content: 'JVBERi0xLjcK' }],
    };
    const res = await post(env, '/api/resend/emails', payload, jar, { 'Idempotency-Key': 'job-123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'email-id-1' });
    const sent = stub.calls[0];
    expect(sent.url).toBe('https://api.resend.com/emails');
    expect(sent.init.method).toBe('POST');
    expect(headerOf(sent.init, 'Authorization')).toBe(`Bearer ${FULL_KEY}`);
    expect(headerOf(sent.init, 'Idempotency-Key')).toBe('job-123');
    expect(headerOf(sent.init, 'Content-Type')).toBe('application/json');
    expect(headerOf(sent.init, 'User-Agent')).toBe('SnapDrive/2');
    expect(JSON.parse(new TextDecoder().decode(sent.init.body as ArrayBuffer))).toEqual(payload);
  });

  it('passes Resend errors through with their status', async () => {
    const { env, jar } = await connect();
    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' }, 422)).fn);
    const res = await post(env, '/api/resend/emails', { from: 'bad' }, jar);
    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe('Invalid `from` field.');
  });

  it('refuses a body over Resend\'s 40 MB cap before forwarding', async () => {
    const { env, jar } = await connect();
    const stub = recordFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', stub.fn);
    const res = await post(env, '/api/resend/emails', { x: 'y' }, jar, { 'Content-Length': String(41 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(stub.calls).toHaveLength(0);
  });

  it('passes the domain list through', async () => {
    const { env, jar } = await connect();
    vi.stubGlobal('fetch', recordFetch(() => jsonResponse({ data: [{ name: 'xjpc.ca', status: 'verified' }] })).fn);
    const res = await call(env, '/api/resend/domains', { jar });
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].name).toBe('xjpc.ca');
  });

  it('disconnect clears the key', async () => {
    const { env, jar } = await connect();
    const res = await post(env, '/api/resend/disconnect', undefined, jar);
    expect(res.status).toBe(204);
    expect(jar.cookies.has('sd_rs')).toBe(false);
    expect(await (await call(env, '/api/resend/status', { jar })).json()).toEqual({ connected: false });
  });
});
