// The email that carries a scan. Plain and short: the PDF is the content.
import { formatBytes } from './api';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function buildEmailBody(input: {
  filename: string;
  pageCount: number;
  byteCount: number;
  message: string;
  text: string;
}): { html: string; text: string } {
  const meta = `${input.filename} · ${input.pageCount} page${input.pageCount === 1 ? '' : 's'} · ${formatBytes(input.byteCount)}`;
  const message = input.message.trim();
  const ocr = input.text.trim();

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e3e5e8">
${message ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;white-space:pre-wrap">${escape(message)}</p>` : ''}
<p style="margin:0;font-size:14px;color:#555">Attached: <strong style="color:#1d1d1f">${escape(input.filename)}</strong></p>
<p style="margin:4px 0 0;font-size:13px;color:#777">${escape(meta.split(' · ').slice(1).join(' · '))}</p>
${ocr ? `<hr style="border:none;border-top:1px solid #e3e5e8;margin:20px 0"><p style="margin:0 0 8px;font-size:12px;color:#777;text-transform:uppercase;letter-spacing:.04em">Recognised text</p><pre style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre-wrap;color:#333">${escape(ocr)}</pre>` : ''}
</div>
<p style="max-width:560px;margin:12px auto 0;font-size:11px;color:#999;text-align:center">Scanned with SnapDrive</p>
</body></html>`;

  const text = [message, `Attached: ${meta}`, ocr ? `\n--- Recognised text ---\n${ocr}` : '', '\nScanned with SnapDrive']
    .filter(Boolean)
    .join('\n');
  return { html, text };
}
