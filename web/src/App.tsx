import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from './services/api';
import { requestPersistence } from './services/db';
import { completeSignIn, initOneDrive, oneDriveStore, signIn, takeQueryParams } from './services/onedrive';
import { preloadOcr } from './services/ocr';
import { enqueue, loadOutbox, retryAutomatically, runJob, type Job } from './services/outbox';
import { completeResendConnect, formatFrom, initResend, isEmailAddress, resendStore } from './services/resend';
import { addCaptures, buildPdf, discardSession, ocrDone, pageReady, restoreSession, sessionStore, startSession } from './state/session';
import { loadSettings, settingsStore } from './state/settings';
import { applyUpdate, initUpdates, updateStore } from './state/update';
import { useStore } from './state/store';
import { Camera } from './ui/Camera';
import { Icon, Sheet, toast, ToastHost } from './ui/common';
import { CropEditor } from './ui/CropEditor';
import { FolderPicker } from './ui/FolderPicker';
import { Home } from './ui/Home';
import { Review } from './ui/Review';
import { SendSheet, type SendPhase } from './ui/SendSheet';
import { SettingsSheet } from './ui/Settings';
import { SetupSheet, type SetupStep } from './ui/Setup';

type Screen = 'home' | 'camera' | 'review';
type Overlay =
  | { kind: 'settings'; focus?: 'email' }
  | { kind: 'folders' }
  | { kind: 'crop'; pageId: string }
  | { kind: 'send'; phase: SendPhase }
  | { kind: 'share'; file: File }
  | { kind: 'setup'; step?: SetupStep };

