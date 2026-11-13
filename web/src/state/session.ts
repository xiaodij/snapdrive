// The scan in progress: pages from capture through review.
//
// Work runs in two serial background queues: image processing (pipeline worker) and OCR
// (tesseract). Each page records which geometry and render settings its current output was
// made with; whenever those lag behind what the user asked for, the queue picks the page up
// again. A result computed from superseded settings is discarded rather than displayed, the
// same guarantee v1's renderGeneration gave.
//
// The session is mirrored to IndexedDB, so a scan survives iOS evicting the app while the
// native camera is open, a sign-in redirect, or the user switching apps.
import type { Quad } from '../core/raster';
import { plainText, suggestedTitle } from '../core/text';
import type { ColorMode, ColorSelection, ProcessedPage, QualityTier, RecognizedLine, RenderedPage } from '../core/types';
import { db } from '../services/db';
import { recognize } from '../services/ocr';
import { decodeImage, pipeline } from '../services/pipeline';
import type { Rotation } from '../workers/protocol';
import { settingsStore } from './settings';
import { createStore } from './store';

export interface PageDraft {
  id: string;
  /** The photo as captured or imported. */
  original: Blob;
  origWidth?: number;
  origHeight?: number;
  /** Requested outline: 'auto' = detect, null = whole frame. */
  quad: Quad | 'auto' | null;
  autoQuad?: Quad | null;
  rotation: Rotation;
  geomVersion: number;
  doneGeom: number;
  doneRender: number;
  busy: boolean;
  error?: string;
  // Outputs
  source?: Blob;
  thumb?: Blob;
  preview?: Blob;
  detectedMode?: ColorMode;
  rendered?: RenderedPage;
  ocrImage?: Blob;
  ocrWidth?: number;
  ocrHeight?: number;
  /** undefined until OCR has run for the current geometry. */
  lines?: RecognizedLine[];
  ocrGeom?: number;
  ocrBusy?: boolean;
}

export interface Session {
  id: string;
  createdAt: number;
  pages: PageDraft[];
  selection: ColorSelection;
  tier: QualityTier;
  renderVersion: number;
  filename: string;
  filenameEdited: boolean;
  /** Fraction of the current OCR page done, for the progress label. */
  ocrProgress?: number;
}

export const sessionStore = createStore<Session | null>(null);

const SESSION_KEY = 'current';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function update(fn: (s: Session) => Session): void {
  sessionStore.set((s) => (s ? fn(s) : s));
  schedulePersist();
}

function updatePage(id: string, fn: (p: PageDraft) => PageDraft): void {
  update((s) => ({ ...s, pages: s.pages.map((p) => (p.id === id ? fn(p) : p)) }));
}

const page = (id: string) => sessionStore.get()?.pages.find((p) => p.id === id);

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function defaultFilename(title?: string | null): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  return title ? `${title} ${stamp}` : `Scan ${stamp}`;
}

export function startSession(): Session {
  const settings = settingsStore.get();
  const s: Session = {
    id: uid(),
    createdAt: Date.now(),
    pages: [],
    selection: settings.colorMode,
    tier: settings.quality,
    renderVersion: 1,
    filename: defaultFilename(),
    filenameEdited: false,
  };
  sessionStore.set(s);
  schedulePersist();
  return s;
}

export function addCaptures(blobs: Blob[]): void {
  if (!sessionStore.get()) startSession();
  const fresh: PageDraft[] = blobs.map((original) => ({
    id: uid(),
    original,
    quad: 'auto',
    rotation: 0,
    geomVersion: 1,
    doneGeom: 0,
    doneRender: 0,
    busy: false,
  }));
  update((s) => ({ ...s, pages: [...s.pages, ...fresh] }));
  kick();
}

export async function discardSession(): Promise<void> {
  sessionStore.set(null);
  await db.del(SESSION_KEY, db.stores.session);
}

export async function restoreSession(): Promise<boolean> {
  const saved = await db.get<Session>(SESSION_KEY, db.stores.session);
  if (!saved || !saved.pages?.length) return false;
  sessionStore.set({
    ...saved,
    ocrProgress: undefined,
    pages: saved.pages.map((p) => ({ ...p, busy: false, ocrBusy: false })),
  });
  kick();
  return true;
}

