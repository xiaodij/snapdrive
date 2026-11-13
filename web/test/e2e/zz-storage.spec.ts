// Debug helper (not part of the suite): does the scan session persist to IndexedDB?
import { expect, test } from '@playwright/test';

test('session persists', async ({ page }) => {
  test.skip(!process.env.SNAPDRIVE_DEBUG_DUMP, 'debug only');
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  await page.goto('/');
  await page.locator('input[type=file][multiple]').first().setInputFiles(process.env.SNAPDRIVE_DEBUG_PHOTO ?? 'test/fixtures/e2e/doc-photo.jpg');
  await expect(page.getByText('Processing…')).toHaveCount(0, { timeout: 120_000 });
  await page.waitForTimeout(8000);
  const state = await page.evaluate(async () => {
    const req = indexedDB.open('snapdrive-session');
    const db: IDBDatabase = await new Promise((r, j) => ((req.onsuccess = () => r(req.result)), (req.onerror = () => j(req.error))));
    const tx = db.transaction('session').objectStore('session').get('current');
    const s: any = await new Promise((r) => (tx.onsuccess = () => r(tx.result)));
    const est = await navigator.storage?.estimate?.();
    // Can we store a Blob at all?
    let blobPut = 'ok';
    try {
      const w = db.transaction('session', 'readwrite');
      w.objectStore('session').put({ b: new Blob([new Uint8Array(1000)]) }, 'probe');
      await new Promise((r, j) => ((w.oncomplete = r), (w.onerror = () => j(w.error)), (w.onabort = () => j(w.error))));
    } catch (e) {
      blobPut = String(e);
    }
    return { exists: !!s, pages: s?.pages?.length, lines: s?.pages?.[0]?.lines?.length, est, blobPut };
  });
  console.log(JSON.stringify(state));
  console.log(logs.filter((l) => /storage|error|warn/i.test(l)).join('\n'));
});