export function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const session = useStore(sessionStore);

  const update = useStore(updateStore);

  // ── Startup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      await loadSettings();
      initUpdates();
      await Promise.all([initOneDrive(), initResend(), loadOutbox()]);
      const restored = await restoreSession();
      setReady(true);

      // Results of OneDrive / Resend connections arrive as query parameters.
      const back = takeQueryParams(['ms', 'resend', 'message', 'setup']);
      const signInResult = await completeSignIn({ ms: back.ms, message: back.message });
      if (signInResult) toast(signInResult.ok ? 'Signed in to OneDrive' : `OneDrive sign-in failed: ${signInResult.message}`, 5000);
      const resendResult = await completeResendConnect({ resend: back.resend, message: back.message });
      if (resendResult) toast(resendResult.ok ? 'Resend connected' : `Resend: ${resendResult.message}`, 5000);
      const s = settingsStore.get();
      if (back.setup) {
        setOverlay({ kind: 'setup', step: back.setup as SetupStep });
      } else if (!s.setupDone && !oneDriveStore.get().signedIn && !resendStore.get().connected && !restored) {
        setOverlay({ kind: 'setup' });
      }

      const params = new URLSearchParams(location.search);
      const shared = params.get('shared');
      if (params.has('resume') || shared) history.replaceState(null, '', '/');
      if (shared && shared !== 'error') {
        const files = await takeSharedFiles();
        if (files.length) {
          addCaptures(files);
          setScreen('review');
        }
      } else if (restored && params.get('resume') === 'review') {
        setScreen('review');
      }
      if (navigator.onLine) void retryAutomatically();
    })();
    const onOnline = () => void retryAutomatically();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const openCamera = useCallback(() => {
    if (!sessionStore.get()) startSession();
    const s = settingsStore.get();
    if (s.ocr) preloadOcr(s.ocrLangs);
    void requestPersistence();
    setScreen('camera');
  }, []);

  const importFiles = useCallback((files: File[]) => {
    if (!sessionStore.get()) startSession();
    const s = settingsStore.get();
    if (s.ocr) preloadOcr(s.ocrLangs);
    addCaptures(files);
    setScreen('review');
  }, []);

  const closeCamera = useCallback(() => {
    const s = sessionStore.get();
    if (s && s.pages.length) setScreen('review');
    else {
      void discardSession();
      setScreen('home');
    }
  }, []);

  const discard = useCallback(() => {
    if (!confirm('Discard this scan?')) return;
    void discardSession();
    setScreen('home');
  }, []);

  // ── Sending ────────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const s = settingsStore.get();
    const od = oneDriveStore.get();
    const rs = resendStore.get();
    const toOneDrive = s.sendToOneDrive && od.available;
    const byEmail = s.sendByEmail && rs.connected && isEmailAddress(s.email.fromAddress) && s.email.to.length > 0;
    if (toOneDrive && !od.signedIn) {
      signIn('/?resume=review');
      return;
    }
    if (!toOneDrive && !byEmail) return;

    setOverlay({ kind: 'send', phase: { kind: 'preparing', detail: 'Finishing pages…' } });
    try {
      const built = await buildPdf();
      const name = built.filename.replace(/\.pdf$/i, '');
      const subject =
        s.email.subject
          .replace(/\{name\}/g, name)
          .replace(/\{date\}/g, new Date().toLocaleDateString())
          .replace(/\{pages\}/g, String(built.pageCount))
          .trim() || name;
      const job = await enqueue({
        filename: built.filename,
        pageCount: built.pageCount,
        byteCount: built.pdf.size,
        pdf: built.pdf,
        text: built.text,
        onedrive: toOneDrive ? { folder: s.folder, state: 'pending' } : undefined,
        email: byEmail
          ? {
              from: formatFrom(s.email.fromName, s.email.fromAddress),
              to: s.email.to,
              cc: s.email.cc,
              replyTo: s.email.replyTo || undefined,
              subject,
              message: s.email.message,
              includeText: s.email.includeText,
              state: 'pending',
            }
          : undefined,
      });
      // The PDF is safe in the outbox now; the scan itself is no longer needed.
      await discardSession();
      setScreen('home');
      setOverlay({ kind: 'send', phase: { kind: 'sending', jobId: job.id } });
      void runJob(job.id);
    } catch (err) {
      setOverlay({ kind: 'send', phase: { kind: 'error', message: (err as Error).message } });
    }
  }, []);

  const share = useCallback(async () => {
    setOverlay({ kind: 'send', phase: { kind: 'preparing', detail: 'Finishing pages…' } });
    try {
      const built = await buildPdf();
      setOverlay({ kind: 'share', file: new File([built.pdf], built.filename, { type: 'application/pdf' }) });
    } catch (err) {
      setOverlay({ kind: 'send', phase: { kind: 'error', message: (err as Error).message } });
    }
  }, []);

  const shareJob = useCallback((job: Job) => {
    setOverlay({ kind: 'share', file: new File([job.pdf], job.filename, { type: 'application/pdf' }) });
  }, []);

  if (!ready) return null;

  const cropPage = overlay?.kind === 'crop' ? session?.pages.find((p) => p.id === overlay.pageId) : undefined;

  return (
    <>
      {screen === 'home' && (
        <Home
          onScan={openCamera}
          onImport={importFiles}
          onResume={() => setScreen('review')}
          onSettings={() => setOverlay({ kind: 'settings' })}
          onPickFolder={() => setOverlay({ kind: 'folders' })}
          onEmailSettings={() => setOverlay({ kind: 'settings', focus: 'email' })}
          onShareJob={shareJob}
          onSetup={() => setOverlay({ kind: 'setup' })}
          updateReady={update.ready}
          onUpdate={() => void applyUpdate()}
        />
      )}
      {screen === 'camera' && <Camera onDone={() => setScreen('review')} onClose={closeCamera} />}
      {screen === 'review' && session && (
        <Review
          onAddPages={openCamera}
          onAddFiles={(files) => addCaptures(files)}
          onDiscard={discard}
          onSend={() => void send()}
          onShare={() => void share()}
          onEditCorners={(pageId) => setOverlay({ kind: 'crop', pageId })}
          onPickFolder={() => setOverlay({ kind: 'folders' })}
          onEmailSettings={() => setOverlay({ kind: 'settings', focus: 'email' })}
        />
      )}
      {screen === 'review' && !session && <EmptyReview onHome={() => setScreen('home')} />}

      {overlay?.kind === 'settings' && (
        <SettingsSheet
          focus={overlay.focus}
          onClose={() => setOverlay(null)}
          onPickFolder={() => setOverlay({ kind: 'folders' })}
          onSetup={() => setOverlay({ kind: 'setup' })}
        />
      )}
      {overlay?.kind === 'folders' && <FolderPicker onClose={() => setOverlay(null)} />}
      {cropPage && <CropEditor page={cropPage} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'send' && (
        <SendSheet
          phase={overlay.phase.kind === 'preparing' ? { kind: 'preparing', detail: preparingDetail() } : overlay.phase}
          onDone={() => setOverlay(null)}
          onBack={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'share' && <ShareSheet file={overlay.file} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'setup' && (
        <SetupSheet
          step={overlay.step}
          onClose={() => setOverlay(null)}
          onPickFolder={() => setOverlay({ kind: 'folders' })}
        />
      )}
      <ToastHost />
    </>
  );
}

function preparingDetail(): string {
  const s = sessionStore.get();
  if (!s) return '';
  const rendering = s.pages.filter((p) => !p.error && !pageReady(p, s)).length;
  if (rendering) return `Processing ${s.pages.length - rendering + 1} of ${s.pages.length} pages…`;
  const reading = s.pages.filter((p) => !p.error && !ocrDone(p)).length;
  if (reading) {
    const pct = s.ocrProgress !== undefined ? ` (${Math.round(s.ocrProgress * 100)}%)` : '';
    return `Reading text, page ${s.pages.length - reading + 1} of ${s.pages.length}${pct}…`;
  }
  return 'Writing PDF…';
}

function EmptyReview({ onHome }: { onHome: () => void }) {
  return (
    <div className="screen">
      <div className="content" style={{ display: 'grid', placeItems: 'center' }}>
        <button className="btn" onClick={onHome}>
          Back
        </button>
      </div>
    </div>
  );
}

/**
 * Share or download a finished PDF. A separate tap is needed because iOS only allows the
 * share sheet straight after a user gesture, and building the PDF can take a few seconds.
 */
function ShareSheet({ file, onClose }: { file: File; onClose: () => void }) {
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const download = () => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <Sheet title="PDF ready" onClose={onClose}>
      <div className="result">
        <span style={{ color: 'var(--accent)' }}>
          <Icon name="doc" />
        </span>
        <h2>{file.name}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {formatBytes(file.size)}
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
        {canShare && (
          <button
            className="btn"
            onClick={() =>
              void navigator.share({ files: [file], title: file.name }).catch((err: DOMException) => {
                if (err.name !== 'AbortError') toast(`Could not share: ${err.message}`);
              })
            }
          >
            <Icon name="share" /> Share…
          </button>
        )}
        <button className={`btn${canShare ? ' secondary' : ''}`} onClick={download}>
          Save to device
        </button>
      </div>
    </Sheet>
  );
}

/** Photos shared into the app on Android, parked by the service worker (share-target-sw.js). */
async function takeSharedFiles(): Promise<File[]> {
  try {
    const cache = await caches.open('snapdrive-shared');
    const keys = await cache.keys();
    const files: File[] = [];
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const blob = await res.blob();
        const name = decodeURIComponent(res.headers.get('X-Filename') ?? 'photo.jpg');
        files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      }
      await cache.delete(req);
    }
    return files;
  } catch {
    return [];
  }
}
