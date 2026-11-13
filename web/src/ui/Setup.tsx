// Guided setup: where scans go (OneDrive, email) and how pages are captured. Every connection
// is a link out to the provider's own approval page and straight back here; nothing to copy.
// The page reopens on the step it left from (?setup=onedrive|email in the return URL).
import { useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { isIosHomeScreenApp } from '../services/camera';
import { oneDriveStore, signIn } from '../services/onedrive';
import {
  connectResend,
  connectResendOAuth,
  disconnectResend,
  formatFrom,
  isEmailAddress,
  parseAddressList,
  resendStore,
  sendTestEmail,
} from '../services/resend';
import { settingsStore, updateEmail, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { Icon, Sheet, Switch, toast } from './common';

export type SetupStep = 'onedrive' | 'email' | 'camera';

export function SetupSheet({ step, onClose, onPickFolder }: { step?: SetupStep; onClose: () => void; onPickFolder: () => void }) {
  const s = useStore(settingsStore);
  const od = useStore(oneDriveStore);
  const rs = useStore(resendStore);

  useEffect(() => {
    if (step) setTimeout(() => document.getElementById(`setup-${step}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
  }, [step]);

  const finish = () => {
    updateSettings({ setupDone: true });
    onClose();
  };

  return (
    <Sheet
      title="Set up SnapDrive"
      onClose={finish}
      right={
        <button className="link-btn" onClick={finish}>
          Done
        </button>
      }
    >
      <p className="muted" style={{ margin: '14px 4px 0', lineHeight: 1.45 }}>
        Choose where your scans go. You can use one or both, and change this any time in Settings.
      </p>

      {/* ── OneDrive ─────────────────────────────────────────────────────────── */}
      <div className="section" id="setup-onedrive">
        <div className="label">1 · OneDrive</div>
        <div className="group">
          {!od.available ? (
            <div className="row plain">
              <div className="main">
                <div className="title">Not switched on for this site</div>
                <div className="sub">The site owner has not added a Microsoft app registration.</div>
              </div>
            </div>
          ) : !od.signedIn ? (
            <div className="row stack plain">
              <div className="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
                Opens Microsoft's sign-in. Approve SnapDrive and you come straight back here.
              </div>
              <button className="btn" onClick={() => signIn('/?setup=onedrive')}>
                <Icon name="cloud" /> Connect OneDrive
              </button>
            </div>
          ) : (
            <>
              <div className="row plain">
                <span className="lead" style={{ color: 'var(--ok)' }}>
                  <Icon name="checkCircle" />
                </span>
                <div className="main">
                  <div className="title">Connected</div>
                  <div className="sub">{od.account?.email || od.account?.displayName}</div>
                </div>
              </div>
              <button className="row plain" onClick={onPickFolder}>
                <div className="main">
                  <div className="title">Save scans to</div>
                  <div className="sub">{s.folder.path}</div>
                </div>
                <span className="trail" style={{ color: 'var(--accent)' }}>
                  {s.folder.id ? 'Change' : 'Choose folder'}
                </span>
              </button>
              <div className="row plain">
                <div className="main">
                  <div className="title">Upload every scan</div>
                </div>
                <Switch label="Upload every scan" checked={s.sendToOneDrive} onChange={(sendToOneDrive) => updateSettings({ sendToOneDrive })} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Email ────────────────────────────────────────────────────────────── */}
      <div className="section" id="setup-email">
        <div className="label">2 · Email (optional)</div>
        <div className="group">
          {!rs.connected ? (
            <div className="row stack plain">
              <EmailConnect returnTo="/?setup=email" />
            </div>
          ) : (
            <EmailDetails onDisconnect={() => void disconnectResend()} />
          )}
        </div>
        <div className="footer">
          Scans are sent through your own <a href="https://resend.com" target="_blank" rel="noopener noreferrer">Resend</a> account,
          from an address on a domain you have verified there. Resend has a free plan.
        </div>
      </div>

      {/* ── Camera ───────────────────────────────────────────────────────────── */}
      <div className="section" id="setup-camera">
        <div className="label">3 · Camera</div>
        <div className="group">
          <CameraChoice
            selected={s.cameraMode === 'live'}
            onSelect={() => updateSettings({ cameraMode: 'live' })}
            title="Live camera"
            detail="Finds the page and takes the shot when it holds still. Fast for several pages."
          />
          <CameraChoice
            selected={s.cameraMode === 'system'}
            onSelect={() => updateSettings({ cameraMode: 'system' })}
            title="Phone camera app"
            detail="Never asks for camera permission and takes the sharpest photos. One page per shot; SnapDrive still finds and straightens the page."
          />
        </div>
        {isIosHomeScreenApp() && (
          <div className="footer">
            iPhone asks again for camera permission each time SnapDrive is opened from the Home Screen; that is an iOS rule
            for web apps. SnapDrive reuses the camera between pages so it asks only once per session. The phone camera app
            option never asks.
          </div>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn" onClick={finish}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

function CameraChoice({ selected, onSelect, title, detail }: { selected: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button className="row plain" onClick={onSelect} aria-pressed={selected} style={{ alignItems: 'flex-start' }}>
      <span className="lead" style={{ marginTop: 2, color: selected ? 'var(--accent)' : 'var(--text-3)' }}>
        <Icon name={selected ? 'checkCircle' : 'circle'} />
      </span>
      <div className="main">
        <div className="title" style={{ fontWeight: selected ? 600 : 400 }}>
          {title}
        </div>
        <div className="sub" style={{ whiteSpace: 'normal' }}>
          {detail}
        </div>
      </div>
    </button>
  );
}

/** Connect a Resend account: the approval page when the server supports it, else an API key. */
export function EmailConnect({ returnTo }: { returnTo: string }) {
  const rs = useStore(resendStore);
  const [useKey, setUseKey] = useState(!rs.oauthAvailable);
  return (
    <>
      {rs.oauthAvailable && (
        <>
          <div className="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
            Opens Resend. Approve SnapDrive and you come straight back here. No keys to copy.
          </div>
          <button className="btn" onClick={() => connectResendOAuth(returnTo)}>
            <Icon name="mail" /> Connect Resend
          </button>
          {!useKey && (
            <button className="link-btn" style={{ fontSize: 14 }} onClick={() => setUseKey(true)}>
              Use an API key instead
            </button>
          )}
        </>
      )}
      {useKey && <ApiKeyConnect />}
    </>
  );
}

function ApiKeyConnect() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const connect = async (value = key) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await connectResend(value);
      setKey('');
      toast(r.access === 'full' ? 'Resend connected' : 'Resend connected (sending-only key)');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text.startsWith('re_')) {
        setError('The clipboard does not hold a Resend key (they start with re_).');
        return;
      }
      setKey(text);
      await connect(text);
    } catch {
      setError('Could not read the clipboard. Long-press the box and choose Paste.');
    }
  };

  return (
    <>
      <ol className="muted" style={{ fontSize: 14, lineHeight: 1.5, margin: '4px 0', paddingLeft: 20 }}>
        <li>
          <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer">
            Open Resend API keys
          </a>{' '}
          and create a key with <em>Sending access</em>.
        </li>
        <li>Copy it, come back, and tap Paste.</li>
      </ol>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="field"
          type="password"
          placeholder="re_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn small secondary" onClick={() => void paste()} disabled={busy}>
          Paste
        </button>
      </div>
      <button className="btn secondary" disabled={busy || !key.trim().startsWith('re_')} onClick={() => void connect()}>
        {busy ? 'Checking…' : 'Connect with key'}
      </button>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}

/** From / To for a connected account, with a test email to prove it works. */
function EmailDetails({ onDisconnect }: { onDisconnect: () => void }) {
  const s = useStore(settingsStore);
  const rs = useStore(resendStore);
  const od = useStore(oneDriveStore);
  const [toText, setToText] = useState(s.email.to.join(', ') || od.account?.email || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const verified = (rs.domains ?? []).filter((d) => d.status === 'verified').map((d) => d.name);

  const saveTo = (): string[] | null => {
    const list = parseAddressList(toText);
    if (!list.length || list.some((a) => !isEmailAddress(a))) {
      setResult({ ok: false, text: 'Enter at least one valid recipient address.' });
      return null;
    }
    updateEmail({ to: list });
    return list;
  };

  const test = async () => {
    const to = saveTo();
    if (!to) return;
    if (!isEmailAddress(s.email.fromAddress)) {
      setResult({ ok: false, text: 'Enter a From address on a domain verified in your Resend account.' });
      return;
    }
    setBusy(true);
    setResult(undefined);
    try {
      await sendTestEmail(formatFrom(s.email.fromName, s.email.fromAddress), to, s.email.replyTo || undefined);
      updateSettings({ sendByEmail: true });
      setResult({ ok: true, text: `Test sent to ${to.join(', ')}. Check the inbox; email is ready to use.` });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row plain">
        <span className="lead" style={{ color: 'var(--ok)' }}>
          <Icon name="checkCircle" />
        </span>
        <div className="main">
          <div className="title">Resend connected</div>
          <div className="sub">{rs.method === 'oauth' ? 'Approved in your Resend account' : `${rs.keyHint} · ${rs.access === 'full' ? 'full access' : 'sending only'}`}</div>
        </div>
        <button className="btn small secondary" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
      <div className="row input-row plain">
        <label htmlFor="setup-from-name">From name</label>
        <input id="setup-from-name" value={s.email.fromName} onChange={(e) => updateEmail({ fromName: e.target.value })} />
      </div>
      <div className="row input-row plain">
        <label htmlFor="setup-from">From</label>
        <input
          id="setup-from"
          type="email"
          placeholder={verified.length ? `scans@${verified[0]}` : 'scans@your-domain.com'}
          value={s.email.fromAddress}
          onChange={(e) => updateEmail({ fromAddress: e.target.value.trim() })}
          autoCapitalize="off"
          spellCheck={false}
          list="setup-domains"
        />
        {verified.length > 0 && (
          <datalist id="setup-domains">
            {verified.map((d) => (
              <option key={d} value={`scans@${d}`} />
            ))}
          </datalist>
        )}
      </div>
      <div className="row input-row plain">
        <label htmlFor="setup-to">Send to</label>
        <input
          id="setup-to"
          type="email"
          multiple
          placeholder="you@example.com"
          value={toText}
          onChange={(e) => setToText(e.target.value)}
          onBlur={() => saveTo()}
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
      <div className="row stack plain">
        <button className="btn secondary" onClick={() => void test()} disabled={busy}>
          {busy ? 'Sending…' : 'Send a test email'}
        </button>
        {result && <div className={result.ok ? 'muted' : 'error-text'} style={result.ok ? { color: 'var(--ok)' } : undefined}>{result.text}</div>}
      </div>
    </>
  );
}
