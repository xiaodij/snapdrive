import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// Build identity: the app compares its own build with /version.json (never cached) to offer
// updates. Timestamp plus commit, e.g. "2026-11-13T18:40Z 517fc89".
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'local';
  }
})();
const BUILD_ID = `${new Date().toISOString().slice(0, 16)}Z ${commit}`;

/** Emits dist/version.json with the same build id the bundle was compiled with. */
function versionFile(): Plugin {
  return {
    name: 'snapdrive-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version, build: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // Dev: `npm run worker:dev` serves the Worker on 8794; Vite proxies /api to it so OneDrive
  // sign-in and the Resend relay work from the dev server too. Ports registered in ports.md.
  server: {
    port: 5192,
    strictPort: true,
    host: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8794', changeOrigin: false } },
  },
  preview: { port: 5192, strictPort: true, host: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  optimizeDeps: { exclude: ['@jsquash/jpeg'] },
  plugins: [
    react(),
    versionFile(),
    VitePWA({
      // Never reload under someone mid-scan: the home screen offers the update instead.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: '/',
        name: 'SnapDrive',
        short_name: 'SnapDrive',
        description:
          'Scan documents with your phone: crops, deskews, cleans up, reads the text, and sends a searchable PDF to OneDrive or by email.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f2f2f7',
        theme_color: '#2773c7',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Android/Chrome: "Share" photos into SnapDrive. iOS does not support share targets.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'files', accept: ['image/*'] }] },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'],
        globIgnores: ['**/tesseract/**', '**/tessdata/**', 'icon-source.png'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/share-target/],
        cleanupOutdatedCaches: true,
        importScripts: ['share-target-sw.js'],
        runtimeCaching: [
          {
            // OCR engine + English model: large, versioned by the app build, fetched on first OCR.
            urlPattern: ({ url }) => url.pathname.startsWith('/tesseract/') || url.pathname.startsWith('/tessdata/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-engine', expiration: { maxEntries: 20 } },
          },
          {
            // Other OCR languages, fetched from jsDelivr on first use.
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('tesseract.js-data'),
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-languages', expiration: { maxEntries: 30 } },
          },
        ],
      },
    }),
  ],
});
