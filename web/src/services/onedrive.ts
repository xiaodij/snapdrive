// OneDrive via Microsoft Graph, called straight from the page with an access token minted by
// the Worker's token broker (/api/ms/token). The refresh token never reaches page script.
import { createStore } from '../state/store';
import type { FolderRef } from '../state/settings';
import { api, ApiError } from './api';
import { db } from './db';

const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Graph accepts a plain PUT up to 4 MB; larger files need an upload session. */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Session chunks must be multiples of 320 KiB. */
const CHUNK = 320 * 1024 * 10;

export interface Account {
  displayName: string;
  email: string;
}

export interface OneDriveState {
  /** False until /api/config says the Worker has a Microsoft client secret. */
  available: boolean;
  signedIn: boolean;
  account: Account | null;
}

export const oneDriveStore = createStore<OneDriveState>({ available: false, signedIn: false, account: null });

export class SignedOutError extends Error {
  constructor() {
    super('Signed out of OneDrive. Sign in again to upload.');
  }
}

export interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  childCount?: number;
  webUrl?: string;
}

let token: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

export async function initOneDrive(): Promise<void> {
  const account = (await db.get<Account>('onedrive.account')) ?? null;
  oneDriveStore.set((s) => ({ ...s, account, signedIn: !!account }));
  try {
    const cfg = await api<{ onedrive: boolean }>('/api/config');
    oneDriveStore.set((s) => ({ ...s, available: !!cfg.onedrive }));
  } catch {
    // Offline: assume the last known state; uploads will queue in the outbox anyway.
    oneDriveStore.set((s) => ({ ...s, available: s.signedIn }));
  }
}

/** Full-page redirect through Microsoft sign-in; the Worker brings us back to `returnTo`. */
export function signIn(returnTo = '/'): void {
  location.href = `/api/ms/login?return=${encodeURIComponent(returnTo)}`;
}

