// Bindings, secrets and vars the Worker reads. Typed with plain web types only, so this
// compiles both under @cloudflare/workers-types (worker/tsconfig.json) and under the DOM lib
// the vitest suite is checked with.

export interface Env {
  /** Static assets binding (dist/). Only /api/* reaches the Worker in production. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Secret. 32 random bytes, base64. Seals every cookie the Worker sets. */
  SEAL_KEY?: string;
  /** Var. Azure "Application (client) ID". */
  MS_CLIENT_ID?: string;
  /** Secret. Azure client secret for the Web platform redirect URI. */
  MS_CLIENT_SECRET?: string;
  /** Var. `consumers`, `organizations`, `common`, or a tenant id. */
  MS_TENANT?: string;
  /**
   * Local development only (.dev.vars): extra origins the CSRF guard accepts, comma-separated,
   * e.g. a Vite dev server that proxies /api here. Never set in production.
   */
  DEV_ORIGINS?: string;
}

export const VERSION = '2.0.0';

/** Per-request facts for the access log. Never holds secrets, tokens or personal data. */
export interface RequestLog {
  route: string;
  /** Status code Microsoft or Resend answered with, when the route called them. */
  upstream?: number;
}

export type Handler = (request: Request, env: Env, url: URL, log: RequestLog) => Promise<Response> | Response;
