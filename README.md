# SnapDrive

> **v2 is a PWA** (iPhone, Android, desktop) with OneDrive upload *and* email through your own
> Resend account: see [`web/`](web/README.md), live at https://snapdrive.xjpc.ca.
> The native iOS app below (v1) is kept as it was at its final commit.

An iOS document scanner that crops, deskews, cleans up and uploads straight to OneDrive.
Everything runs on the phone — there is no server, and nothing is sent anywhere except the
finished PDF going to your own OneDrive.

- **Capture** — VisionKit's document camera: automatic edge detection, perspective
  correction, multi-page, with manual corner handles when the auto crop is wrong.
- **Colour decision** — each page is measured and rendered as colour, greyscale or
  black & white, whichever suits it. Overridable per page.
- **Cleanup** — uneven lighting and shadows are divided out before rendering.
- **OCR** — on-device via the Neural Engine, layered invisibly behind the page so the PDF
  is searchable and selectable. No network, no account, no per-page cost.
- **Upload** — one multi-page PDF to a OneDrive folder you pick.

Requires iOS 18 or later. Built and tested on an iPhone 13 Pro / 14 Pro; OCR works on any
device with a Neural Engine (A12 or newer).

---

## Setup

Four things: register an app with Microsoft, put its ID in one config file, build, install.
Budget about ten minutes. **None of it costs money** — Entra ID app registrations and
Microsoft Graph calls against personal OneDrive are free.

### Prerequisites

```sh
brew install xcodegen        # generates the Xcode project from project.yml
brew install azure-cli       # only needed for the CLI route in step 1
```

Plus Xcode 16 or later and an Apple ID for signing. A free Apple ID works — builds just
expire after 7 days instead of a year.

### 1. Register an Azure app

This is what lets the app ask for access to a OneDrive. It is free and takes one command.

<details open>
<summary><b>With the Azure CLI</b> (fastest)</summary>

```sh
az login --allow-no-subscriptions

cat > /tmp/graph-perms.json <<'EOF'
[{ "resourceAppId": "00000003-0000-0000-c000-000000000000",
   "resourceAccess": [
     { "id": "5c28f0bf-8a70-41f1-8ab2-9032436ddb65", "type": "Scope" },
     { "id": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", "type": "Scope" },
     { "id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d", "type": "Scope" }
   ]}]
EOF

az ad app create \
  --display-name "SnapDrive" \
  --sign-in-audience PersonalMicrosoftAccount \
  --public-client-redirect-uris "msauth.com.example.snapdrive://auth" \
  --is-fallback-public-client true \
  --required-resource-accesses @/tmp/graph-perms.json \
  --query appId -o tsv
```

Replace `com.example.snapdrive` with the bundle identifier you intend to use — it has to
match `PRODUCT_BUNDLE_IDENTIFIER` in step 2 exactly. The command prints your client ID.

Those three GUIDs are Microsoft Graph's `Files.ReadWrite`, `offline_access` and
`User.Read`. Verify them yourself if you like:

```sh
az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query "oauth2PermissionScopes[?value=='Files.ReadWrite'].id" -o tsv
```

If `az` complains about MFA when reading Graph, re-authenticate with the Graph scope:

```sh
az login --tenant <your-tenant-id> --scope "https://graph.microsoft.com//.default" --allow-no-subscriptions
```

</details>

<details>
<summary><b>Through the portal</b> instead</summary>

At <https://entra.microsoft.com>, signed in with the account that owns the OneDrive:

1. **App registrations** → **New registration**
2. Name: `SnapDrive`
3. Supported account types: **Personal Microsoft accounts only**
4. Redirect URI: platform **Mobile and desktop applications**, value
   `msauth.<your-bundle-id>://auth`
5. **Register**, then copy the **Application (client) ID**
6. **Authentication** → confirm **Allow public client flows** is **Yes**
7. **API permissions** → **Microsoft Graph** → **Delegated** → add `Files.ReadWrite`,
   `User.Read`, `offline_access`

</details>

**No client secret is needed.** The app uses PKCE, which is the correct flow for a public
client that cannot keep a secret. There is nothing to rotate and nothing to leak.

### 2. Configure

Everything fork-specific lives in one file — **`Config.xcconfig`**:

```
PRODUCT_BUNDLE_IDENTIFIER = com.example.snapdrive
DEVELOPMENT_TEAM          = ABCDE12345
SNAP_CLIENT_ID            = <the client id from step 1>
SNAP_TENANT               = consumers
```

| Key | Notes |
|---|---|
| `PRODUCT_BUNDLE_IDENTIFIER` | Must match the redirect URI registered in step 1. The app derives `msauth.<bundle-id>://auth` from it, so you never write that string twice. |
| `DEVELOPMENT_TEAM` | `security find-certificate -c "Apple Development" -p \| openssl x509 -noout -subject` |
| `SNAP_CLIENT_ID` | From step 1. Not a secret — see below. |
| `SNAP_TENANT` | `consumers` (personal accounts), `organizations` (work/school), `common` (both), or a specific tenant id. Must match the audience you registered. |

Nothing else needs editing. The bundle identifier flows into the redirect URI, the URL
scheme and the keychain scope automatically, and `Config.swift` reads the client ID and
tenant from Info.plist at runtime — so these values can't drift out of sync with each
other, which is the usual way this kind of setup breaks.