/** Called once on load when the URL fragment carries the sign-in outcome. */
export async function completeSignIn(): Promise<{ ok: boolean; message?: string } | null> {
  const hash = new URLSearchParams(location.hash.slice(1));
  const outcome = hash.get('ms');
  if (!outcome) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (outcome !== 'ok') return { ok: false, message: hash.get('message') ?? 'Sign-in failed.' };
  token = null;
  try {
    const me = await graph<{ displayName?: string; userPrincipalName?: string; mail?: string }>('/me?$select=displayName,userPrincipalName,mail');
    const account: Account = {
      displayName: me.displayName || 'OneDrive',
      email: me.userPrincipalName || me.mail || '',
    };
    await db.set('onedrive.account', account);
    oneDriveStore.set((s) => ({ ...s, signedIn: true, account }));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function signOut(): Promise<void> {
  token = null;
  await db.del('onedrive.account');
  oneDriveStore.set((s) => ({ ...s, signedIn: false, account: null }));
  try {
    await api('/api/ms/logout', { method: 'POST' });
  } catch {
    /* cookie stays until it expires; harmless */
  }
}

async function markSignedOut(): Promise<never> {
  token = null;
  await db.del('onedrive.account');
  oneDriveStore.set((s) => ({ ...s, signedIn: false, account: null }));
  throw new SignedOutError();
}

export async function accessToken(): Promise<string> {
  // 60 s of slack so a token cannot expire mid-upload.
  if (token && token.expiresAt - Date.now() > 60_000) return token.value;
  inflight ??= (async () => {
    try {
      const r = await api<{ access_token: string; expires_in: number }>('/api/ms/token', { method: 'POST' });
      token = { value: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
      return token.value;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return markSignedOut();
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function graph<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await accessToken()}`);
  const res = await fetch(path.startsWith('http') ? path : GRAPH + path, { ...init, headers });
  if (res.status === 401 && !retried) {
    token = null;
    return graph<T>(path, init, true);
  }
  if (!res.ok) throw await graphError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function graphError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    message = body?.error?.message ?? message;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, 'graph', `OneDrive returned ${res.status}: ${message}`);
}

function itemFromGraph(raw: { id: string; name: string; folder?: { childCount?: number }; webUrl?: string }): DriveItem {
  return { id: raw.id, name: raw.name, isFolder: !!raw.folder, childCount: raw.folder?.childCount, webUrl: raw.webUrl };
}

const childrenPath = (folder: FolderRef) =>
  folder.id ? `/me/drive/items/${encodeURIComponent(folder.id)}/children` : '/me/drive/root/children';

export async function listFolders(folder: FolderRef): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  // Graph pages at 200 items; follow @odata.nextLink so large folders list fully.
  let next: string | undefined = `${childrenPath(folder)}?$top=200&$select=id,name,folder,webUrl`;
  while (next) {
    const page: { value: Parameters<typeof itemFromGraph>[0][]; '@odata.nextLink'?: string } = await graph(next);
    items.push(...page.value.map(itemFromGraph));
    next = page['@odata.nextLink'];
  }
  return items.filter((i) => i.isFolder).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function createFolder(name: string, parent: FolderRef): Promise<DriveItem> {
  const raw = await graph<Parameters<typeof itemFromGraph>[0]>(childrenPath(parent), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
  });
  return itemFromGraph(raw);
}

/** Graph path segment for "<folder>/<filename>". */
function itemPath(folder: FolderRef, filename: string): string {
  const name = encodeURIComponent(filename);
  return folder.id ? `/me/drive/items/${encodeURIComponent(folder.id)}:/${name}:` : `/me/drive/root:/${name}:`;
}

/** PUT with byte-level progress. fetch() has no upload progress, so this uses XHR. */
function xhrPut(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (sent: number) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    // status 0: offline, or the browser refused the request (CORS / CSP).
    xhr.onerror = () => reject(new TypeError('network'));
    xhr.onabort = () => reject(new TypeError('aborted'));
    xhr.send(body);
  });
}

export interface UploadResult {
  id: string;
  name: string;
  webUrl?: string;
}

/**
 * Upload a file, never overwriting: a name clash gets renamed by OneDrive
 * (a scan should never silently destroy a file that happens to share its name).
 */
export async function upload(
  file: Blob,
  filename: string,
  folder: FolderRef,
  onProgress: (fraction: number) => void = () => {},
): Promise<UploadResult> {
  if (file.size <= SIMPLE_UPLOAD_LIMIT) {
    const url = `${GRAPH}${itemPath(folder, filename)}/content?@microsoft.graph.conflictBehavior=rename`;
    const attempt = async () =>
      xhrPut(url, file, { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/pdf' }, (sent) =>
        onProgress(Math.min(0.99, sent / file.size)),
      );
    let res = await attempt();
    if (res.status === 401) {
      token = null;
      res = await attempt();
    }
    if (res.status < 200 || res.status >= 300) throw uploadError(res);
    onProgress(1);
    return pickItem(JSON.parse(res.body));
  }
  return sessionUpload(file, filename, folder, onProgress);
}

async function sessionUpload(
  file: Blob,
  filename: string,
  folder: FolderRef,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  const created = await graph<{ uploadUrl: string }>(`${itemPath(folder, filename)}/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  });
  const uploadUrl = created.uploadUrl;
  // Upload URLs carry their own credentials. If the browser cannot PUT to them directly
  // (CORS), the Worker relays the chunk instead; the choice sticks for the whole file.
  let relay = false;
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const chunk = file.slice(offset, end);
    const range = `bytes ${offset}-${end - 1}/${file.size}`;
    const progress = (sent: number) => onProgress(Math.min(0.99, (offset + sent) / file.size));
    let res: { status: number; body: string };
    if (!relay) {
      try {
        res = await xhrPut(uploadUrl, chunk, { 'Content-Range': range }, progress);
      } catch {
        relay = true;
      }
    }
    if (relay) {
      const r = await fetch('/api/ms/chunk', {
        method: 'PUT',
        headers: { 'X-SnapDrive': '1', 'X-Upload-Url': uploadUrl, 'Content-Range': range },
        body: chunk,
        credentials: 'same-origin',
      });
      res = { status: r.status, body: await r.text() };
    }
    const { status, body } = res!;
    if (status === 200 || status === 201) {
      onProgress(1);
      return pickItem(JSON.parse(body));
    }
    if (status !== 202) throw uploadError({ status, body });
    offset = end;
    onProgress(offset / file.size);
  }
  throw new Error('Upload ended without OneDrive confirming the file.');
}

function pickItem(raw: { id: string; name: string; webUrl?: string }): UploadResult {
  return { id: raw.id, name: raw.name, webUrl: raw.webUrl };
}

function uploadError(res: { status: number; body: string }): ApiError {
  let message = res.body.slice(0, 200);
  try {
    message = JSON.parse(res.body)?.error?.message ?? message;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, 'graph', `OneDrive returned ${res.status}: ${message}`);
}
