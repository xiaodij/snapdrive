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
  domains?: ResendDomain[];
}

export const resendStore = createStore<ResendState>({ connected: false });

const CACHE_KEY = 'resend.status';

export async function initResend(): Promise<void> {
  const cached = await db.get<ResendState>(CACHE_KEY);
  if (cached) resendStore.set(cached);
  try {
    const s = await api<{ connected: boolean; access?: ResendAccess; keyHint?: string }>('/api/resend/status');
    const next: ResendState = { ...s, domains: s.connected ? cached?.domains : undefined };
    resendStore.set(next);
    await db.set(CACHE_KEY, next);
  } catch {
    /* offline: keep the cached view */
  }
}

export async function connectResend(apiKey: string): Promise<ResendState> {
  const r = await api<{ access: ResendAccess; keyHint: string; domains?: ResendDomain[] }>('/api/resend/connect', {
    method: 'POST',
    body: JSON.stringify({ apiKey: apiKey.trim() }),
  });
  const next: ResendState = { connected: true, access: r.access, keyHint: r.keyHint, domains: r.domains };
  resendStore.set(next);
  await db.set(CACHE_KEY, next);
  return next;
}

export async function disconnectResend(): Promise<void> {
  try {
    await api('/api/resend/disconnect', { method: 'POST' });
  } finally {
    resendStore.set({ connected: false });
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
  const r = await api<{ id: string }>('/api/resend/emails', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return r.id;
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
