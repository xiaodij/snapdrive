# SnapDrive v2 (PWA)

The same scanner as v1, as an installable web app that works on iPhone, Android and desktop,
with a second way out: besides uploading to OneDrive, it can email the PDF through your own
[Resend](https://resend.com) account.

- **Capture**: live camera with page detection and auto-capture, the system camera for
  full-resolution stills, or photos imported from the library (HEIC included on Apple devices).
- **Crop and deskew**: automatic outline, corner handles with a magnifier, perspective
  correction that recovers the page's true proportions.
- **Colour decision, cleanup, PDF**: ported from v1 and checked against it: same decisions
  on v1's test pages, same flat-field shadow removal, JPEG fidelity matched to v1 at every
  quality tier, B&W pages stored 1-bit.
- **OCR**: on the device (tesseract.js), layered invisibly behind each page so the PDF is
  searchable. English is built in; 17 other languages download on first use.
- **Send**: OneDrive (folder picker, never overwrites), email via Resend, or the share sheet.
  Every send goes through an outbox kept on the device, so a dropped connection loses nothing.

## What runs where

Everything about a scan happens on the phone. A small Cloudflare Worker does two things a
browser cannot, and stores nothing:

1. **Keeps you signed in to OneDrive.** Microsoft gives browser-only apps 24-hour sign-ins.
   The Worker acts as a confidential client (it holds the app's client secret), which gets
   90-day sliding sessions. Your refresh token is encrypted with a key only the Worker has and
   kept in a cookie on your device; the Worker never keeps a copy.
2. **Relays email to Resend**, whose API refuses calls from browsers. Your API key is sealed
   into a cookie the same way.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the contracts and the API table.

## Use it

Open the site on your phone and add it to the Home Screen (Safari: Share → Add to Home
Screen). Then:

- **OneDrive**: Settings → Sign in to OneDrive.
- **Email**: create an API key at resend.com → API Keys (a sending-only key scoped to your
  domain is enough), then Settings → Email → paste it, set the From address (on a domain
  verified in Resend) and the recipients.

## Run your own

Prerequisites: Node 22+, a Cloudflare account with a domain, an Azure (Entra ID) tenant for
the app registration. Everything is free tier.

```sh
cd web
npm install
cp .dev.vars.example .dev.vars        # then set SEAL_KEY (see the file)
npm run build && npm run worker:dev   # http://localhost:8794
```

1. **Azure app** (only needed for OneDrive). Register an app for personal Microsoft accounts
   with delegated Graph permissions `Files.ReadWrite`, `User.Read`, `offline_access`. Under
   **Web** platform add the redirect URIs `https://<your-domain>/api/ms/callback` and
   `http://localhost:8794/api/ms/callback`, then create a client secret.
2. **Configure** `wrangler.jsonc`: your `account_id`, your domain in `routes`, and your app's
   `MS_CLIENT_ID`. Set the secrets:
   ```sh
   npx wrangler secret put SEAL_KEY          # 32 random bytes, base64
   npx wrangler secret put MS_CLIENT_SECRET  # from step 1
   ```
3. **Deploy**: `npm run deploy`.

Without `MS_CLIENT_SECRET` the app still works for email and sharing; OneDrive shows as not
set up.

## Testing

```sh
npm test                                   # vitest: core pipeline + Worker
python scripts/make-e2e-fixtures.py        # synthetic phone photo + fake camera feed
npx playwright test --project=chromium-mobile
npx playwright test --project=webkit-iphone
```

The core tests compare the TypeScript pipeline with v1's Swift harness output on the same
pages (`scripts/fetch-v1-fixtures.sh` pulls them from a Mac that has run
`swift run PipelineTest`). The e2e email test needs `SNAPDRIVE_TEST_RESEND_KEY` and only ever
sends to Resend's test address `delivered@resend.dev`.

## Licence

MIT, as v1.
