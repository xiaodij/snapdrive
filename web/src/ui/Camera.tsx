// Live document camera: the job VisionKit's VNDocumentCameraViewController did in v1.
//
// The viewfinder runs page detection a few times a second on a small copy of the frame and
// draws the outline. With auto-capture on, a page that holds still for about a second is
// taken automatically; the next auto-capture waits until the page is moved or swapped, so one
// sheet is never captured twice. Every capture starts processing in the background at once.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fitLongEdge, type Quad } from '../core/raster';
import { pipeline } from '../services/pipeline';
import { addCaptures, sessionStore } from '../state/session';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { Icon, useObjectUrl } from './common';

const DETECT_EDGE = 480;
const DETECT_INTERVAL_MS = 110;
const STABLE_MS = 1000;
const MIN_CONFIDENCE = 0.55;

type CamState = { kind: 'starting' } | { kind: 'live' } | { kind: 'failed'; message: string };

export function Camera({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const settings = useStore(settingsStore);
  const session = useStore(sessionStore);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<CamState>({ kind: 'starting' });
  const [quad, setQuad] = useState<Quad | null>(null);
  const [stableFor, setStableFor] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [lastShot, setLastShot] = useState<Blob | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [capturing, setCapturing] = useState(false);
  /** Live frames below ~2500 px are soft for fine print; the system camera takes full stills. */
  const [lowRes, setLowRes] = useState(false);
  const lastThumb = useObjectUrl(lastShot);
  const pageCount = session?.pages.length ?? 0;

  // Detection bookkeeping lives in refs: it changes every frame and must not re-render.
  const track = useRef({ quad: null as Quad | null, since: 0, armed: true, misses: 0, lastCapturedCenter: null as { x: number; y: number } | null });

  // ── Stream lifecycle ───────────────────────────────────────────────────────
  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    setCam({ kind: 'starting' });
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam({ kind: 'failed', message: 'This browser does not allow camera access from a web page.' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      const vt = stream.getVideoTracks()[0];
      const caps = (vt.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorch(caps.torch ? false : null);
      const set = vt.getSettings();
      setLowRes(!('ImageCapture' in window) && Math.max(set.width ?? 0, set.height ?? 0) < 2500);
      setCam({ kind: 'live' });
    } catch (err) {
      const name = (err as DOMException).name;
      setCam({
        kind: 'failed',
        message:
          name === 'NotAllowedError'
            ? 'Camera access was declined. Allow it in your browser settings, or use the system camera below.'
            : name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : 'The camera could not be started.',
      });
    }
  }, [stop]);

  useEffect(() => {
    void start();
    const onVisibility = () => {
      if (document.hidden) stop();
      else void start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [start, stop]);

  // ── Capture ────────────────────────────────────────────────────────────────
  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || capturing) return;
    setCapturing(true);
    try {
      const blob = (await takeStill(streamRef.current)) ?? (await grabFrame(video));
      if (!blob) return;
      setFlashKey((k) => k + 1);
      setLastShot(blob);
      navigator.vibrate?.(30);
      const t = track.current;
      t.armed = false;
      t.lastCapturedCenter = t.quad ? centre(t.quad) : null;
      addCaptures([blob]);
    } finally {
      setCapturing(false);
    }
  }, [capturing]);

  // ── Detection loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (cam.kind !== 'live') return;
    let cancelled = false;
    let busy = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const tick = async () => {
      const video = videoRef.current;
      if (cancelled || busy || !video || !video.videoWidth || video.readyState < 2) return;
      busy = true;
      try {
        const size = fitLongEdge(video.videoWidth, video.videoHeight, DETECT_EDGE);
        canvas.width = size.width;
        canvas.height = size.height;
        ctx.drawImage(video, 0, 0, size.width, size.height);
        const frame = ctx.getImageData(0, 0, size.width, size.height);
        const res = await pipeline.detect({ width: frame.width, height: frame.height, data: frame.data });
        if (cancelled) return;
        const sx = video.videoWidth / size.width;
        const sy = video.videoHeight / size.height;
        const q = res.quad && res.confidence >= MIN_CONFIDENCE ? (res.quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad) : null;
        onDetection(q, video.videoWidth, video.videoHeight);
      } catch {
        /* a dropped frame is fine */
      } finally {
        busy = false;
      }
    };

    const onDetection = (q: Quad | null, vw: number, vh: number) => {
      const t = track.current;
      const diag = Math.hypot(vw, vh);
      const now = performance.now();
      if (!q) {
        t.misses++;
        if (t.misses >= 3) {
          t.quad = null;
          t.since = now;
          t.armed = true; // page removed: ready for the next one
          setQuad(null);
          setStableFor(0);
        }
        return;
      }
      t.misses = 0;
      const moved = t.quad ? maxCornerShift(t.quad, q) / diag : 1;
      if (moved > 0.02) t.since = now;
      // Light smoothing so the outline does not jitter.
      const shown = t.quad && moved < 0.08 ? (t.quad.map((p, i) => ({ x: p.x * 0.5 + q[i].x * 0.5, y: p.y * 0.5 + q[i].y * 0.5 })) as Quad) : q;
      t.quad = shown;
      setQuad(shown);
      if (!t.armed && t.lastCapturedCenter) {
        const c = centre(q);
        if (Math.hypot(c.x - t.lastCapturedCenter.x, c.y - t.lastCapturedCenter.y) / diag > 0.15) t.armed = true;
      }
      const stable = now - t.since;
      setStableFor(t.armed ? stable : 0);
      if (settingsStore.get().autoCapture && t.armed && stable >= STABLE_MS) void capture();
    };

    const timer = setInterval(() => void tick(), DETECT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cam.kind, capture]);

  const toggleTorch = async () => {
    const vt = streamRef.current?.getVideoTracks()[0];
    if (!vt || torch === null) return;
    try {
      await vt.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    if (!list.length) return;
    setLastShot(list[list.length - 1]);
    addCaptures(list);
  };

  // ── Overlay geometry (video uses object-fit: cover) ────────────────────────
  const overlay = (() => {
    const video = videoRef.current;
    const view = viewRef.current;
    if (!quad || !video || !view || !video.videoWidth) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const W = view.clientWidth;
    const H = view.clientHeight;
    const scale = Math.max(W / vw, H / vh);
    const ox = (W - vw * scale) / 2;
    const oy = (H - vh * scale) / 2;
    return quad.map((p) => `${ox + p.x * scale},${oy + p.y * scale}`).join(' ');
  })();
  const progress = settings.autoCapture ? Math.min(1, stableFor / STABLE_MS) : 0;

  return (
    <div className="camera">
      {cam.kind === 'failed' ? (
        <>
          <div className="camera-top">
            <button onClick={onClose}>Cancel</button>
            <span />
          </div>
          <div className="camera-fallback">
            <Icon name="camera" className="icon" />
            <p>{cam.message}</p>
            <label className="btn">
              <Icon name="camera" /> Take a photo
              <input className="sr-only" type="file" accept="image/*" capture="environment" onChange={(e) => onFiles(e.target.files)} />
            </label>
            <label className="btn secondary">
              <Icon name="photos" /> Choose photos
              <input className="sr-only" type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => onFiles(e.target.files)} />
            </label>
            {pageCount > 0 && (
              <button className="btn secondary" onClick={onDone}>
                Review {pageCount} page{pageCount === 1 ? '' : 's'}
              </button>
            )}
            <button className="link-btn" onClick={() => void start()}>
              Try the live camera again
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="camera-view" ref={viewRef}>
            <video ref={videoRef} playsInline muted autoPlay />
            <svg className="overlay" aria-hidden="true">
              {overlay && (
                <polygon
                  points={overlay}
                  fill={`rgba(39,115,199,${0.18 + progress * 0.25})`}
                  stroke={progress >= 1 ? '#ffd60a' : '#4a92e3'}
                  strokeWidth={3}
                  strokeLinejoin="round"
                />
              )}
            </svg>
            {flashKey > 0 && <div className="flash" key={flashKey} />}
            <div className="camera-top">
              <button onClick={onClose}>{pageCount ? 'Close' : 'Cancel'}</button>
              <div style={{ display: 'flex', gap: 8 }}>
                {torch !== null && (
                  <button aria-pressed={torch} onClick={() => void toggleTorch()}>
                    Light
                  </button>
                )}
                <button aria-pressed={settings.autoCapture} onClick={() => updateSettings({ autoCapture: !settings.autoCapture })}>
                  Auto
                </button>
                <label style={{ display: 'flex' }}>
                  <span className="sr-only">Use the system camera</span>
                  <button tabIndex={-1} onClick={(e) => (e.currentTarget.nextElementSibling as HTMLInputElement)?.click()}>
                    <Icon name="camera" />
                  </button>
                  <input className="sr-only" type="file" accept="image/*" capture="environment" onChange={(e) => onFiles(e.target.files)} />
                </label>
              </div>
            </div>
            <div className="camera-hint">
              {cam.kind === 'starting'
                ? 'Starting camera…'
                : lowRes && !quad
                  ? 'Fine print? The camera button (top right) takes full-resolution photos'
                : !quad
                  ? 'Point at a document'
                  : !track.current.armed
                    ? 'Captured. Place the next page'
                    : settings.autoCapture
                      ? 'Hold still…'
                      : 'Tap the shutter'}
            </div>
          </div>
          <div className="camera-bar">
            <div className="cam-side">
              <label>
                <span className="sr-only">Import photos</span>
                <button tabIndex={-1} onClick={(e) => (e.currentTarget.nextElementSibling as HTMLInputElement)?.click()}>
                  <Icon name="photos" />
                </button>
                <input className="sr-only" type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => onFiles(e.target.files)} />
              </label>
            </div>
            <button className={`shutter${capturing ? ' busy' : ''}`} aria-label="Capture page" onClick={() => void capture()} disabled={cam.kind !== 'live'} />
            <div className="cam-side right">
              {pageCount > 0 && (
                <button onClick={onDone} aria-label={`Done, review ${pageCount} pages`}>
                  {lastThumb && <img className="cam-thumb" src={lastThumb} alt="" />}
                  <span className="cam-count">{pageCount}</span>
                  Save
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function centre(q: Quad) {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}

function maxCornerShift(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

/**
 * Full-sensor still where the browser offers one (ImageCapture: Chrome on Android). Video frames
 * are capped at the stream's resolution, which is often well below the camera's.
 */
async function takeStill(stream: MediaStream | null): Promise<Blob | null> {
  const track = stream?.getVideoTracks()[0];
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  if (!track || !IC) return null;
  try {
    return await new IC(track).takePhoto();
  } catch {
    return null;
  }
}

async function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  return new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
}
