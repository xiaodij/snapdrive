// Every send is a job saved to IndexedDB before anything goes over the network, so a dropped
// connection or a closed app never loses a scan. Each destination (OneDrive, email) is tracked
// separately: a retry only redoes what failed. Finished jobs become "recent" entries and the
// PDF bytes are dropped.
import type { FolderRef } from '../state/settings';
import { createStore } from '../state/store';
import { isNetworkError } from './api';
import { db } from './db';
import { buildEmailBody } from './emailBody';
import { SignedOutError, upload } from './onedrive';
import { blobToBase64, EMAIL_ATTACHMENT_LIMIT, sendEmail } from './resend';

export type DestState = 'pending' | 'sending' | 'done' | 'failed';

export interface OneDriveDest {
  folder: FolderRef;
  state: DestState;
  progress?: number;
  name?: string;
  webUrl?: string;
  error?: string;
  /** Needs the user (e.g. sign in again) rather than just a retry. */
  needsAction?: boolean;
}

export interface EmailDest {
  from: string;
  to: string[];
  cc: string[];
  replyTo?: string;
  subject: string;
  message: string;
  includeText: boolean;
  state: DestState;
  id?: string;
  error?: string;
  needsAction?: boolean;
}

export interface Job {
  id: string;
  createdAt: number;
  filename: string;
  pageCount: number;
  byteCount: number;
  pdf: Blob;
  text: string;
  onedrive?: OneDriveDest;
  email?: EmailDest;
}

export interface Recent {
  id: string;
  date: number;
  filename: string;
  pageCount: number;
  byteCount: number;
  onedrive?: { path: string; name?: string; webUrl?: string };
  email?: { to: string[] };
}

export const outboxStore = createStore<Job[]>([]);
export const recentsStore = createStore<Recent[]>([]);

const RECENTS_KEY = 'recents';
const running = new Set<string>();

export async function loadOutbox(): Promise<void> {
  const rows = await db.entries<Job>(db.stores.outbox);
  outboxStore.set(rows.map(([, j]) => j).sort((a, b) => b.createdAt - a.createdAt));
  recentsStore.set((await db.get<Recent[]>(RECENTS_KEY)) ?? []);
  // Anything left "sending" was interrupted (app closed mid-upload): it is just pending.
  for (const job of outboxStore.get()) {
    let changed = false;
    if (job.onedrive?.state === 'sending') (job.onedrive.state = 'pending'), (changed = true);
    if (job.email?.state === 'sending') (job.email.state = 'pending'), (changed = true);
    if (changed) await save(job);
  }
}

async function save(job: Job): Promise<void> {
  outboxStore.set((jobs) => {
    const others = jobs.filter((j) => j.id !== job.id);
    return [job, ...others].sort((a, b) => b.createdAt - a.createdAt);
  });
  await db.set(job.id, job, db.stores.outbox);
}

function patch(job: Job, fn: (j: Job) => void): Job {
  const next: Job = { ...job, onedrive: job.onedrive && { ...job.onedrive }, email: job.email && { ...job.email } };
  fn(next);
  return next;
}

export async function enqueue(job: Omit<Job, 'id' | 'createdAt'>): Promise<Job> {
  const full: Job = { ...job, id: crypto.randomUUID(), createdAt: Date.now() };
  await save(full);
  return full;
}

export async function discardJob(id: string): Promise<void> {
  outboxStore.set((jobs) => jobs.filter((j) => j.id !== id));
  await db.del(id, db.stores.outbox);
}

export async function clearRecents(): Promise<void> {
  recentsStore.set([]);
  await db.set(RECENTS_KEY, []);
}

const finished = (d?: { state: DestState }) => !d || d.state === 'done';

