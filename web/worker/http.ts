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
