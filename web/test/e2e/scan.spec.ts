import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PHOTO = 'test/fixtures/e2e/doc-photo.jpg';
const OUT = 'test/out/e2e';

test.skip(!existsSync(PHOTO), 'run scripts/make-e2e-fixtures.py first');

/** First launch opens the guided setup; most tests start by closing it. */
async function openHome(page: Page) {
  await page.goto('/');
  const setup = page.getByRole('dialog', { name: 'Set up SnapDrive' });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: 'Done' }).last().click();
  await expect(setup).toHaveCount(0);
}

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

  await openHome(page);
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

  await openHome(page);
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

test('guided setup connects email with a key, sends a test, then emails a scan', async ({ page }) => {
  const key = process.env.SNAPDRIVE_TEST_RESEND_KEY;
  test.skip(!key, 'set SNAPDRIVE_TEST_RESEND_KEY (a sending-only key) to run');

  await page.goto('/');
  const setup = page.getByRole('dialog', { name: 'Set up SnapDrive' });
  await expect(setup).toBeVisible();
  // OAuth needs a person at Resend's approval page; the key path is the automatable one.
  const useKey = setup.getByRole('button', { name: 'Use an API key instead' });
  if (await useKey.count()) await useKey.click();
  await setup.getByPlaceholder('re_…').fill(key!);
  await setup.getByRole('button', { name: 'Connect with key' }).click();
  await expect(setup.getByText('Resend connected')).toBeVisible();
  await setup.locator('#setup-from-name').fill('SnapDrive Test');
  await setup.locator('#setup-from').fill('snapdrive@xjpc.ca');
  // Resend's test sink: accepted and "delivered", reaches no one.
  await setup.locator('#setup-to').fill('delivered@resend.dev');
  await setup.getByRole('button', { name: 'Send a test email' }).click();
  await expect(setup.getByText(/Test sent to delivered@resend.dev/)).toBeVisible({ timeout: 60_000 });
  await setup.getByRole('button', { name: 'Done' }).last().click();

  await page.locator('input[type=file][multiple]').first().setInputFiles(PHOTO);
  await waitForPagesReady(page);
  // Email only: OneDrive may be available on this server but is not signed in here.
  const oneDrive = page.getByRole('switch', { name: 'Upload to OneDrive' });
  if (await oneDrive.isEnabled()) await oneDrive.uncheck();
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByText(/Sent to delivered@resend.dev/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(/emailed delivered@resend.dev/)).toBeVisible();
});

test('phone-camera mode: Scan opens the system camera (file capture), no live stream', async ({ page }) => {
  await page.goto('/');
  const setup = page.getByRole('dialog', { name: 'Set up SnapDrive' });
  await setup.getByRole('button', { name: /Phone camera app/ }).click();
  await setup.getByRole('button', { name: 'Done' }).last().click();
  const scan = page.locator('label.scan-card input[type=file][capture]');
  await expect(scan).toHaveCount(1);
  await scan.setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: '1 Page' })).toBeVisible();
  await waitForPagesReady(page);
  expect(await page.locator('video').count()).toBe(0);
});

test('settings shows the build and checks for updates', async ({ page }) => {
  await openHome(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText(/^SnapDrive 2\.\d+\.\d+$/)).toBeVisible();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('SnapDrive is up to date')).toBeVisible();
});