/** Run every unfinished destination of a job. Returns the final job. */
export async function runJob(id: string): Promise<Job | undefined> {
  if (running.has(id)) return outboxStore.get().find((j) => j.id === id);
  running.add(id);
  try {
    let job = outboxStore.get().find((j) => j.id === id);
    if (!job) return undefined;

    const commit = async (fn: (j: Job) => void) => {
      job = patch(job!, fn);
      await save(job);
    };

    const tasks: Promise<void>[] = [];

    if (job.onedrive && job.onedrive.state !== 'done') {
      tasks.push(
        (async () => {
          await commit((j) => Object.assign(j.onedrive!, { state: 'sending', progress: 0, error: undefined, needsAction: false }));
          try {
            let last = 0;
            const result = await upload(job!.pdf, job!.filename, job!.onedrive!.folder, (f) => {
              // Progress is UI-only; persist it sparingly.
              if (f - last < 0.05 && f < 1) return;
              last = f;
              outboxStore.set((jobs) =>
                jobs.map((j) => (j.id === id && j.onedrive ? { ...j, onedrive: { ...j.onedrive, progress: f } } : j)),
              );
            });
            await commit((j) => Object.assign(j.onedrive!, { state: 'done', progress: 1, name: result.name, webUrl: result.webUrl }));
          } catch (err) {
            await commit((j) =>
              Object.assign(j.onedrive!, {
                state: 'failed',
                error: describe(err),
                needsAction: err instanceof SignedOutError,
              }),
            );
          }
        })(),
      );
    }

    if (job.email && job.email.state !== 'done') {
      tasks.push(
        (async () => {
          await commit((j) => Object.assign(j.email!, { state: 'sending', error: undefined, needsAction: false }));
          try {
            const e = job!.email!;
            if (job!.pdf.size > EMAIL_ATTACHMENT_LIMIT) {
              throw new Error(`The PDF is ${(job!.pdf.size / 1048576).toFixed(1)} MB; email attachments are limited to about 28 MB. Try the Small quality setting or upload to OneDrive.`);
            }
            const body = buildEmailBody({
              filename: job!.filename,
              pageCount: job!.pageCount,
              byteCount: job!.pdf.size,
              message: e.message,
              text: e.includeText ? job!.text : '',
            });
            const emailId = await sendEmail(
              {
                from: e.from,
                to: e.to,
                cc: e.cc,
                reply_to: e.replyTo,
                subject: e.subject,
                html: body.html,
                text: body.text,
                attachments: [{ filename: job!.filename, content: await blobToBase64(job!.pdf) }],
              },
              // Same key on every retry: Resend sends at most once per key (24 h window).
              `snapdrive-${job!.id}`,
            );
            await commit((j) => Object.assign(j.email!, { state: 'done', id: emailId }));
          } catch (err) {
            const status = (err as { status?: number }).status;
            await commit((j) =>
              Object.assign(j.email!, {
                state: 'failed',
                error: describe(err),
                needsAction: status === 401 || status === 403 || status === 422,
              }),
            );
          }
        })(),
      );
    }

    await Promise.all(tasks);

    if (finished(job.onedrive) && finished(job.email)) {
      await complete(job);
    }
    return job;
  } finally {
    running.delete(id);
  }
}

async function complete(job: Job): Promise<void> {
  const recent: Recent = {
    id: job.id,
    date: Date.now(),
    filename: job.onedrive?.name ?? job.filename,
    pageCount: job.pageCount,
    byteCount: job.byteCount,
    onedrive: job.onedrive && { path: job.onedrive.folder.path, name: job.onedrive.name, webUrl: job.onedrive.webUrl },
    email: job.email && { to: job.email.to },
  };
  const recents = [recent, ...recentsStore.get().filter((r) => r.id !== job.id)].slice(0, 30);
  recentsStore.set(recents);
  await db.set(RECENTS_KEY, recents);
  // Keep the finished job visible a moment for the result screen, then drop the PDF bytes.
  outboxStore.set((jobs) => jobs.filter((j) => j.id !== job.id));
  await db.del(job.id, db.stores.outbox);
}

/** Retry everything that failed for a reason a retry can fix (network, server hiccup). */
export async function retryAutomatically(): Promise<void> {
  for (const job of outboxStore.get()) {
    const retryable = (d?: { state: DestState; needsAction?: boolean }) => d && d.state !== 'done' && !d.needsAction;
    if (retryable(job.onedrive) || retryable(job.email)) void runJob(job.id);
  }
}

function describe(err: unknown): string {
  if (isNetworkError(err)) return 'No connection. It will be retried automatically when you are back online.';
  return err instanceof Error ? err.message : String(err);
}
