import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates the PWA icon set from v1's 1024px app icon (public/icon-source.png).
// Run `npm run icons` after changing the source image.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background: '#2773C7' } },
    apple: { ...minimal2023Preset.apple, padding: 0 },
  },
  images: ['public/icon-source.png'],
});
