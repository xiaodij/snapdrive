import type { ColorSelection, QualityTier } from '../core/types';
import { db } from '../services/db';
import { createStore } from './store';

/** A OneDrive destination folder. `id: null` is the drive root. */
export interface FolderRef {
  id: string | null;
  path: string;
}

export const ROOT_FOLDER: FolderRef = { id: null, path: 'OneDrive' };

export interface EmailSettings {
  fromName: string;
  /** Must be on a domain verified in the user's Resend account. */
  fromAddress: string;
  to: string[];
  cc: string[];
  replyTo: string;
  /** Placeholders: {name} {date} {pages} */
  subject: string;
  message: string;
  /** Put the recognised text in the email body as well as the PDF. */
  includeText: boolean;
}

export interface Settings {
  quality: QualityTier;
  colorMode: ColorSelection;
  ocr: boolean;
  /** Tesseract language codes, e.g. eng, fra, chi_sim. */
  ocrLangs: string[];
  titleFromText: boolean;
  autoCapture: boolean;
  /**
   * 'live': in-app viewfinder with page detection and auto-capture.
   * 'system': the phone's own camera app (a file input with capture). Never triggers a
   * permission prompt and takes full-resolution stills, one page per shot.
   */
  cameraMode: 'live' | 'system';
  /** The guided setup has been completed or dismissed. */
  setupDone: boolean;
  sendToOneDrive: boolean;
  sendByEmail: boolean;
  folder: FolderRef;
  email: EmailSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'balanced',
  colorMode: 'auto',
  ocr: true,
  ocrLangs: ['eng'],
  titleFromText: true,
  autoCapture: true,
  cameraMode: 'live',
  setupDone: false,
  sendToOneDrive: true,
  sendByEmail: false,
  folder: ROOT_FOLDER,
  email: {
    fromName: 'SnapDrive',
    fromAddress: '',
    to: [],
    cc: [],
    replyTo: '',
    subject: '{name}',
    message: '',
    includeText: false,
  },
};

export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS);

const KEY = 'settings';

export async function loadSettings(): Promise<void> {
  const saved = await db.get<Partial<Settings>>(KEY);
  if (saved) {
    settingsStore.set({
      ...DEFAULT_SETTINGS,
      ...saved,
      email: { ...DEFAULT_SETTINGS.email, ...(saved.email ?? {}) },
    });
  }
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)): void {
  settingsStore.set((prev) => {
    const delta = typeof patch === 'function' ? patch(prev) : patch;
    const next = { ...prev, ...delta };
    void db.set(KEY, next);
    return next;
  });
}

export function updateEmail(patch: Partial<EmailSettings>): void {
  updateSettings((s) => ({ email: { ...s.email, ...patch } }));
}

/** Tesseract languages offered in Settings. Codes are tessdata names. */
export const OCR_LANGUAGES: { code: string; name: string }[] = [
  { code: 'eng', name: 'English' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'spa', name: 'Spanish' },
  { code: 'ita', name: 'Italian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'nld', name: 'Dutch' },
  { code: 'pol', name: 'Polish' },
  { code: 'rus', name: 'Russian' },
  { code: 'ukr', name: 'Ukrainian' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'chi_tra', name: 'Chinese (Traditional)' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
  { code: 'ara', name: 'Arabic' },
  { code: 'hin', name: 'Hindi' },
  { code: 'vie', name: 'Vietnamese' },
  { code: 'tur', name: 'Turkish' },
];
