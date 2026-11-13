# SnapDrive v2: platform research notes (2026-11-13)

Notes behind the v2 design choices. Working notes, not a deliverable.

## Resend cannot be called from a browser
- api.resend.com sends no `Access-Control-Allow-Origin`; a browser `fetch` fails at the CORS
  preflight. Resend's own guidance: send server-side.
  https://www.resend.com/docs/knowledge-base/how-do-i-fix-cors-issues
- Consequence: a relay is required. v2's Worker forwards `POST /emails` and `GET /domains`.
- Resend has no third-party OAuth. "Connecting an account" means pasting an API key.
  - Full-access key: `GET /domains` returns 200 with the verified domains.
  - Sending-only key: `GET /domains` returns 401 `restricted_api_key`. That still proves the key
    is valid, so the app accepts it and asks the user to type the From address.
- Test sink addresses that never reach a person: `delivered@resend.dev`, `bounced@resend.dev`.
- Email size limit 40 MB including base64 overhead (~1.37x), so a PDF over ~28 MB cannot be attached.
- `Idempotency-Key` header de-duplicates retries (24 h window), useful for the outbox.

## Microsoft sign-in for a web app
- Refresh tokens issued to the SPA platform live 24 hours, fixed window (not sliding), not
  configurable. Renewed tokens inherit the remaining time. Silent renewal via hidden iframe
  fails when third-party cookies are blocked (Safari).
  https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
  https://learn.microsoft.com/en-us/entra/msal/javascript/browser/token-lifetimes
- Other scenarios (confidential "Web" platform clients) get 90-day sliding refresh tokens.
- Decision (Xiaodi, 2026-11-13): the Worker is a confidential client. It holds the client
  secret; the refresh token is sealed with a Worker-only AES key and kept in an HttpOnly cookie
  on the device. The server stores nothing.
- The redirect URI must be registered under the Web platform for every origin used
  (production + `http://localhost:8794` for local dev).
- Microsoft Graph supports CORS, so the page calls Graph directly with the access token.
  Upload-session chunk URLs: CORS support uncertain, so the Worker has a fallback relay route.

## iOS home-screen web apps
- Since iOS/iPadOS 26 every site added to the Home Screen opens as a web app by default;
  `display: standalone` supported, `fullscreen` not. https://firt.dev/notes/pwa-ios/
- getUserMedia works in standalone mode, with a history of bugs: repeated permission prompts,
  black or frozen frames on some iOS versions, a rotated feed on iPadOS 26 home-screen apps.
  WebKit bugs 185448, 273938, 282327, 299591. Hence v2 always offers the native camera
  (`<input type=file capture=environment>`) and photo import as alternatives to the live view.
- ImageCapture.takePhoto: no evidence of iOS support. Live captures are video frames
  (resolution capped by the video format), and the native camera gives full 12 MP stills.
- Web Share Target is not supported on iOS (works on Android/Chrome).
- Script-writable storage (IndexedDB) is exempt from ITP's 7-day deletion for Home Screen web
  apps but not for ordinary Safari tabs. Credentials live in HttpOnly cookies set by the Worker,
  so that rule does not affect them.

## Libraries chosen
- OCR: tesseract.js 7 (WASM, on-device). Core + worker self-hosted; `eng` model self-hosted,
  other languages fetched from jsDelivr on first use and cached by tesseract.js in IndexedDB.
- JPEG: @jsquash/jpeg (mozjpeg WASM). Smaller than the browser encoder and can write true
  single-component greyscale JPEGs, so greyscale pages stay `/DeviceGray` like v1.
- zlib: fflate (sync, level 9) for 1-bit pages and PDF content streams.
- Edge detection: pure TypeScript (no OpenCV.js, which is ~10 MB).

## Later the same day: camera prompts, Resend OAuth, updates

### Camera permission in iOS home-screen apps
- WebKit bug 215884: in standalone (home-screen) mode, a change to the URL hash revokes camera
  permission; reports also describe a fresh prompt when getUserMedia is called again later, and
  no persistence across launches. A WebKit maintainer asked in Sept 2024 for a new bug requesting
  persistent camera access for home-screen apps; no fix found as of this note.
  https://bugs.webkit.org/show_bug.cgi?id=215884 ,
  https://developer.apple.com/forums/thread/788518
- What SnapDrive does: sign-in results come back in the query string (never `#`); one camera
  stream per app session, paused (track.enabled = false) and kept for 3 minutes after the camera
  screen closes so "Add page" reuses it; no re-request on visibilitychange unless iOS ended the
  track. The first prompt after each launch remains (iOS rule).
- `<input type=file accept=image/* capture=environment>` opens the phone's Camera app and needs
  no web permission at all: offered as the "Phone camera app" mode.

### Resend OAuth (launched 2026-07-13, changelog updated 2026-08-27)
- https://resend.com/changelog/oauth-support ,
  https://resend.com/docs/guides/building-a-resend-oauth-client ,
  https://resend.com/docs/api-reference/oauth/{register,authorize,token,revoke}
- OAuth 2.1, PKCE S256 required. Clients register by RFC 7591 dynamic registration
  (`POST https://api.resend.com/oauth/register`, unauthenticated, 20/hour/IP) or a Client ID
  Metadata Document. Confidential clients use `client_secret_basic` (secret shown once).
- Scopes: `emails:send` (POST /emails) and `full_access` (everything else, incl. GET /domains).
  SnapDrive asks only for `emails:send`, so the user types the From address.
- Access tokens 900 s; refresh tokens rotate on every use, live 60 days from last issue, and
  reusing a rotated token revokes the whole grant. SnapDrive serializes all relay calls in the
  page and refreshes only when the access token has expired.
- Errors after client validation redirect only for loopback / private-scheme / verified
  clients; an unverified https client gets a JSON error page instead.

### Updates in a home-screen app
- iOS rarely reloads a standalone app, so the service worker's own update check can lag. The
  app fetches /version.json (no-store) on launch, on return to foreground (10 min throttle) and
  from Settings → Check for updates, asks the service worker to update, and offers "Install
  update" (skipWaiting + reload). The scan in progress survives in IndexedDB.
