# Snap

An iOS document scanner that crops, deskews, cleans up and uploads straight to OneDrive.
Everything runs on the phone — the Mac is only needed to build and install it.

- **Capture** — VisionKit's document camera: automatic edge detection, perspective
  correction, multi-page, with manual corner handles when the auto crop is wrong.
- **Colour decision** — each page is measured and rendered as colour, greyscale or
  black & white, whichever suits it. Overridable per page.
- **Cleanup** — uneven lighting and shadows are divided out before rendering.
- **OCR** — on-device via the Neural Engine, layered invisibly behind the page so the PDF
  is searchable and selectable. No network, nothing leaves the phone.
- **Upload** — one multi-page PDF straight to a OneDrive folder you pick.

## One-time setup

### 1. Register an Azure app — **already done**

The registration exists and its client ID is compiled into `Snap/Config.swift`:

| | |
|---|---|
| Display name | `Snap` |
| Application (client) ID | `de30792a-98aa-4d0a-90e5-0f86eda12646` |
| Sign-in audience | `PersonalMicrosoftAccount` |
| Redirect URI | `msauth.com.xiaodijin.snap://auth` (public client) |
| Permissions | `Files.ReadWrite`, `User.Read`, `offline_access` (delegated) |

It was created with:

```sh
az login --allow-no-subscriptions
az ad app create --display-name "Snap" \
  --sign-in-audience PersonalMicrosoftAccount \
  --public-client-redirect-uris "msauth.com.xiaodijin.snap://auth" \
  --is-fallback-public-client true \
  --required-resource-accesses @perms.json
```

To inspect or change it later:

```sh
az ad app show --id de30792a-98aa-4d0a-90e5-0f86eda12646
```

The client ID is **not a secret** — a public client can't hold one, which is why the app
uses PKCE. On its own it grants no access to anything: a user still has to sign in with
their own Microsoft account and consent, and the resulting token only ever reaches their
own OneDrive.

**If you forked this**, register your own app with the commands above and replace the ID,
rather than reusing this one.

<details>
<summary>Recreating it from scratch (portal)</summary>

Sign in to <https://entra.microsoft.com> with the **same Microsoft account** that owns the
OneDrive you want to upload to.

1. **App registrations** → **New registration**
2. Name: `Snap`
3. Supported account types: **Personal Microsoft accounts only**
4. Redirect URI: platform **Mobile and desktop applications**, value:

   ```
   msauth.com.xiaodijin.snap://auth
   ```

5. **Register**, then copy the **Application (client) ID** from the overview page.
6. **Authentication** → confirm **Allow public client flows** is set to **Yes**.
7. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated
   permissions** → add `Files.ReadWrite`, `User.Read`, and `offline_access`.

No client secret is needed — the app uses PKCE, which is the correct flow for a public
client that can't keep a secret.

</details>

### 2. Give the app the client ID

Already compiled in via `defaultClientID` in `Snap/Config.swift`. A different ID can be
pasted into **Settings → OneDrive app registration** in the app at runtime, which
overrides the compiled-in value without a rebuild.

### 3. Build and install

```sh
xcodegen generate                                    # regenerate Snap.xcodeproj
open Snap.xcodeproj                                  # then Cmd-R with your phone selected
```

Or from the command line, with the phone plugged in and unlocked:

```sh
xcodebuild -project Snap.xcodeproj -scheme Snap \
  -destination 'platform=iOS,name=YOUR PHONE' build
```

Set `DEVELOPMENT_TEAM` in `project.yml` to your own Apple team ID before building. With a
paid developer account an install lasts a year; on a free Apple ID it expires after 7 days
and needs re-signing.

### Changing the bundle ID

If you change `PRODUCT_BUNDLE_IDENTIFIER`, you must also update, in lockstep:

- `Config.bundleID` in `Snap/Config.swift`
- the `CFBundleURLSchemes` entry in `project.yml`
- the redirect URI in the Azure registration

They all have to spell the same thing or the sign-in redirect won't come back.

### Work/school accounts

`Config.tenant` is `consumers` (personal Microsoft accounts). Change it to `common` and
re-register the Azure app with a matching account type to allow work/school accounts too.

## How pages get processed

**Colour decision.** Two measurements, each taken at the resolution where it means
something:

- *Colour* comes from a 256px thumbnail — hue is low-frequency, so a thumbnail sees it
  fine. Pixels are white-balanced against the page's own paper colour first. Without
  that, any page shot under warm indoor light reads as "colour" and triples in size.
- *Tone* is measured across the whole page at near-native resolution, because
  downsampling a text page turns crisp black-on-white into grey mush and every page then
  looks like it has photographs in it.

Lighting is cancelled by dividing through an illumination field built by *dilating* a
thumbnail — taking a local maximum erases text, shaded boxes and photos, leaving only
paper. That's what separates a shadow from a genuinely grey region: both are the same
pixel value, and only the surrounding paper level says which is which.

**Rendering.** Greyscale and B&W pages are flat-fielded the same way, so a fixed threshold
is safe — a global threshold on an unnormalised photo would black out whichever corner
your hand shaded. B&W output is packed to true 1 bit per pixel.

**PDF.** Written directly rather than through `UIGraphicsPDFRenderer`, for two reasons:
page JPEGs are embedded byte-for-byte as `/DCTDecode` with no recompression, and B&W pages
stay 1-bit `/FlateDecode`. The invisible text layer uses render mode 3 with an identity
`/ToUnicode` CMap, so any script Vision can read — including CJK — extracts correctly
without embedding a font.

**Page size** is inferred from the aspect ratio against the common paper sizes, so scans
print at the right scale instead of at some arbitrary DPI.

## Typical output

A 2550×3300 text page, Balanced quality:

| Mode | Pixels | Encoding | PDF |
|---|---|---|---|
| Colour | 1546×2000 | JPEG q0.60 | 165 KB |
| Greyscale | 1700×2200 | JPEG q0.60, grey | 171 KB |
| Black & White | 2319×3000 | 1-bit Flate | **36 KB** |

B&W is roughly 5× smaller *and* higher resolution — 1-bit content compresses about 20×, so
the extra resolution is nearly free and it's what keeps small type crisp. That's why the
analyser reaches for it whenever a page is just ink on paper.

## Testing the pipeline

The image and PDF code under `Snap/Core` is deliberately free of UIKit and VisionKit, so it
compiles and runs on macOS:

```sh
swift run PipelineTest
```

That builds synthetic scans — shadowed, warm-cast, with photos, with shaded boxes, with
colour logos — and checks the colour decision on each, verifies the shadow is actually
removed, prints encoded sizes, runs OCR and checks the text comes back, then writes PDFs to
`/tmp/snap-test`. Validate those with:

```sh
gs -dNOPAUSE -dBATCH -dQUIET -sDEVICE=nullpage /tmp/snap-test/*.pdf   # strict parse
pdftotext /tmp/snap-test/test-blackAndWhite.pdf -                     # OCR layer
pdfinfo /tmp/snap-test/test-multipage.pdf                             # page size
```

## Layout

```
Snap/Core/          UIKit-free: analysis, rendering, OCR, PDF writing
  Models/           ColorMode, QualityTier, RecognizedLine, ProcessedPage
  Processing/       PageAnalyzer, ImageProcessor, OCRService, DocumentPipeline
  PDF/              PDFWriter, PaperSize, Deflate
Snap/OneDrive/      PKCE OAuth, Graph client, keychain
Snap/App/           App entry, settings, scan coordination
Snap/Views/         SwiftUI screens
Tools/PipelineTest/ macOS harness for Snap/Core
```
