// Review: page previews, colour/quality, file name, destinations, send.
import { useEffect, useRef, useState } from 'react';
import { COLOR_MODE_SHORT, QUALITY_LABEL, type ColorSelection, type QualityTier } from '../core/types';
import { formatBytes } from '../services/api';
import { oneDriveStore, signIn } from '../services/onedrive';
import { isEmailAddress, resendStore } from '../services/resend';
import {
  movePage,
  ocrDone,
  pageReady,
  removePage,
  retryPage,
  sessionStore,
  setFilename,
  setGeometry,
  setSelection,
  setTier,
  totalBytes,
  type PageDraft,
  type Session,
} from '../state/session';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import type { Rotation } from '../workers/protocol';
import { Icon, Segmented, Switch, useObjectUrl } from './common';

export function Review({
  onAddPages,
  onDiscard,
  onSend,
  onShare,
  onEditCorners,
  onPickFolder,
  onEmailSettings,
}: {
  onAddPages: () => void;
  onDiscard: () => void;
  onSend: () => void;
  onShare: () => void;
  onEditCorners: (pageId: string) => void;
  onPickFolder: () => void;
  onEmailSettings: () => void;
}) {
  const session = useStore(sessionStore);
  const settings = useStore(settingsStore);
  const od = useStore(oneDriveStore);
  const rs = useStore(resendStore);
  const pagerRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (session && index >= session.pages.length) setIndex(Math.max(0, session.pages.length - 1));
  }, [session, index]);

  if (!session) return null;
  const pages = session.pages;
  const current = pages[index];
  const bytes = totalBytes(session);
  const pending = pages.filter((p) => !p.error && !pageReady(p, session)).length;
  const ocrPending = settings.ocr ? pages.filter((p) => !p.error && !ocrDone(p)).length : 0;

  const onScroll = () => {
    const el = pagerRef.current;
    if (!el) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };
  const scrollTo = (i: number) => pagerRef.current?.scrollTo({ left: i * pagerRef.current.clientWidth, behavior: 'smooth' });

  const emailReady = rs.connected && isEmailAddress(settings.email.fromAddress) && settings.email.to.length > 0;
  const oneDriveOn = settings.sendToOneDrive && od.available;
  const canSend = pages.length > 0 && pages.every((p) => !p.error) && ((oneDriveOn && settings.sendToOneDrive) || (settings.sendByEmail && emailReady));

  return (
    <div className="review">
      <div className="topbar">
        <div className="side">
          <button className="link-btn danger" onClick={onDiscard}>
            Discard
          </button>
        </div>
        <h1>{pages.length === 1 ? '1 Page' : `${pages.length} Pages`}</h1>
        <div className="side right">
          <button className="link-btn" onClick={onAddPages}>
            Add
          </button>
        </div>
      </div>

      <div className="pager" ref={pagerRef} onScroll={onScroll}>
        {pages.map((p, i) => (
          <PageSlide
            key={p.id}
            page={p}
            session={session}
            index={i}
            onEdit={() => onEditCorners(p.id)}
            onRotate={(delta) => setGeometry(p.id, p.quad, (((p.rotation + delta) % 360) + 360) % 360 as Rotation)}
            onRemove={() => removePage(p.id)}
            onMove={(d) => {
              movePage(p.id, d);
              setTimeout(() => scrollTo(i + d), 0);
            }}
          />
        ))}
      </div>
      {pages.length > 1 && (
        <div className="dots" aria-hidden="true">
          {pages.map((p, i) => (
            <span key={p.id} className={i === index ? 'on' : ''} />
          ))}
        </div>
      )}

      <div className="review-panel">
        <div className="panel-row">
          <div className="head">
            <span>Colour</span>
            <span>
              {session.selection === 'auto' && current?.detectedMode ? `Auto chose ${COLOR_MODE_SHORT[current.detectedMode]} for this page` : ''}
            </span>
          </div>
          <Segmented<ColorSelection>
            label="Colour mode"
            value={session.selection}
            onChange={setSelection}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'color', label: 'Colour' },
              { value: 'grayscale', label: 'Grey' },
              { value: 'blackAndWhite', label: 'B&W' },
            ]}
          />
        </div>
        <div className="panel-row">
          <div className="head">
            <span>Quality</span>
            <span>
              {pending ? `Processing ${pending}…` : `${pages.length} page${pages.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`}
              {!pending && ocrPending ? ` · reading text ${pages.length - ocrPending + 1}/${pages.length}` : ''}
            </span>
          </div>
          <Segmented<QualityTier>
            label="Quality"
            value={session.tier}
            onChange={setTier}
            options={(['small', 'balanced', 'high'] as QualityTier[]).map((t) => ({ value: t, label: QUALITY_LABEL[t] }))}
          />
        </div>
        <div className="panel-row">
          <div className="head">
            <span>File name</span>
          </div>
          <input className="field" value={session.filename} onChange={(e) => setFilename(e.target.value)} autoCorrect="off" autoCapitalize="off" spellCheck={false} />
        </div>

        <div>
          <div className="dest">
            <Icon name="cloud" />
            <div className="main">
              <div className="title">OneDrive</div>
              {!od.available ? (
                <div className="sub">Not switched on for this site yet</div>
              ) : od.signedIn ? (
                <button className="sub" onClick={onPickFolder}>
                  {settings.folder.path}
                </button>
              ) : (
                <button className="sub" onClick={() => signIn('/?resume=review')}>
                  Sign in to upload
                </button>
              )}
            </div>
            <Switch
              label="Upload to OneDrive"
              disabled={!od.available}
              checked={settings.sendToOneDrive && od.available}
              onChange={(v) => updateSettings({ sendToOneDrive: v })}
            />
          </div>
          <div className="dest">
            <Icon name="mail" />
            <div className="main">
              <div className="title">Email</div>
              {emailReady ? (
                <button className="sub" onClick={onEmailSettings}>
                  To {settings.email.to.join(', ')}
                </button>
              ) : (
                <button className="sub" onClick={onEmailSettings}>
                  {rs.connected ? 'Add a From address and recipient' : 'Connect your Resend account'}
                </button>
              )}
            </div>
            <Switch label="Send by email" checked={settings.sendByEmail} onChange={(v) => updateSettings({ sendByEmail: v })} />
          </div>
        </div>

        <button className="btn" disabled={!canSend} onClick={onSend}>
          <Icon name="share" />
          {sendLabel(oneDriveOn && settings.sendToOneDrive, settings.sendByEmail && emailReady, od.signedIn)}
        </button>
        <button className="btn secondary" disabled={!pages.length || pages.some((p) => p.error)} onClick={onShare}>
          Share or save PDF
        </button>
      </div>
    </div>
  );
}

