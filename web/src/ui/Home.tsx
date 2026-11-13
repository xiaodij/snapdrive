import { formatBytes, formatRelative } from '../services/api';
import { oneDriveStore, signIn } from '../services/onedrive';
import { discardJob, outboxStore, recentsStore, runJob, type Job } from '../services/outbox';
import { resendStore } from '../services/resend';
import { sessionStore } from '../state/session';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { Icon } from './common';

export function Home({
  onScan,
  onImport,
  onResume,
  onSettings,
  onPickFolder,
  onEmailSettings,
  onShareJob,
  updateReady,
  onUpdate,
}: {
  onScan: () => void;
  onImport: (files: File[]) => void;
  onResume: () => void;
  onSettings: () => void;
  onPickFolder: () => void;
  onEmailSettings: () => void;
  onShareJob: (job: Job) => void;
  updateReady: boolean;
  onUpdate: () => void;
}) {
  const settings = useStore(settingsStore);
  const od = useStore(oneDriveStore);
  const rs = useStore(resendStore);
  const outbox = useStore(outboxStore);
  const recents = useStore(recentsStore);
  const session = useStore(sessionStore);

  return (
    <div className="screen">
      <div className="topbar">
        <div className="side" />
        <h1 className="sr-only">SnapDrive</h1>
        <div className="side right">
          <button className="icon-btn" onClick={onSettings} aria-label="Settings">
            <Icon name="gear" />
          </button>
        </div>
      </div>
      <div className="content">
        <div className="large-title" style={{ margin: '0 0 14px' }}>
          SnapDrive
        </div>

        {updateReady && (
          <div className="banner">
            <span className="main">A new version is ready.</span>
            <button className="btn small" onClick={onUpdate}>
              Update
            </button>
          </div>
        )}

        {session && session.pages.length > 0 && (
          <div className="banner">
            <Icon name="doc" />
            <span className="main">
              Unsent scan: {session.pages.length} page{session.pages.length === 1 ? '' : 's'}
            </span>
            <button className="btn small" onClick={onResume}>
              Open
            </button>
          </div>
        )}

        <button className="scan-card" onClick={onScan} style={{ marginTop: 14 }}>
          <Icon name="scan" />
          <strong>Scan document</strong>
          <span>Pages are cropped, cleaned up and made searchable</span>
        </button>
        <div className="home-actions">
          <label className="btn secondary">
            <Icon name="photos" /> Import photos
            <input
              className="sr-only"
              type="file"
              accept="image/*,.heic,.heif"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) onImport(files);
              }}
            />
          </label>
        </div>

        <div className="section">
          <div className="label">Send to</div>
          <div className="group">
            {!od.available ? (
              <div className="row">
                <span className="lead">
                  <Icon name="cloud" />
                </span>
                <div className="main">
                  <div className="title">OneDrive</div>
                  <div className="sub">Not switched on for this site yet</div>
                </div>
              </div>
            ) : od.signedIn ? (
              <button className="row" onClick={onPickFolder}>
                <span className="lead">
                  <Icon name="cloud" />
                </span>
                <div className="main">
                  <div className="title">{od.account?.email || od.account?.displayName || 'OneDrive'}</div>
                  <div className="sub">
                    {settings.sendToOneDrive ? 'Uploads to ' : 'Off · '}
                    {settings.folder.path}
                  </div>
                </div>
                <Icon name="chevron" className="chev" />
              </button>
            ) : (
              <button className="row" onClick={() => signIn('/')}>
                <span className="lead">
                  <Icon name="cloud" />
                </span>
                <div className="main">
                  <div className="title">Sign in to OneDrive</div>
                  <div className="sub">You can scan now and sign in before sending</div>
                </div>
                <Icon name="chevron" className="chev" />
              </button>
            )}
            <button className="row" onClick={onEmailSettings}>
              <span className="lead">
                <Icon name="mail" />
              </span>
              <div className="main">
                <div className="title">Email</div>
                <div className="sub">
                  {!rs.connected
                    ? 'Connect your Resend account'
                    : settings.email.to.length
                      ? `${settings.sendByEmail ? 'Sends' : 'Off'} · to ${settings.email.to.join(', ')}`
                      : 'Add recipients'}
                </div>
              </div>
              <Icon name="chevron" className="chev" />
            </button>
          </div>
        </div>

        {outbox.length > 0 && (
          <div className="section">
            <div className="label">Outbox</div>
            <div className="group">
              {outbox.map((job) => (
                <OutboxRow key={job.id} job={job} onShare={() => onShareJob(job)} />
              ))}
            </div>
            <div className="footer">Waiting or failed sends stay here, with the PDF, until they go through.</div>
          </div>
        )}

        {recents.length > 0 && (
          <div className="section">
            <div className="label">Recent</div>
            <div className="group">
              {recents.slice(0, 15).map((r) => (
                <a
                  key={r.id}
                  className="row"
                  href={r.onedrive?.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'inherit', textDecoration: 'none', pointerEvents: r.onedrive?.webUrl ? 'auto' : 'none' }}
                >
                  <span className="lead" style={{ color: 'var(--text-2)' }}>
                    <Icon name="doc" />
                  </span>
                  <div className="main">
                    <div className="title">{r.filename}</div>
                    <div className="sub">
                      {r.pageCount} page{r.pageCount === 1 ? '' : 's'} · {formatBytes(r.byteCount)}
                      {r.onedrive ? ` · ${r.onedrive.path}` : ''}
                      {r.email ? ` · emailed ${r.email.to.join(', ')}` : ''}
                    </div>
                  </div>
                  <span className="trail" style={{ fontSize: 12 }}>
                    {formatRelative(r.date)}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 28 }}>
          SnapDrive {__APP_VERSION__}. Scans are processed on this device.
        </p>
      </div>
    </div>
  );
}

function OutboxRow({ job, onShare }: { job: Job; onShare: () => void }) {
  const dests = [job.onedrive && { label: 'OneDrive', ...job.onedrive }, job.email && { label: 'Email', ...job.email }].filter(Boolean) as {
    label: string;
    state: string;
    error?: string;
    progress?: number;
  }[];
  const sending = dests.some((d) => d.state === 'sending');
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <span className="lead" style={{ marginTop: 2 }}>
        {sending ? <div className="spinner" /> : <Icon name="alert" />}
      </span>
      <div className="main">
        <div className="title">{job.filename}</div>
        {dests.map((d) => (
          <div key={d.label} className="sub" style={{ whiteSpace: 'normal' }}>
            {d.label}: {d.state === 'done' ? 'sent' : d.state === 'sending' ? 'sending…' : d.state === 'failed' ? d.error : 'waiting'}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn small" disabled={sending} onClick={() => void runJob(job.id)}>
            Retry
          </button>
          <button className="btn small secondary" onClick={onShare}>
            Share PDF
          </button>
          <button className="btn small danger" disabled={sending} onClick={() => confirm('Delete this scan from the outbox?') && void discardJob(job.id)}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