// ── Edits ────────────────────────────────────────────────────────────────────

export function setGeometry(id: string, quad: Quad | 'auto' | null, rotation: Rotation): void {
  updatePage(id, (p) => ({ ...p, quad, rotation, geomVersion: p.geomVersion + 1, error: undefined }));
  kick();
}

export function retryPage(id: string): void {
  updatePage(id, (p) => ({ ...p, geomVersion: p.geomVersion + 1, error: undefined }));
  kick();
}

export function removePage(id: string): void {
  update((s) => ({ ...s, pages: s.pages.filter((p) => p.id !== id) }));
}

export function movePage(id: string, delta: -1 | 1): void {
  update((s) => {
    const i = s.pages.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.pages.length) return s;
    const pages = [...s.pages];
    [pages[i], pages[j]] = [pages[j], pages[i]];
    return { ...s, pages };
  });
}

export function setSelection(selection: ColorSelection): void {
  update((s) => ({ ...s, selection, renderVersion: s.renderVersion + 1 }));
  kick();
}

export function setTier(tier: QualityTier): void {
  update((s) => ({ ...s, tier, renderVersion: s.renderVersion + 1 }));
  kick();
}

export function setFilename(filename: string): void {
  update((s) => ({ ...s, filename, filenameEdited: true }));
}

// ── Derived state ────────────────────────────────────────────────────────────

export function pageReady(p: PageDraft, s: Session): boolean {
  return !!p.rendered && p.doneGeom === p.geomVersion && p.doneRender === s.renderVersion;
}

export function ocrDone(p: PageDraft): boolean {
  return !settingsStore.get().ocr || (p.lines !== undefined && p.ocrGeom === p.geomVersion);
}

export function sessionSettled(s: Session): boolean {
  return s.pages.every((p) => p.error || (pageReady(p, s) && ocrDone(p)));
}

export function totalBytes(s: Session): number {
  return s.pages.reduce((n, p) => n + (p.rendered?.data.byteLength ?? 0), 0);
}

export function sanitizedFilename(name: string): string {
  const base = name.trim() || 'Scan';
  const stripped = base.replace(/[/\\:*?"<>|]/g, '-');
  return stripped.toLowerCase().endsWith('.pdf') ? stripped : `${stripped}.pdf`;
}

/** Resolves once every page is rendered with current settings and OCR has finished. */
export function whenSettled(): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = sessionStore.get();
      if (!s) {
        unsubscribe();
        reject(new Error('The scan was discarded.'));
        return true;
      }
      if (sessionSettled(s)) {
        unsubscribe();
        resolve();
        return true;
      }
      return false;
    };
    const unsubscribe = sessionStore.subscribe(() => void check());
    check();
  });
}

export async function buildPdf(): Promise<{ pdf: Blob; text: string; pageCount: number; filename: string }> {
  await whenSettled();
  const s = sessionStore.get();
  if (!s) throw new Error('No scan in progress.');
  const failed = s.pages.filter((p) => p.error);
  if (failed.length) throw new Error(`${failed.length} page(s) failed to process. Retake or remove them first.`);
  if (!s.pages.length) throw new Error('No pages to send.');
  const pages: ProcessedPage[] = s.pages.map((p) => ({
    ...p.rendered!,
    detectedMode: p.detectedMode ?? p.rendered!.mode,
    lines: p.lines ?? [],
  }));
  const filename = sanitizedFilename(s.filename);
  const bytes = await pipeline.pdf(pages, filename.replace(/\.pdf$/i, ''));
  const text = s.pages
    .map((p, i) => {
      const t = plainText(p.lines ?? []);
      return s.pages.length > 1 ? `--- Page ${i + 1} ---\n${t}` : t;
    })
    .join('\n\n');
  return { pdf: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), text, pageCount: pages.length, filename };
}

// ── Background work ──────────────────────────────────────────────────────────

let processing = false;
let ocrRunning = false;

function kick(): void {
  void runProcessing();
  void runOcr();
}

async function runProcessing(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const s = sessionStore.get();
      if (!s) return;
      // Geometry work first (new captures, crop edits), then re-renders.
      const next =
        s.pages.find((p) => !p.error && p.doneGeom !== p.geomVersion) ??
        s.pages.find((p) => !p.error && p.doneGeom === p.geomVersion && p.doneRender !== s.renderVersion);
      if (!next) return;
      await work(next, s);
    }
  } finally {
    processing = false;
  }
}

