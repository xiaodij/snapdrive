// SnapDrive v2 Worker. Static files are served straight from assets (dist/); only /api/*
// runs here. See docs/ARCHITECTURE.md for the route contract.
//
// The Worker stores nothing. Its two jobs are the ones a browser cannot do alone: keep a
// OneDrive refresh token alive past Microsoft's 24-hour SPA cap (ms.ts), and reach Resend,
// which refuses browser calls (resend.ts). Both secrets live sealed in the user's own cookies.
//
// Logging: route, method, status, timing and upstream status codes only. Never request
// bodies, headers, cookies, tokens, API keys or email addresses.

import type { Env, Handler, RequestLog } from './env';
import { VERSION } from './env';
import { json } from './http';
import * as ms from './ms';
import * as resend from './resend';
import { ConfigError } from './seal';

const health: Handler = () => json({ ok: true, version: VERSION });

const config: Handler = (_request, env) =>
  json({
    onedrive: Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET),
    tenant: env.MS_TENANT || 'consumers',
    resendOAuth: resend.oauthConfigured(env),
  });

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  '/api/health': { GET: health },
  '/api/config': { GET: config },
  '/api/ms/login': { GET: ms.login },
  '/api/ms/callback': { GET: ms.callback },
  '/api/ms/token': { POST: ms.token },
  '/api/ms/logout': { POST: ms.logout },
  '/api/ms/chunk': { PUT: ms.chunk },
  '/api/resend/login': { GET: resend.login },
  '/api/resend/callback': { GET: resend.callback },
  '/api/resend/connect': { POST: resend.connect },
  '/api/resend/status': { GET: resend.status },
  '/api/resend/domains': { GET: resend.domains },
  '/api/resend/emails': { POST: resend.emails },
  '/api/resend/disconnect': { POST: resend.disconnect },
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * CSRF guard for anything that changes state. The custom header cannot be sent cross-origin
 * without a CORS preflight, which this Worker never approves; the Origin check backs it up.
 */
function guard(request: Request, env: Env, url: URL): Response | null {
  if (SAFE_METHODS.has(request.method)) return null;
  if (request.headers.get('X-SnapDrive') !== '1') {
    return json({ error: 'forbidden', message: 'Missing X-SnapDrive header.' }, 403);
  }
  const origin = request.headers.get('Origin');
  if (origin !== null) {
    const allowed = new Set([url.origin, ...(env.DEV_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)]);
    if (!allowed.has(origin)) return json({ error: 'forbidden', message: 'Cross-origin request refused.' }, 403);
  }
  return null;
}

async function handleApi(request: Request, env: Env, url: URL, log: RequestLog): Promise<Response> {
  const route = ROUTES[url.pathname];
  if (!route) return json({ error: 'not_found' }, 404);
  const handler = route[request.method];
  if (!handler) {
    const response = json({ error: 'method_not_allowed' }, 405);
    response.headers.set('Allow', Object.keys(route).join(', '));
    return response;
  }
  const refused = guard(request, env, url);
  if (refused) return refused;
  try {
    return await handler(request, env, url, log);
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'misconfigured', message: error.message }, 500);
    console.error(JSON.stringify({ route: log.route, error: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: 'internal' }, 500);
  }
}

function finalize(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // run_worker_first only routes /api/* here, so this is a fallback for local tooling.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    const started = Date.now();
    const log: RequestLog = { route: url.pathname };
    const response = finalize(await handleApi(request, env, url, log));
    console.log(
      JSON.stringify({
        route: log.route,
        method: request.method,
        status: response.status,
        ms: Date.now() - started,
        ...(log.upstream !== undefined ? { upstream: log.upstream } : {}),
      }),
    );
    return response;
  },
};