function sendLabel(oneDrive: boolean, email: boolean, signedIn: boolean): string {
  if (oneDrive && !signedIn) return email ? 'Sign in, upload and email' : 'Sign in and upload';
  if (oneDrive && email) return 'Upload and email';
  if (oneDrive) return 'Upload to OneDrive';
  if (email) return 'Send email';
  return 'Choose where to send';
}

function PageSlide({
  page,
  session,
  index,
  onEdit,
  onRotate,
  onRemove,
  onMove,
}: {
  page: PageDraft;
  session: Session;
  index: number;
  onEdit: () => void;
  onRotate: (delta: number) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const preview = useObjectUrl(page.preview ?? page.thumb);
  const ready = pageReady(page, session);
  const count = session.pages.length;
  return (
    <div className="page-slide">
      <div className="page-frame">
        {preview && <img src={preview} alt={`Page ${index + 1}`} />}
        {page.error ? (
          <div className="state">
            <Icon name="alert" />
            <span className="error-text">{page.error}</span>
            <button className="btn small secondary" onClick={() => retryPage(page.id)}>
              Try again
            </button>
          </div>
        ) : !ready ? (
          <div className="state">
            <div className="spinner" />
            <span>{page.rendered ? 'Updating…' : 'Processing…'}</span>
          </div>
        ) : null}
      </div>
      <div className="page-meta">
        <span>
          Page {index + 1} of {count}
        </span>
        {page.rendered && <span>· {formatBytes(page.rendered.data.byteLength)}</span>}
        {page.rendered && <span className="chip">{COLOR_MODE_SHORT[page.rendered.mode]}</span>}
        {page.ocrBusy && <span className="chip warn">Reading text</span>}
      </div>
      <div className="page-tools">
        <button className="tool" onClick={onEdit} disabled={!page.origWidth}>
          <Icon name="crop" /> Corners
        </button>
        <button className="tool" onClick={() => onRotate(-90)} aria-label="Rotate left">
          <Icon name="rotateLeft" />
        </button>
        <button className="tool" onClick={() => onRotate(90)} aria-label="Rotate right">
          <Icon name="rotateRight" />
        </button>
        {count > 1 && (
          <>
            <button className="tool" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move earlier">
              <Icon name="left" />
            </button>
            <button className="tool" onClick={() => onMove(1)} disabled={index === count - 1} aria-label="Move later">
              <Icon name="right" />
            </button>
          </>
        )}
        <button className="tool danger" onClick={onRemove} aria-label="Remove page">
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}