async function work(p: PageDraft, s: Session): Promise<void> {
  const geom = p.geomVersion;
  const render = s.renderVersion;
  const settings = settingsStore.get();
  updatePage(p.id, (x) => ({ ...x, busy: true }));
  try {
    if (p.doneGeom !== geom || !p.source) {
      const bitmap = await decodeImage(p.original);
      const r = await pipeline.process(bitmap, p.quad, p.rotation, s.selection, s.tier, settings.ocr);
      const now = page(p.id);
      if (!now || now.geomVersion !== geom) return; // superseded or removed while we worked
      updatePage(p.id, (x) => ({
        ...x,
        origWidth: r.width,
        origHeight: r.height,
        autoQuad: x.quad === 'auto' ? r.autoQuad : x.autoQuad,
        // Pin the detected outline so later re-renders and the crop editor agree with it.
        quad: x.quad === 'auto' ? r.quad : x.quad,
        source: r.source,
        thumb: r.thumb,
        preview: r.preview,
        detectedMode: r.detectedMode,
        rendered: r.rendered,
        ocrImage: r.ocrImage,
        ocrWidth: r.ocrWidth,
        ocrHeight: r.ocrHeight,
        lines: undefined,
        ocrGeom: undefined,
        doneGeom: geom,
        doneRender: render,
      }));
    } else {
      const r = await pipeline.rerender(p.source, s.selection, s.tier, p.detectedMode);
      const now = page(p.id);
      const cur = sessionStore.get();
      if (!now || !cur || now.geomVersion !== geom || cur.renderVersion !== render) return;
      updatePage(p.id, (x) => ({ ...x, rendered: r.rendered, preview: r.preview, detectedMode: r.detectedMode, doneRender: render }));
    }
  } catch (err) {
    updatePage(p.id, (x) => ({ ...x, error: (err as Error).message || 'Processing failed.' }));
  } finally {
    updatePage(p.id, (x) => ({ ...x, busy: false }));
    void runOcr();
  }
}

async function runOcr(): Promise<void> {
  if (ocrRunning || !settingsStore.get().ocr) return;
  ocrRunning = true;
  try {
    for (;;) {
      const s = sessionStore.get();
      if (!s) return;
      const next = s.pages.find((p) => p.ocrImage && p.doneGeom === p.geomVersion && p.ocrGeom !== p.geomVersion);
      if (!next) return;
      const geom = next.geomVersion;
      updatePage(next.id, (x) => ({ ...x, ocrBusy: true }));
      let lines: RecognizedLine[] = [];
      try {
        lines = await recognize(next.ocrImage!, next.ocrWidth!, next.ocrHeight!, settingsStore.get().ocrLangs, (f) =>
          sessionStore.set((cur) => (cur ? { ...cur, ocrProgress: f } : cur)),
        );
      } catch (err) {
        // OCR is an enhancement: a failure leaves the page without a text layer, not unsendable.
        console.warn('OCR failed', err);
      }
      const now = page(next.id);
      if (!now) continue;
      if (now.geomVersion !== geom) {
        updatePage(next.id, (x) => ({ ...x, ocrBusy: false }));
        continue;
      }
      updatePage(next.id, (x) => ({ ...x, lines, ocrGeom: geom, ocrBusy: false }));
      maybeSuggestTitle();
    }
  } finally {
    ocrRunning = false;
    sessionStore.set((cur) => (cur ? { ...cur, ocrProgress: undefined } : cur));
  }
}

function maybeSuggestTitle(): void {
  const s = sessionStore.get();
  if (!s || s.filenameEdited || !settingsStore.get().titleFromText) return;
  const first = s.pages[0];
  if (!first?.lines) return;
  const title = suggestedTitle(first.lines);
  if (title) update((x) => ({ ...x, filename: defaultFilename(title) }));
}

// ── Persistence ──────────────────────────────────────────────────────────────

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const s = sessionStore.get();
    if (s) void db.set(SESSION_KEY, s, db.stores.session);
  }, 400);
}
