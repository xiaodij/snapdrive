import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PHOTO = 'test/fixtures/e2e/doc-photo.jpg';
const OUT = 'test/out/e2e';

test.skip(!existsSync(PHOTO), 'run scripts/make-e2e-fixtures.py first');

async function waitForPagesReady(page: Page) {
  // "Processing…" overlay gone and OCR finished on every page.
  await expect(page.getByText('Processing…')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByText('Reading text', { exact: true })).toHaveCount(0, { timeout: 120_000 });
}

test('import a photo, auto-crop, OCR, and save a searchable PDF', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await expect(page.getByRole('button', { name: /Scan document/ })).toBeVisible();

  await page.locator('input[type=file][multiple]').first().setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: '1 Page' })).toBeVisible();
  await waitForPagesReady(page);

  // The blue logo block makes this a colour page.
  await expect(page.locator('.page-meta .chip').first()).toHaveText('Colour');

  // Deskewed to letter proportions (8.5 x 11 = 0.773), not the photo's 3:4.
  const aspect = await page.locator('.page-frame img').first().evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight);
  expect(aspect).toBeGreaterThan(0.74);
  expect(aspect).toBeLessThan(0.81);

  // File name suggested from the first recognised line.
  await expect(page.locator('input.field').first()).toHaveValue(/INVOICE 2026-0814/i);

  // Switching to B&W re-renders from the stored page without redoing OCR.
  await page.getByRole('button', { name: 'B&W' }).click();
  await expect(page.locator('.page-meta .chip').first()).toHaveText('B&W');

  await page.getByRole('button', { name: 'Share or save PDF' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save to device' }).click();
  const file = join(OUT, `scan-${test.info().project.name}.pdf`);
  await (await download).saveAs(file);

  execFileSync('qpdf', ['--check', file]);
  const info = execFileSync('pdfinfo', [file]).toString();
  expect(info).toMatch(/Pages:\s+1/);
  expect(info).toMatch(/Page size:\s+612 x 792 pts/);
  const text = execFileSync('pdftotext', [file, '-']).toString();
  expect(text).toMatch(/INVOICE/);
  expect(text).toMatch(/723\.98/);
  const images = execFileSync('pdfimages', ['-list', file]).toString();
  expect(images).toMatch(/gray\s+1\s+1\s+image/); // B&W page stored as 1-bit

  expect(errors.filter((e) => !/favicon|manifest/i.test(e))).toEqual([]);
});

test('live camera finds the page and auto-captures it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'fake camera feed is a Chromium feature');
  test.skip(!existsSync('test/fixtures/e2e/doc-camera.y4m'), 'no fake camera feed');

  await page.goto('/');
  await page.getByRole('button', { name: /Scan document/ }).click();
  await expect(page.locator('video')).toBeVisible();
  // Outline drawn over the page, then an automatic capture once it holds still.
  await expect(page.locator('svg.overlay polygon')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.cam-count')).toHaveText('1', { timeout: 30_000 });
  await page.getByRole('button', { name: /Done, review/ }).click();
  await expect(page.getByRole('heading', { name: '1 Page' })).toBeVisible();
  await waitForPagesReady(page);
  await expect(page.locator('input.field').first()).toHaveValue(/INVOICE/i);
});

test('email a scan through Resend', async ({ page }) => {
  const key = process.env.SNAPDRIVE_TEST_RESEND_KEY;
  test.skip(!key, 'set SNAPDRIVE_TEST_RESEND_KEY (a sending-only key) to run');

  await page.goto('/');
  await page.getByRole('button', { name: /Email/ }).first().click();
  await page.getByPlaceholder('re_…').fill(key!);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText(/sending only|full access/)).toBeVisible();
  await page.locator('#from-name').fill('SnapDrive Test');
  const from = page.locator('#from-address');
  if (await from.count()) await from.fill('snapdrive@xjpc.ca');
  // Resend's test sink: accepted and "delivered", reaches no one.
  await page.locator('#to').fill('delivered@resend.dev');
  await page.locator('#to').blur();
  await page.getByRole('switch', { name: 'Email by default' }).check();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.locator('input[type=file][multiple]').first().setInputFiles(PHOTO);
  await waitForPagesReady(page);
  await page.getByRole('button', { name: /Send email|Upload and email/ }).click();
  await expect(page.getByText(/Sent to delivered@resend.dev/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(/emailed delivered@resend.dev/)).toBeVisible();
});