A client ID can also be pasted into **Settings → OneDrive app registration** in the running
app, which overrides the compiled-in value without a rebuild. Handy for testing; the
xcconfig is the real answer.

### 3. Build and install

```sh
xcodegen generate
open SnapDrive.xcodeproj      # select your phone, Cmd-R
```

Or from the command line, phone plugged in and unlocked:

```sh
xcodegen generate
xcrun devicectl list devices                       # find your device
xcodebuild -project SnapDrive.xcodeproj -scheme SnapDrive \
  -destination 'id=<device-udid>' -configuration Release \
  -derivedDataPath /tmp/snapdrive build
xcrun devicectl device install app --device <device-id> \
  /tmp/snapdrive/Build/Products/Release-iphoneos/SnapDrive.app
```

USB is considerably more reliable than a wireless connection for installs — over Wi-Fi the
tunnel frequently drops mid-transfer, so just retry if it does.

### 4. First run

1. On the phone: **Settings → General → VPN & Device Management** → trust your developer
   certificate. Only needed once.
2. Open SnapDrive, tap **Sign in to OneDrive**, approve the consent prompt.
3. Scan something.

---

## Is the client ID a secret?

No. Public clients — native apps — cannot hold secrets, because anyone can unpack the
binary. That is the entire reason this uses PKCE: the app sends a hash of a one-time random
verifier when starting sign-in and the verifier itself when redeeming the code, so an
intercepted authorization code is useless on its own.

A client ID grants no access to anything. A user still has to sign in with their own
Microsoft account and consent, and the resulting token only ever reaches *their* OneDrive.

The ID checked into `Config.xcconfig` belongs to the published build. **Register your own**
anyway — so your users see your app name on the consent screen, and your usage isn't
attributed to someone else's registration.

---

## How pages get processed

**Colour decision.** Two measurements, each taken at the resolution where it means
something:

- *Colour* comes from a 256px thumbnail — hue is low-frequency, so a thumbnail sees it
  fine. Pixels are white-balanced against the page's own paper colour first. Without
  that, any page shot under warm indoor light reads as "colour" and triples in size.
- *Tone* is measured across the whole page at near-native resolution, because
  downsampling a text page turns crisp black-on-white into grey mush and every page then
  looks like it contains photographs.

Lighting is cancelled by dividing through an illumination field built by *dilating* a
thumbnail — taking a local maximum erases text, shaded boxes and photos, leaving only
paper. That is what separates a shadow from a genuinely grey region: both are the same
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

### Typical output

A 2550×3300 text page, Balanced quality:

| Mode | Pixels | Encoding | PDF |
|---|---|---|---|
| Colour | 1546×2000 | JPEG q0.60 | 165 KB |
| Greyscale | 1700×2200 | JPEG q0.60, grey | 171 KB |
| Black & White | 2319×3000 | 1-bit Flate | **36 KB** |

B&W is roughly 5× smaller *and* higher resolution — 1-bit content compresses about 20×, so
the extra resolution is nearly free and it is what keeps small type crisp. That is why the
analyser reaches for it whenever a page is just ink on paper.

---

## Testing

The image and PDF code under `SnapDrive/Core` is deliberately free of UIKit and VisionKit,
so it compiles and runs on macOS:

```sh
swift run PipelineTest
```

That builds synthetic scans — shadowed, warm-cast, with photos, with shaded boxes, with
colour logos — checks the colour decision on each, verifies the shadow is actually removed,
prints encoded sizes, runs OCR and checks the text comes back, then writes PDFs to
`/tmp/snap-test`. Validate those with:

```sh
gs -dNOPAUSE -dBATCH -dQUIET -sDEVICE=nullpage /tmp/snap-test/*.pdf   # strict parse
pdftotext /tmp/snap-test/test-blackAndWhite.pdf -                     # OCR text layer
pdfinfo /tmp/snap-test/test-multipage.pdf                             # page size
```

**Known limitation:** the colour-mode thresholds are validated against synthetic fixtures,
not a corpus of real captures. They are named constants at the top of
`SnapDrive/Core/Processing/PageAnalyzer.swift` and are meant to be tuned. Every page also
has a manual override in the review screen.

### Logs

```sh
sudo log collect --device-udid <udid> --last 10m --output /tmp/snapdrive.logarchive
log show /tmp/snapdrive.logarchive --predicate 'subsystem == "<your-bundle-id>"' --info
```

Or open Console.app, select the device, and filter on your bundle identifier. Stage
transitions, per-page colour decisions and sizes, upload lifecycle and Graph error bodies
are all logged.

---

## Layout

```
SnapDrive/Core/       UIKit-free: analysis, rendering, OCR, PDF writing
  Models/             ColorMode, QualityTier, RecognizedLine, ProcessedPage
  Processing/         PageAnalyzer, ImageProcessor, OCRService, DocumentPipeline
  PDF/                PDFWriter, PaperSize, Deflate
SnapDrive/OneDrive/   PKCE OAuth, Graph client, keychain
SnapDrive/App/        App entry, settings, scan coordination, logging
SnapDrive/Views/      SwiftUI screens
Tools/PipelineTest/   macOS harness for SnapDrive/Core
Config.xcconfig       everything a fork needs to change
```

## Licence

MIT — see [LICENSE](LICENSE).
