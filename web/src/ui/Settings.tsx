import { useEffect, useState } from 'react';
import { COLOR_MODE_LABEL, QUALITY_DETAIL, QUALITY_LABEL, type ColorSelection, type QualityTier } from '../core/types';
import { requestPersistence } from '../services/db';
import { oneDriveStore, signIn, signOut } from '../services/onedrive';
import { clearRecents, recentsStore } from '../services/outbox';
import { disconnectResend, isEmailAddress, parseAddressList, resendStore } from '../services/resend';
import { OCR_LANGUAGES, settingsStore, updateEmail, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { Icon, Segmented, Sheet, Switch } from './common';
import { EmailConnect } from './Setup';
import { UpdateSection } from './UpdateSection';

export function SettingsSheet({ onClose, onPickFolder, onSetup, focus }: { onClose: () => void; onPickFolder: () => void; onSetup: () => void; focus?: 'email' }) {
  const s = useStore(settingsStore);
  const od = useStore(oneDriveStore);
  const recents = useStore(recentsStore);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    if (focus === 'email') setTimeout(() => document.getElementById('email-section')?.scrollIntoView({ behavior: 'smooth' }), 150);
  }, [focus]);

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="section">
        <div className="group">
          <button className="row" onClick={onSetup}>
            <span className="lead">
              <Icon name="share" />
            </span>
            <div className="main">
              <div className="title">Guided setup</div>
              <div className="sub">Connect OneDrive and email, choose the camera</div>
            </div>
            <Icon name="chevron" className="chev" />
          </button>
        </div>
      </div>

      <div className="section">
        <div className="label">Output</div>
        <div className="group">
          <div className="row stack">
            <Segmented<QualityTier>
              label="Default quality"
              value={s.quality}
              onChange={(quality) => updateSettings({ quality })}
              options={(['small', 'balanced', 'high'] as QualityTier[]).map((t) => ({ value: t, label: QUALITY_LABEL[t] }))}
            />
            <div className="muted" style={{ fontSize: 13 }}>
              {QUALITY_DETAIL[s.quality]}
            </div>
          </div>
          <div className="row input-row">
            <label htmlFor="colour-mode">Colour</label>
            <select id="colour-mode" value={s.colorMode} onChange={(e) => updateSettings({ colorMode: e.target.value as ColorSelection })}>
              <option value="auto">Automatic</option>
              {(['color', 'grayscale', 'blackAndWhite'] as const).map((m) => (
                <option key={m} value={m}>
                  {COLOR_MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="row input-row plain">
            <label htmlFor="camera-mode">Camera</label>
            <select id="camera-mode" value={s.cameraMode} onChange={(e) => updateSettings({ cameraMode: e.target.value as 'live' | 'system' })}>
              <option value="live">Live camera (auto-detect)</option>
              <option value="system">Phone camera app</option>
            </select>
          </div>
          <div className="row plain">
            <div className="main">
              <div className="title">Auto-capture</div>
              <div className="sub">Take the photo when the page holds still</div>
            </div>
            <Switch label="Auto-capture" checked={s.autoCapture} onChange={(autoCapture) => updateSettings({ autoCapture })} />
          </div>
        </div>
        <div className="footer">
          Automatic keeps colour only when the page has some, uses greyscale for photos and shading, and drops to black &amp; white
          for plain text, which is by far the smallest. You can change it for the whole document in the review screen.
        </div>
      </div>

      <div className="section">
        <div className="label">Text recognition</div>
        <div className="group">
          <div className="row plain">
            <div className="main">
              <div className="title">Recognise text</div>
            </div>
            <Switch label="Recognise text" checked={s.ocr} onChange={(ocr) => updateSettings({ ocr })} />
          </div>
          {s.ocr && (
            <>
              <div className="row plain">
                <div className="main">
                  <div className="title">Name files from the first line</div>
                </div>
                <Switch label="Name files from the first line" checked={s.titleFromText} onChange={(titleFromText) => updateSettings({ titleFromText })} />
              </div>
              <div className="row stack plain">
                <div className="title">Languages</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {OCR_LANGUAGES.map((l) => {
                    const on = s.ocrLangs.includes(l.code);
                    return (
                      <button
                        key={l.code}
                        className={`chip${on ? '' : ' muted'}`}
                        style={on ? undefined : { background: 'transparent', border: '1px solid var(--line)', color: 'var(--text-2)' }}
                        aria-pressed={on}
                        onClick={() => {
                          // Never end up with no language; the engine needs one.
                          if (on && s.ocrLangs.length === 1) return;
                          updateSettings({ ocrLangs: on ? s.ocrLangs.filter((c) => c !== l.code) : [...s.ocrLangs, l.code] });
                        }}
                      >
                        {on && <Icon name="check" className="icon" strokeWidth={2.5} />}
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="footer">
          Runs on this device. The recognised text is layered invisibly behind each page, so the PDF is searchable. English is built
          in; other languages download once (a few MB each) the first time they are used. Fewer languages is faster and more accurate.
        </div>
      </div>

      <div className="section">
        <div className="label">OneDrive</div>
        <div className="group">
          {!od.available ? (
            <div className="row plain">
              <div className="main">
                <div className="title">Not available</div>
                <div className="sub">This server has no Microsoft app registration yet.</div>
              </div>
            </div>
          ) : od.signedIn ? (
            <>
              <div className="row plain">
                <div className="main">
                  <div className="title">{od.account?.displayName}</div>
                  <div className="sub">{od.account?.email}</div>
                </div>
                <button className="btn small secondary" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
              <button className="row plain" onClick={onPickFolder}>
                <div className="main">
                  <div className="title">Folder</div>
                  <div className="sub">{s.folder.path}</div>
                </div>
                <Icon name="chevron" className="chev" />
              </button>
            </>
          ) : (
            <button className="row plain" onClick={() => signIn('/')}>
              <div className="main">
                <div className="title" style={{ color: 'var(--accent)' }}>
                  Sign in to OneDrive
                </div>
              </div>
            </button>
          )}
          {od.available && (
            <div className="row plain">
              <div className="main">
                <div className="title">Upload by default</div>
              </div>
              <Switch label="Upload by default" checked={s.sendToOneDrive} onChange={(sendToOneDrive) => updateSettings({ sendToOneDrive })} />
            </div>
          )}
        </div>
        <div className="footer">
          Stays signed in while you use it at least once every 90 days. Your sign-in is kept on this device in an encrypted cookie;
          the server stores nothing.
        </div>
      </div>

      <div id="email-section">
        <EmailSettings />
      </div>

      <div className="section">
        <div className="label">This device</div>
        <div className="group">
          <div className="row plain">
            <div className="main">
              <div className="title">Keep data on this device</div>
              <div className="sub">
                {persisted ? 'Protected from automatic clean-up' : 'The browser may clear unsent scans when storage is low'}
              </div>
            </div>
            {!persisted && (
              <button className="btn small secondary" onClick={() => void requestPersistence().then(setPersisted)}>
                Protect
              </button>
            )}
          </div>
          {recents.length > 0 && (
            <button className="row plain" onClick={() => void clearRecents()}>
              <div className="main">
                <div className="title" style={{ color: 'var(--danger)' }}>
                  Clear recent list
                </div>
              </div>
            </button>
          )}
        </div>
        <div className="footer">Open source (MIT): github.com/xiaodij/snapdrive</div>
      </div>

      <UpdateSection />
    </Sheet>
  );
}

function EmailSettings() {
  const s = useStore(settingsStore);
  const rs = useStore(resendStore);
  const [error, setError] = useState<string>();
  const [toText, setToText] = useState(s.email.to.join(', '));
  const [ccText, setCcText] = useState(s.email.cc.join(', '));

  const verified = (rs.domains ?? []).filter((d) => d.status === 'verified').map((d) => d.name);
  const fromDomain = s.email.fromAddress.split('@')[1] ?? '';
  const fromLocal = s.email.fromAddress.split('@')[0] ?? '';

  const commitList = (field: 'to' | 'cc', text: string) => {
    const list = parseAddressList(text);
    const bad = list.filter((a) => !isEmailAddress(a));
    if (bad.length) {
      setError(`Not an email address: ${bad.join(', ')}`);
      return;
    }
    setError(undefined);
    updateEmail({ [field]: list });
  };

  return (
    <div className="section">
      <div className="label">Email (Resend)</div>
      {!rs.connected ? (
        <>
          <div className="group">
            <div className="row stack plain">
              <EmailConnect returnTo="/?setup=email" />
            </div>
          </div>
          <div className="footer">
            Scans are emailed through your own Resend account. Your connection is sealed in an encrypted cookie on this
            device and is never stored on the server.
          </div>
        </>
      ) : (
        <>
          <div className="group">
            <div className="row plain">
              <div className="main">
                <div className="title">Connected</div>
                <div className="sub">
                  {rs.keyHint} · {rs.access === 'full' ? 'full access' : 'sending only'}
                </div>
              </div>
              <button className="btn small secondary" onClick={() => void disconnectResend()}>
                Disconnect
              </button>
            </div>
            <div className="row plain">
              <div className="main">
                <div className="title">Email by default</div>
              </div>
              <Switch label="Email by default" checked={s.sendByEmail} onChange={(sendByEmail) => updateSettings({ sendByEmail })} />
            </div>
            <div className="row input-row plain">
              <label htmlFor="from-name">From name</label>
              <input id="from-name" value={s.email.fromName} onChange={(e) => updateEmail({ fromName: e.target.value })} />
            </div>
            {verified.length > 0 ? (
              <div className="row input-row plain">
                <label htmlFor="from-local">From</label>
                <input
                  id="from-local"
                  value={fromLocal}
                  placeholder="scans"
                  onChange={(e) => updateEmail({ fromAddress: `${e.target.value.trim()}@${fromDomain}` })}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <select
                  aria-label="From domain"
                  value={verified.includes(fromDomain) ? fromDomain : ''}
                  onChange={(e) => updateEmail({ fromAddress: `${fromLocal || 'scans'}@${e.target.value}` })}
                  style={{ flex: 'none', textAlign: 'left' }}
                >
                  <option value="" disabled>
                    @domain…
                  </option>
                  {verified.map((d) => (
                    <option key={d} value={d}>
                      @{d}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="row input-row plain">
                <label htmlFor="from-address">From</label>
                <input
                  id="from-address"
                  type="email"
                  placeholder="scans@your-domain.com"
                  value={s.email.fromAddress}
                  onChange={(e) => updateEmail({ fromAddress: e.target.value.trim() })}
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
            )}
            <div className="row input-row plain">
              <label htmlFor="to">To</label>
              <input
                id="to"
                type="email"
                multiple
                placeholder="you@example.com"
                value={toText}
                onChange={(e) => setToText(e.target.value)}
                onBlur={() => commitList('to', toText)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="row input-row plain">
              <label htmlFor="cc">Cc</label>
              <input
                id="cc"
                type="email"
                multiple
                placeholder="optional"
                value={ccText}
                onChange={(e) => setCcText(e.target.value)}
                onBlur={() => commitList('cc', ccText)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="row input-row plain">
              <label htmlFor="reply-to">Reply-To</label>
              <input
                id="reply-to"
                type="email"
                placeholder="optional"
                value={s.email.replyTo}
                onChange={(e) => updateEmail({ replyTo: e.target.value.trim() })}
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="row input-row plain">
              <label htmlFor="subject">Subject</label>
              <input id="subject" value={s.email.subject} onChange={(e) => updateEmail({ subject: e.target.value })} />
            </div>
            <div className="row stack plain">
              <div className="title">Message</div>
              <textarea className="field" rows={3} placeholder="Optional note above the attachment" value={s.email.message} onChange={(e) => updateEmail({ message: e.target.value })} />
            </div>
            <div className="row plain">
              <div className="main">
                <div className="title">Include recognised text</div>
                <div className="sub">Adds the page text to the email body</div>
              </div>
              <Switch label="Include recognised text" checked={s.email.includeText} onChange={(includeText) => updateEmail({ includeText })} />
            </div>
          </div>
          {error && <div className="error-text" style={{ margin: '8px 16px' }}>{error}</div>}
          <div className="footer">
            The From address must be on a domain verified in your Resend account. Subject placeholders: {'{name}'} file name,{' '}
            {'{date}'}, {'{pages}'}. Separate several recipients with commas.
          </div>
        </>
      )}
    </div>
  );
}
