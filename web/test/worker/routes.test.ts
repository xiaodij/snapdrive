import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index';
import { ORIGIN, call, makeEnv, post, recordFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing and headers', () => {
  it('health and config', async () => {
    const env = makeEnv();
    const health = await call(env, '/api/health');
    expect(await health.json()).toEqual({ ok: true, version: '2.0.0' });
    expect(health.headers.get('Cache-Control')).toBe('no-store');
    expect(health.headers.get('Access-Control-Allow-Origin')).toBeNull();

    expect(await (await call(env, '/api/config')).json()).toEqual({ onedrive: true, tenant: 'consumers' });
    expect(await (await call(makeEnv({ MS_CLIENT_SECRET: undefined }), '/api/config')).json()).toEqual({ onedrive: false, tenant: 'consumers' });
  });

  it('404s unknown routes and 405s wrong methods, as JSON', async () => {
    const env = makeEnv();
    const missing = await call(env, '/api/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    expect(missing.headers.get('Cache-Control')).toBe('no-store');

    const wrong = await call(env, '/api/ms/token');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('POST');
  });

  it('sends non-API paths to the static assets', async () => {
    const assets = { fetch: vi.fn(async () => new Response('<html>app</html>')) };
    const res = await worker.fetch(new Request(`${ORIGIN}/settings`), makeEnv({ ASSETS: assets }));
    expect(await res.text()).toBe('<html>app</html>');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it('reports a missing SEAL_KEY as misconfigured', async () => {
    const res = await call(makeEnv({ SEAL_KEY: undefined }), '/api/ms/login');
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('misconfigured');
  });
});

describe('CSRF guard', () => {
  it('refuses a state-changing call without X-SnapDrive', async () => {
    const stub = recordFetch(() => new Response('{}'));
    vi.stubGlobal('fetch', stub.fn);
    const res = await call(makeEnv(), '/api/resend/connect', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 're_whatever_12345678' }),
    });
    expect(res.status).toBe(403);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a foreign Origin even with the header', async () => {
    const res = await call(makeEnv(), '/api/ms/logout', {
      method: 'POST',
      headers: { 'X-SnapDrive': '1', Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin call, or one with no Origin header', async () => {
    expect((await post(makeEnv(), '/api/ms/logout', undefined)).status).toBe(204);
    const res = await call(makeEnv(), '/api/ms/logout', { method: 'POST', headers: { 'X-SnapDrive': '1' } });
    expect(res.status).toBe(204);
  });

  it('accepts DEV_ORIGINS only when configured', async () => {
    const init = { method: 'POST', headers: { 'X-SnapDrive': '1', Origin: 'http://localhost:5192' } };
    expect((await call(makeEnv(), '/api/ms/logout', init)).status).toBe(403);
    expect((await call(makeEnv({ DEV_ORIGINS: 'http://localhost:5192' }), '/api/ms/logout', init)).status).toBe(204);
  });
});
