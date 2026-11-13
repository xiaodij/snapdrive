// Debug helper (not part of the suite): dumps OCR lines and the exact OCR input image.
import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

test('dump OCR lines', async ({ page }) => {
  test.skip(!process.env.SNAPDRIVE_DEBUG_DUMP, 'debug only: set SNAPDRIVE_DEBUG_DUMP=1');
  mkdirSync('test/out/e2e', { recursive: true });
  await page.goto('/');
  await page.locator('input[type=file][multiple]').first().setInputFiles(process.env.SNAPDRIVE_DEBUG_PHOTO ?? 'test/fixtures/e2e/doc-photo.jpg');
  await expect(page.getByText('Processing…')).toHaveCount(0, { timeout: 120_000 });
  // Poll IndexedDB until OCR has stored lines for page 1 (waitForFunction cannot await).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const req = indexedDB.open('snapdrive-session');
          const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
          const tx = db.transaction('session').objectStore('session').get('current');
          const s: any = await new Promise((r) => (tx.onsuccess = () => r(tx.result)));
          return s?.pages?.[0]?.lines !== undefined;
        }),
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true);
  const out = await page.evaluate(async () => {
    const req = indexedDB.open('snapdrive-session');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const tx = db.transaction('session').objectStore('session').get('current');
    const s: any = await new Promise((r) => (tx.onsuccess = () => r(tx.result)));
    const p = s.pages[0];
    const toB64 = async (b: Blob) => {
      const buf = new Uint8Array(await b.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
      return btoa(bin);
    };
    return {
      lines: p.lines.map((l: any) => `${l.confidence.toFixed(2)} y=${(l.box.y + l.box.height / 2).toFixed(3)} ${l.text}`),
      ocr: await toB64(p.ocrImage),
      source: await toB64(p.source),
      quad: p.quad,
      mode: p.detectedMode,
    };
  });
  console.log(out.lines.join('\n'));
  console.log('quad', JSON.stringify(out.quad), 'mode', out.mode);
  writeFileSync('test/out/e2e/ocr-input.jpg', Buffer.from(out.ocr, 'base64'));
  writeFileSync('test/out/e2e/source.jpg', Buffer.from(out.source, 'base64'));
});
