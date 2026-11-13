// Calls to our own Worker (/api/*). Same-origin only; the X-SnapDrive header is the CSRF
// guard the Worker requires on every state-changing request.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** True when the failure is the network (offline, DNS, CORS), not an answer from a server. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof ApiError && err.status === 0);
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-SnapDrive', '1');
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, method, headers, credentials: 'same-origin', cache: 'no-store' });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const code = String(obj.error ?? obj.name ?? res.status);
    const message = String(obj.message ?? obj.error_description ?? obj.error ?? `${res.status} ${res.statusText}`);
    throw new ApiError(res.status, code, message, body);
  }
  return body as T;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRelative(date: number): string {
  const s = Math.round((Date.now() - date) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(date);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
