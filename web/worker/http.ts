// Small response helpers shared by the route modules.

export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function empty(status = 204, cookies: string[] = []): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

/** Re-emit an upstream response's status and body under our own (mutable) headers. */
export async function passthrough(upstream: Response): Promise<Response> {
  const nullBody = [101, 204, 205, 304].includes(upstream.status);
  const body = nullBody ? null : await upstream.arrayBuffer();
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
  });
  return new Response(body, { status: upstream.status, headers });
}

/** JSON body of an upstream response, or null if it has none or it is not JSON. */
export async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** First line of an upstream error description, trimmed for display in the app. */
export function firstLine(message: string | undefined, max = 300): string {
  const line = (message ?? '').split(/\r?\n/)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Declared body size exceeds `max`, or the header is malformed. */
export function declaredTooLarge(request: Request, max: number): boolean {
  const declared = request.headers.get('Content-Length');
  if (declared === null) return false;
  const size = Number(declared);
  return !Number.isFinite(size) || size > max;
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

/**
 * The return path with a sign-in outcome added as QUERY parameters (`/?resume=review&ms=ok`).
 *
 * Never a #fragment: in iOS home-screen web apps a change to the URL hash revokes the camera
 * permission the user just granted (WebKit bug 215884), so a fragment here would cost them
 * another permission prompt after every sign-in.
 */
export function withResult(path: string, params: Record<string, string>): string {
  const target = new URL(path, 'https://return.invalid');
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.pathname + target.search;
}

/** Copy of `response` with extra Set-Cookie headers appended. */
export function withCookies(response: Response, cookies: string[]): Response {
  if (!cookies.length) return response;
  const out = new Response(response.body, response);
  for (const cookie of cookies) out.headers.append('Set-Cookie', cookie);
  return out;
}
