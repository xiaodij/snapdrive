// Progress and outcome of one send. The job lives in the outbox, so closing this sheet never
// cancels anything: a failure stays queued for retry.
import { useEffect, useState } from 'react';
import { formatBytes } from '../services/api';
import { signIn } from '../services/onedrive';
import { outboxStore, recentsStore, runJob, type Job } from '../services/outbox';
import { useStore } from '../state/store';
import { Icon, Sheet } from './common';

export type SendPhase = { kind: 'preparing'; detail: string } | { kind: 'sending'; jobId: string } | { kind: 'error'; message: string };

export function SendSheet({ phase, onDone, onBack }: { phase: SendPhase; onDone: () => void; onBack: () => void }) {
  const outbox = useStore(outboxStore);
  const recents = useStore(recentsStore);
  const [job, setJob] = useState<Job | undefined>();

  const jobId = phase.kind === 'sending' ? phase.jobId : undefined;
  const live = jobId ? outbox.find((j) => j.id === jobId) : undefined;
  useEffect(() => {
    if (live) setJob(live);
  }, [live]);
  const finished = jobId && !live && recents.some((r) => r.id === jobId);

  if (phase.kind === 'preparing') {
    return (
      <Sheet title="Sending" onClose={onBack} right={<span />}>
        <div className="result">
          <div className="spinner" style={{ width: 36, height: 36 }} />
          <h2>Preparing PDF</h2>
          <p className="muted">{phase.detail}</p>
        </div>
      </Sheet>
    );
  }
  if (phase.kind === 'error') {
    return (
      <Sheet title="Not sent" onClose={onBack}>
        <div className="result">
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="alert" />
          </span>
          <h2>Could not prepare the PDF</h2>
          <p className="muted">{phase.message}</p>
          <button className="btn" onClick={onBack}>
            Back to review
          </button>
        </div>
      </Sheet>
    );
  }

  const dests = job ? ([job.onedrive && ['OneDrive', job.onedrive], job.email && ['Email', job.email]].filter(Boolean) as [string, NonNullable<Job['onedrive'] | Job['email']>][]) : [];
  const anyFailed = dests.some(([, d]) => d.state === 'failed');
  const sending = dests.some(([, d]) => d.state === 'sending' || d.state === 'pending');
  const needsSignIn = job?.onedrive?.state === 'failed' && job.onedrive.needsAction;

  return (
    <Sheet title={finished ? 'Sent' : anyFailed && !sending ? 'Not all sent' : 'Sending'} onClose={onDone} right={<span />}>
      <div className="result">
        {finished ? (
          <span style={{ color: 'var(--ok)' }}>
            <Icon name="checkCircle" />
          </span>
        ) : anyFailed && !sending ? (
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="alert" />
          </span>
        ) : (
          <div className="spinner" style={{ width: 36, height: 36 }} />
        )}
        <h2>{job?.filename}</h2>
        {job && (
          <p className="muted" style={{ margin: 0 }}>
            {job.pageCount} page{job.pageCount === 1 ? '' : 's'} · {formatBytes(job.byteCount)}
          </p>
        )}
      </div>
      <div className="section">
        <div className="group">
          {dests.map(([label, d]) => (
            <div className="row" key={label} style={{ alignItems: 'flex-start' }}>
              <span className="lead" style={{ marginTop: 2 }}>
                <Icon name={label === 'OneDrive' ? 'cloud' : 'mail'} />
              </span>
              <div className="main">
                <div className="title">{label}</div>
                <div className="sub" style={{ whiteSpace: 'normal' }}>
                  {d.state === 'done'
                    ? 'folder' in d
                      ? `Saved to ${d.folder.path}${d.name ? ` as ${d.name}` : ''}`
                      : `Sent to ${d.to.join(', ')}`
                    : d.state === 'failed'
                      ? d.error
                      : d.state === 'sending'
                        ? 'folder' in d && d.progress !== undefined
                          ? `Uploading ${Math.round(d.progress * 100)}%`
                          : 'Sending…'
                        : 'Waiting…'}
                </div>
                {d.state === 'sending' && 'folder' in d && (
                  <div className="progress" style={{ marginTop: 6 }}>
                    <div style={{ width: `${Math.round((d.progress ?? 0) * 100)}%` }} />
                  </div>
                )}
              </div>
              {d.state === 'done' && (
                <span style={{ color: 'var(--ok)' }}>
                  <Icon name="check" />
                </span>
              )}
            </div>
          ))}
        </div>
        {anyFailed && !sending && (
          <div className="footer">The scan is saved in the outbox on the home screen. Nothing is lost; retry any time.</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
        {needsSignIn && (
          <button className="btn" onClick={() => signIn('/')}>
            Sign in to OneDrive
          </button>
        )}
        {anyFailed && !sending && !needsSignIn && job && (
          <button className="btn" onClick={() => void runJob(job.id)}>
            Retry
          </button>
        )}
        <button className={`btn${anyFailed || sending ? ' secondary' : ''}`} onClick={onDone}>
          {sending ? 'Continue in background' : 'Done'}
        </button>
      </div>
    </Sheet>
  );
}
