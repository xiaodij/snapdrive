// App updates.
//
// The service worker keeps the app working offline, which also means a home-screen app keeps
// running the version it installed until something tells it to look again. iOS rarely
// reloads a standalone app, so the app checks itself: on launch, when it comes back to the
// foreground (at most every 10 minutes), and when the user taps "Check for updates".
//
// /version.json is never cached and names the build that is live. If it differs from the
// running build, the service worker is asked to fetch the new one; once installed, "Install
// update" activates it and reloads. A scan in progress survives the reload (it lives in
// IndexedDB), and nothing is ever reloaded without the user tapping.
import { registerSW } from 'virtual:pwa-register';
import { createStore } from './store';

export interface UpdateState {
  /** Build running now. */
  current: string;
  /** Build live on the server, when known. */
  latest?: string;
  /** A new version is downloaded and waiting for "Install update". */
  ready: boolean;
  checking: boolean;
  lastChecked?: number;
  error?: string;
}

export const updateStore = createStore<UpdateState>({ current: __BUILD_ID__, ready: false, checking: false });

let applyUpdateFn: ((reload?: boolean) => Promise<void>) | null = null;
let registration: ServiceWorkerRegistration | undefined;
const AUTO_INTERVAL_MS = 10 * 60_000;

export function initUpdates(): void {
  if (!('serviceWorker' in navigator)) return;
  applyUpdateFn = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateStore.set((s) => ({ ...s, ready: true }));
    },
    onRegisteredSW(_url, r) {
      registration = r;
    },
  });
  void checkForUpdates({ quiet: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const last = updateStore.get().lastChecked ?? 0;
    if (Date.now() - last > AUTO_INTERVAL_MS) void checkForUpdates({ quiet: true });
  });
}

/** Returns 'available' when a newer build exists (it starts downloading in the background). */
export async function checkForUpdates({ quiet = false } = {}): Promise<'latest' | 'available' | 'offline'> {
  updateStore.set((s) => ({ ...s, checking: !quiet, error: undefined }));
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { build } = (await res.json()) as { build: string };
    const newer = build !== __BUILD_ID__;
    updateStore.set((s) => ({ ...s, latest: build, lastChecked: Date.now() }));
    if (newer) {
      // Ask the service worker to fetch the new version; onNeedRefresh fires when it is ready.
      await registration?.update().catch(() => {});
      return 'available';
    }
    return 'latest';
  } catch (err) {
    updateStore.set((s) => ({ ...s, error: quiet ? undefined : 'Could not reach the server.', lastChecked: Date.now() }));
    void err;
    return 'offline';
  } finally {
    updateStore.set((s) => ({ ...s, checking: false }));
  }
}

/** Activate the downloaded version and reload the app. */
export async function applyUpdate(): Promise<void> {
  if (applyUpdateFn && updateStore.get().ready) {
    await applyUpdateFn(true);
    return;
  }
  // No waiting service worker (first install, or the browser already took the update):
  // a plain reload picks up the new files.
  location.reload();
}

/** "2026-11-13T18:40Z 517fc89" → "Nov 13, 18:40 UTC · 517fc89" */
export function describeBuild(build: string | undefined): string {
  if (!build) return 'unknown';
  const [stamp, commit] = build.split(' ');
  const d = new Date(stamp.replace('Z', ':00Z'));
  if (Number.isNaN(d.getTime())) return build;
  const when = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return commit ? `${when} · ${commit}` : when;
}
