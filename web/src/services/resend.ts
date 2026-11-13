// Email through the user's own Resend account, relayed by our Worker (Resend's API refuses
// browser calls). The key is sealed into an HttpOnly cookie when connecting; page script
// never holds it afterwards.
import { createStore } from '../state/store';
import { api } from './api';
import { db } from './db';

export type ResendAccess = 'full' | 'sending';

export interface ResendDomain {
  name: string;
  status: string;
}

export interface ResendState {
  connected: boolean;
  access?: ResendAccess;
  keyHint?: string;
  /** 'oauth': connected through Resend's approval page; 'key': a pasted API key. */
  method?: 'oauth' | 'key';
  domains?: ResendDomain[];
  /** The server can connect accounts through Resend OAuth (no key copying). */
  oauthAvailable?: boolean;
}

// Resend rotates its OAuth refresh token on every use and cancels the whole connection if an
// old one is used again. The Worker refreshes inside whichever call finds the access token
// expired, so two calls at once could both refresh with the same token. Every call to the
// relay therefore goes through this one-at-a-time queue.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export const resendStore = createStore<ResendState>({ connected: false });

const CACHE_KEY = 'resend.status';

export async function initResend(): Promise<void> {
  const cached = await db.get<ResendState>(CACHE_KEY);
  if (cached) resendStore.set(cached);
  try {
    const [s, cfg] = await Promise.all([
      serial(() => api<{ connected: boolean; access?: ResendAccess; keyHint?: string; method?: 'oauth' | 'key' }>('/api/resend/status')),
      api<{ resendOAuth?: boolean }>('/api/config').catch(() => ({ resendOAuth: false })),
    ]);
    const next: ResendState = { ...s, oauthAvailable: !!cfg.resendOAuth, domains: s.connected ? cached?.domains : undefined };
    resendStore.set(next);
    await db.set(CACHE_KEY, next);
  } catch {
    /* offline: keep the cached view */
  }
}

/** Full-page trip to Resend's approval screen; the Worker brings us back with ?resend=ok. */
export function connectResendOAuth(returnTo = '/'): void {
  location.href = `/api/resend/login?return=${encodeURIComponent(returnTo)}`;
}

export async function connectResend(apiKey: string): Promise<ResendState> {
  const r = await serial(() =>
    api<{ access: ResendAccess; keyHint: string; domains?: ResendDomain[] }>('/api/resend/connect', {
      method: 'POST',
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    }),
  );
  const next: ResendState = { connected: true, method: 'key', access: r.access, keyHint: r.keyHint, domains: r.domains, oauthAvailable: resendStore.get().oauthAvailable };
  resendStore.set(next);
  await db.set(CACHE_KEY, next);
  return next;
}

export async function disconnectResend(): Promise<void> {
  try {
    await serial(() => api('/api/resend/disconnect', { method: 'POST' }));
  } finally {
    resendStore.set({ connected: false, oauthAvailable: resendStore.get().oauthAvailable });
    await db.del(CACHE_KEY);
  }
}

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc?: string[];
  reply_to?: string;
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: string }[];
}

/** Returns Resend's email id. `idempotencyKey` makes retries safe (Resend de-duplicates). */
export async function sendEmail(email: OutgoingEmail, idempotencyKey: string): Promise<string> {
  const body = { ...email, cc: email.cc?.length ? email.cc : undefined, reply_to: email.reply_to || undefined };
  try {
    const r = await serial(() =>
      api<{ id: string }>('/api/resend/emails', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      }),
    );
    return r.id;
  } catch (err) {
    // The connection expired or was revoked in Resend: show it as disconnected.
    if ((err as { status?: number; code?: string }).status === 401) {
      resendStore.set({ connected: false, oauthAvailable: resendStore.get().oauthAvailable });
      await db.del(CACHE_KEY);
    }
    throw err;
  }
}

/** Resend's limit is 40 MB per email after base64 (which grows data by a third). */
export const EMAIL_ATTACHMENT_LIMIT = Math.floor((40 * 1024 * 1024) / 1.37) - 64 * 1024;

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function isEmailAddress(s: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(s.trim());
}

/** Split a typed list ("a@x.com, b@y.com; c@z.com") into addresses. */
export function parseAddressList(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function formatFrom(name: string, address: string): string {
  const clean = name.replace(/["<>\r\n]/g, '').trim();
  return clean ? `${clean} <${address.trim()}>` : address.trim();
}

/** Called once on load when the URL carries the result of a Resend connection. */
export async function completeResendConnect(params: { resend?: string; message?: string }): Promise<{ ok: boolean; message?: string } | null> {
  if (!params.resend) return null;
  if (params.resend !== 'ok') return { ok: false, message: params.message ?? 'Could not connect Resend.' };
  await initResend();
  return { ok: resendStore.get().connected };
}

/** A short email to the configured recipients, to prove the setup works end to end. */
export async function sendTestEmail(from: string, to: string[], replyTo?: string): Promise<string> {
  return sendEmail(
    {
      from,
      to,
      reply_to: replyTo,
      subject: 'SnapDrive is connected',
      html: '<p>This is a test from SnapDrive. Scans you email will arrive like this, with the PDF attached.</p>',
      text: 'This is a test from SnapDrive. Scans you email will arrive like this, with the PDF attached.',
      attachments: [],
    },
    `snapdrive-test-${Date.now()}`,
  );
}
