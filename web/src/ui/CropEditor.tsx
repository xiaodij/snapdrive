// Manual corner adjustment, for when automatic detection gets the page outline wrong.
// Works in normalised image coordinates so it is indifferent to how large the photo is
// displayed or whether the decoder downscaled it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Point, Quad } from '../core/raster';
import { decodeImage, pipeline } from '../services/pipeline';
import { setGeometry, type PageDraft } from '../state/session';
import { Icon, useObjectUrl } from './common';

const LOUPE = 110;
const ZOOM = 2.5;

export function CropEditor({ page, onClose }: { page: PageDraft; onClose: () => void }) {
  const url = useObjectUrl(page.original);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ index: number; at: Point } | null>(null);

  const ow = page.origWidth ?? 1;
  const oh = page.origHeight ?? 1;
  const toNorm = (q: Quad | null | undefined): Point[] =>
    q ? q.map((p) => ({ x: p.x / ow, y: p.y / oh })) : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const [corners, setCorners] = useState<Point[]>(() => toNorm(page.quad === 'auto' ? page.autoQuad : page.quad));

  // Fit the photo inside the stage.
  const layout = () => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || !img.naturalWidth) return;
    const pad = 28;
    const W = stage.clientWidth - pad * 2;
    const H = stage.clientHeight - pad * 2;
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    setBox({ x: (stage.clientWidth - w) / 2, y: (stage.clientHeight - h) / 2, w, h });
  };
  useLayoutEffect(() => {
    window.addEventListener('resize', layout);
    return () => window.removeEventListener('resize', layout);
  });

  const screen = (p: Point) => ({ x: box.x + p.x * box.w, y: box.y + p.y * box.h });

  const onPointerDown = (index: number) => (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ index, at: corners[index] });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left - box.x) / box.w));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top - box.y) / box.h));
    setCorners((c) => c.map((p, i) => (i === drag.index ? { x, y } : p)));
    setDrag({ index: drag.index, at: { x, y } });
  };
  const onPointerUp = () => setDrag(null);

  // Magnifier under the finger, so a corner can be placed precisely.
  useEffect(() => {
    const canvas = loupeRef.current;
    const img = imgRef.current;
    if (!drag || !canvas || !img) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = LOUPE * dpr;
    canvas.height = LOUPE * dpr;
    const ctx = canvas.getContext('2d')!;
    const srcSize = (LOUPE / ZOOM) * (img.naturalWidth / box.w);
    const cx = drag.at.x * img.naturalWidth;
    const cy = drag.at.y * img.naturalHeight;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, cx - srcSize / 2, cy - srcSize / 2, srcSize, srcSize, 0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, canvas.height / 2 - 12 * dpr);
    ctx.lineTo(canvas.width / 2, canvas.height / 2 + 12 * dpr);
    ctx.moveTo(canvas.width / 2 - 12 * dpr, canvas.height / 2);
    ctx.lineTo(canvas.width / 2 + 12 * dpr, canvas.height / 2);
    ctx.stroke();
  }, [drag, box.w]);

  const autoDetect = async () => {
    if (page.autoQuad) {
      setCorners(toNorm(page.autoQuad));
      return;
    }
    setBusy(true);
    try {
      const bitmap = await decodeImage(page.original);
      const w = bitmap.width;
      const h = bitmap.height;
      const r = await pipeline.detectBitmap(bitmap);
      setCorners(r.quad ? r.quad.map((p) => ({ x: p.x / w, y: p.y / h })) : toNorm(null));
    } finally {
      setBusy(false);
    }
  };

  const valid = isConvex(corners);
  const apply = () => {
    const full = corners.every((p, i) => Math.abs(p.x - [0, 1, 1, 0][i]) < 0.002 && Math.abs(p.y - [0, 0, 1, 1][i]) < 0.002);
    const quad = full ? null : (corners.map((p) => ({ x: p.x * ow, y: p.y * oh })) as Quad);
    setGeometry(page.id, quad, page.rotation);
    onClose();
  };

  const pts = corners.map(screen);
  const loupePos = drag
    ? (() => {
        const p = screen(drag.at);
        const above = p.y - LOUPE - 40;
        return { left: Math.min(Math.max(8, p.x - LOUPE / 2), (stageRef.current?.clientWidth ?? 0) - LOUPE - 8), top: above > 8 ? above : p.y + 40 };
      })()
    : null;

  return (
    <div className="crop" role="dialog" aria-label="Adjust corners">
      <div className="crop-top">
        <button onClick={onClose}>Cancel</button>
        <span style={{ fontSize: 15, opacity: 0.8 }}>Drag the corners</span>
        <button className="primary" onClick={apply} disabled={!valid || !page.origWidth}>
          Apply
        </button>
      </div>
      <div className="crop-stage" ref={stageRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {url && (
          <img ref={imgRef} src={url} alt="Captured page" onLoad={layout} style={{ left: box.x, top: box.y, width: box.w || undefined, height: box.h || undefined }} draggable={false} />
        )}
        {box.w > 0 && (
          <svg>
            <defs>
              <mask id="outside">
                <rect width="100%" height="100%" fill="white" />
                <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="black" />
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="rgba(0,0,0,0.45)" mask="url(#outside)" />
            <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={valid ? '#ffd60a' : '#ff5c5c'} strokeWidth={2} />
            {pts.map((p, i) => (
              <circle key={i} className="handle" cx={p.x} cy={p.y} r={16} onPointerDown={onPointerDown(i)} style={{ touchAction: 'none' }} />
            ))}
          </svg>
        )}
        {loupePos && (
          <div className="loupe" style={loupePos}>
            <canvas ref={loupeRef} />
          </div>
        )}
      </div>
      <div className="crop-bar">
        <button onClick={() => void autoDetect()} disabled={busy}>
          <Icon name="auto" />
          Auto
        </button>
        <button onClick={() => setCorners(toNorm(null))}>
          <Icon name="expand" />
          Full photo
        </button>
      </div>
    </div>
  );
}

/** Corners in order must form a convex quadrilateral (no crossed or folded sides). */
function isConvex(p: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
