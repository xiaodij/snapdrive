// IndexedDB persistence. Three small key-value databases (idb-keyval allows one store per DB):
//   snapdrive-kv       settings, OneDrive account label, recents, Resend status cache
//   snapdrive-session  the scan in progress, so a scan survives iOS killing the app
//   snapdrive-outbox   finished PDFs waiting to be (re)sent
//
// Credentials are NOT here: the OneDrive refresh token and the Resend key live in HttpOnly
// cookies sealed by the Worker, out of reach of page script.
//
// Safari private browsing (and Playwright's WebKit) refuses to store Blobs in IndexedDB at all.
// A one-time probe detects that, and from then on Blobs are written as raw bytes instead.
import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';

const kv = createStore('snapdrive-kv', 'kv');
const session = createStore('snapdrive-session', 'session');
const outbox = createStore('snapdrive-outbox', 'jobs');

let blobsSupported: Promise<boolean> | null = null;

function probeBlobs(): Promise<boolean> {
  blobsSupported ??= (async () => {
    try {
      await set('__blob_probe__', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), kv);
      await del('__blob_probe__', kv);
      return true;
    } catch {
      return false;
    }
  })();
  return blobsSupported;
}

interface StoredBlob {
  __blob__: true;
  type: string;
  data: ArrayBuffer;
}

const isStoredBlob = (v: unknown): v is StoredBlob => !!v && typeof v === 'object' && (v as StoredBlob).__blob__ === true;

/** Replace every Blob in a plain object tree with its bytes. */
async function encode(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return { __blob__: true, type: value.type, data: await value.arrayBuffer() } satisfies StoredBlob;
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await encode(v);
    return out;
  }
  return value;
}

/** Inverse of `encode`; a no-op on records stored with native Blobs. */
function decode(value: unknown): unknown {
  if (isStoredBlob(value)) return new Blob([value.data], { type: value.type });
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.warn('storage unavailable', err);
    return fallback;
  }
}

export const db = {
  get: <T>(key: string, store: UseStore = kv) => safe(async () => decode(await get(key, store)) as T | undefined, undefined),
  set: (key: string, value: unknown, store: UseStore = kv) =>
    safe(async () => set(key, (await probeBlobs()) ? value : await encode(value), store), undefined),
  del: (key: string, store: UseStore = kv) => safe(() => del(key, store), undefined),
  entries: <T>(store: UseStore) =>
    safe(async () => (await entries<string, unknown>(store)).map(([k, v]) => [k, decode(v) as T] as [string, T]), [] as [string, T][]),
  stores: { kv, session, outbox },
};

/** Ask the browser not to evict our data under storage pressure. Best effort. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
