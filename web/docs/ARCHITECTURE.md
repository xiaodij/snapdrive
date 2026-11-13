# SnapDrive v2 architecture

A PWA served by one Cloudflare Worker (`snapdrive`, custom domain snapdrive.xjpc.ca). The
static app is Workers static assets from `dist/`; only `/api/*` runs Worker code.

Everything about a scan happens on the phone: capture, edge detection, perspective
correction, colour decision, cleanup, OCR, and PDF writing. The Worker exists for two jobs a
browser cannot do on its own, and it stores nothing:

1. **OneDrive token broker.** Microsoft caps refresh tokens for browser-only (SPA) apps at
   24 hours, non-sliding and not configurable. A confidential client (the Worker, with a client
   secret) gets 90-day sliding refresh tokens. The refresh token is sealed (AES-GCM) with a key
   only the Worker holds and kept in an HttpOnly cookie on the user's own device. The Worker
   never keeps a copy. Access tokens go to the page, which calls Microsoft Graph directly.
2. **Resend relay.** api.resend.com sends no CORS headers, so a browser cannot call it. The
   user's Resend API key is sealed into an HttpOnly cookie the same way; the Worker unseals it
   per request and forwards.

## Layout

```
web/
  src/core/        pure TS, no DOM: runs in the pipeline worker, the main thread and Node tests
    types.ts       ColorMode, QualityTier (caps, JPEG quality), RecognizedLine, ProcessedPage
    raster.ts      RGBAImage / GrayImage / FloatImage, Point, Quad
    resample.ts    area-average downscale (deterministic; stands in for CoreGraphics draws)
    pageAnalyzer.ts  port of PageAnalyzer.swift: colour / greyscale / B&W decision
    imageProcessor.ts port of ImageProcessor.swift: flat-field, enhance, binarise, encode
    jpeg.ts        JpegEncoder type + mozjpeg (@jsquash/jpeg) implementation
    deflate.ts     zlib via fflate (PDF /FlateDecode)
    pdfWriter.ts   port of PDFWriter.swift: byte-for-byte JPEG, 1-bit Flate, invisible text
    paperSize.ts   port of PaperSize.swift
    text.ts        plainText / suggestedTitle (port of OCRService helpers)
    geometry.ts    homography, perspective warp, output-size estimate
    detect.ts      document quad detection on a small grey frame
  src/workers/pipeline.worker.ts  decode → warp → analyse → render → encode, off the main thread
  src/services/    db (IndexedDB), onedrive (Graph), resend (relay client), ocr (tesseract.js), outbox
  src/ui/          React screens
  worker/          Cloudflare Worker (/api/*)
  test/core, test/worker   vitest (Node)
  test/e2e         Playwright
```

## Core contracts

```ts
// resample.ts
resizeRGBA(img: RGBAImage, width: number, height: number): RGBAImage      // area average down, bilinear up
resizeGray(img: GrayImage, width: number, height: number): GrayImage
toGray(img: RGBAImage): GrayImage                                          // Rec.709 luma

// pageAnalyzer.ts
analyze(img: RGBAImage): { mode: ColorMode; stats: AnalyzerStats }

// jpeg.ts
type JpegEncoder = (img: RGBAImage, quality01: number, grayscale: boolean) => Promise<Uint8Array>
mozjpegEncoder: JpegEncoder

// imageProcessor.ts
processPage(source: RGBAImage, mode: ColorMode, tier: QualityTier, encode: JpegEncoder)
  : Promise<RenderedPage & { preview: RGBAImage }>     // preview = the 8-bit pixels before packing
ocrInput(source: RGBAImage, maxEdge = 2600): GrayImage  // flat-fielded grey for Tesseract

// pdfWriter.ts
interface PDFPageInput { imageData; encoding; pixelWidth; pixelHeight; pageSize: {width,height}; textLines }
makePDF(pages: PDFPageInput[], title?: string, creationDate = new Date()): Uint8Array
buildPDF(pages: ProcessedPage[], title?: string): Uint8Array   // applies PaperSize

// geometry.ts
homography(from: Quad, to: Quad): Float64Array(9)
warpPerspective(src: RGBAImage, quad: Quad, outW: number, outH: number): RGBAImage
outputSize(quad: Quad, imgW: number, imgH: number, maxLongEdge: number): { width; height }
orderQuad(points: Point[]): Quad   // → TL, TR, BR, BL

// detect.ts
detectDocument(gray: GrayImage): { quad: Quad; confidence: number } | null   // quad in gray's pixel space
```

`RecognizedLine.box` is normalised, bottom-left origin. Quads are source pixels, top-left
origin, ordered TL, TR, BR, BL.

## Worker API (`/api/*`, same-origin only, no CORS)

All state-changing calls are POST and require header `X-SnapDrive: 1`; the Worker also
rejects a mismatched `Origin`. Cookies are `HttpOnly; Secure; SameSite=Strict` except the
short-lived OAuth state cookie (`Lax`, needed on the redirect back from Microsoft).

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ ok, version }` |
| `GET /api/config` | `{ onedrive: boolean, tenant }`: whether the MS client secret is configured |
| `GET /api/ms/login?return=/path` | sets `sd_oauth` (sealed state + PKCE verifier, 10 min), 302 to Microsoft |
| `GET /api/ms/callback` | checks state, redeems the code with secret + verifier, sets `sd_ms` (sealed refresh token, 90 days), 302 to `return` with `#ms=ok` or `#ms=error&message=…` |
| `POST /api/ms/token` | refresh grant from `sd_ms`; returns `{ access_token, expires_in }`, rotates the cookie. 401 `{ error: "signed_out" }` when there is none or Microsoft refuses it (cookie cleared) |
| `POST /api/ms/logout` | clears `sd_ms` |
| `PUT /api/ms/chunk` | fallback relay for an upload-session chunk when the browser cannot PUT to the upload URL directly. Headers `X-Upload-Url`, `Content-Range`; host must be a Microsoft storage host |
| `POST /api/resend/connect` | `{ apiKey }` → validates against Resend, sets `sd_rs` (sealed key, 400 days); returns `{ access: "full"\|"sending", keyHint, domains? }` |
| `GET /api/resend/status` | `{ connected, access, keyHint }` |
| `GET /api/resend/domains` | Resend `GET /domains` passthrough (full-access keys only) |
| `POST /api/resend/emails` | Resend `POST /emails` passthrough; forwards `Idempotency-Key` |
| `POST /api/resend/disconnect` | clears `sd_rs` |

Secrets: `SEAL_KEY` (32 random bytes, base64), `MS_CLIENT_SECRET`. Vars: `MS_CLIENT_ID`,
`MS_TENANT` (`consumers`). The OAuth redirect URI is `<request origin>/api/ms/callback`, so
each origin (production and `http://localhost:8794`) must be registered on the Azure app as a
**Web** platform redirect URI.
