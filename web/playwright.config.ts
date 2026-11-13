import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// End-to-end tests against the real Worker (`wrangler dev`, port 8794) serving the built app.
// Build first: `npm run build`. Inputs: `python -P -E scripts/make-e2e-fixtures.py`.
//
// WebKit: Windows Application Control blocks Playwright's unsigned WebKit build on the
// office PC, so Safari-engine runs happen on the Mac mini (see CLAUDE.md, "Testing").
const BASE = process.env.SNAPDRIVE_BASE_URL ?? 'http://localhost:8794';
const fakeCamera = 'test/fixtures/e2e/doc-camera.y4m';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        permissions: ['camera'],
        launchOptions: {
          args: existsSync(fakeCamera)
            ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${fakeCamera}`]
            : [],
        },
      },
    },
    {
      name: 'webkit-iphone',
      use: { ...devices['iPhone 15'] },
    },
  ],
  webServer: process.env.SNAPDRIVE_BASE_URL
    ? undefined
    : {
        command: 'npx wrangler dev --port 8794 --ip 127.0.0.1',
        url: `${BASE}/api/health`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
