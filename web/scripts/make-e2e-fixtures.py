"""Generate end-to-end test inputs: a phone-style photo of a printed invoice on a wooden desk.

Outputs (gitignored, regenerate any time):
  test/fixtures/e2e/doc-photo.jpg   3024x4032 portrait photo, page in perspective with a shadow
  test/fixtures/e2e/doc-camera.y4m  1280x960 frames for Chrome's fake camera
                                    (--use-file-for-fake-video-capture)
  test/fixtures/e2e/truth.json      page corners in each image

Run: python -P -E scripts/make-e2e-fixtures.py
"""
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures" / "e2e"
OUT.mkdir(parents=True, exist_ok=True)
rng = random.Random(7)

FONT_DIR = Path("C:/Windows/Fonts")


def font(name, size):
    for candidate in (FONT_DIR / name, Path("/System/Library/Fonts/Supplemental") / name, Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")):
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def make_page(w=2550, h=3300):
    page = Image.new("RGB", (w, h), (250, 249, 245))
    d = ImageDraw.Draw(page)
    big, body, small = font("arialbd.ttf", 96), font("arial.ttf", 54), font("arial.ttf", 44)
    # Colour logo blocks the size of v1's colour fixture (~2.4% of the page is vivid): above the
    # analyser's 1.5% vivid-area threshold, so the page must come out in colour.
    d.rectangle([204, 180, 969, 360], fill=(28, 107, 209))
    d.rectangle([1071, 180, 1428, 360], fill=(230, 74, 41))
    d.text((200, 440), "INVOICE 2026-0814", font=big, fill=(20, 20, 20))
    lines = [
        "Atlanta Industry Supply Co.",
        "1450 Riverbend Road SE, Calgary AB",
        "",
        "Description                         Qty        Amount",
        "Hydraulic coupling 3/4in             12        408.00",
        "Reinforced hose, 10m                  4        236.50",
        "Shipping and handling                 1         45.00",
        "",
        "Subtotal                                       689.50",
        "GST 5 percent                                   34.48",
        "Total due                                      723.98",
        "",
        "Payment is due within thirty days of the invoice date.",
        "Late payments accrue interest at 1.5 percent per month.",
        "Please quote the invoice number on all remittances.",
    ]
    y = 620
    for line in lines:
        if line:
            d.text((200, y), line, font=body, fill=(25, 25, 25))
        y += 92
    d.line([200, y + 40, w - 200, y + 40], fill=(60, 60, 60), width=4)
    d.text((200, y + 80), "Thank you for your business.", font=small, fill=(60, 60, 60))
    return page


def wood(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for x in range(w):
        grain = math.sin(x / 9.0 + math.sin(x / 57.0) * 3) * 12 + math.sin(x / 2.3) * 4
        for y in range(0, h, 1):
            v = grain + math.sin(y / 300.0 + x / 800.0) * 6
            px[x, y] = (int(150 + v), int(98 + v * 0.8), int(58 + v * 0.5))
    return img.filter(ImageFilter.GaussianBlur(1.2))


def coeffs(src, dst):
    """PIL perspective coefficients mapping output (dst) pixels back to input (src)."""
    import numpy as np  # noqa: PLC0415

    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        B += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()


def photo(W, H, corners, blur=0.8):
    page = make_page()
    pw, ph = page.size
    bg = wood(W, H)
    c = coeffs([(0, 0), (pw, 0), (pw, ph), (0, ph)], corners)
    warped = page.transform((W, H), Image.Transform.PERSPECTIVE, c, Image.Resampling.BICUBIC)
    mask = Image.new("L", (pw, ph), 255).transform((W, H), Image.Transform.PERSPECTIVE, c, Image.Resampling.BILINEAR)
    # Soft drop shadow under the page.
    shadow = mask.filter(ImageFilter.GaussianBlur(W / 120))
    dark = Image.new("RGB", (W, H), (40, 25, 15))
    bg = Image.composite(dark, bg, shadow.point(lambda v: int(v * 0.45)))
    out = Image.composite(warped, bg, mask)
    # A hand's shadow across one corner of the page.
    grad = Image.linear_gradient("L").resize((W, H)).rotate(35, expand=False)
    out = Image.composite(out, Image.eval(out, lambda v: int(v * 0.72)), grad.point(lambda v: 255 if v > 90 else int(255 * v / 90)))
    return out.filter(ImageFilter.GaussianBlur(blur))


def project_letter(W, H, f, tilt_deg, roll_deg, yaw_deg, fill):
    """Corners of an 8.5x11 page seen by a pinhole camera (focal length f px, principal point
    at the image centre), so the true aspect ratio is recoverable from the quad."""
    import numpy as np  # noqa: PLC0415

    pw, ph = 8.5, 11.0
    pts = np.array([[-pw / 2, -ph / 2, 0], [pw / 2, -ph / 2, 0], [pw / 2, ph / 2, 0], [-pw / 2, ph / 2, 0]])
    t, r, y = np.radians([tilt_deg, roll_deg, yaw_deg])
    Rx = np.array([[1, 0, 0], [0, np.cos(t), -np.sin(t)], [0, np.sin(t), np.cos(t)]])
    Ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    Rz = np.array([[np.cos(r), -np.sin(r), 0], [np.sin(r), np.cos(r), 0], [0, 0, 1]])
    cam = pts @ (Rz @ Ry @ Rx).T
    dist = f * ph / (H * fill)  # page height covers ~`fill` of the frame
    cam[:, 2] += dist
    return [(float(W / 2 + f * x / z), float(H / 2 + f * yy / z)) for x, yy, z in cam]


# iPhone main camera: 26 mm equivalent → f ≈ 0.963 x short edge (3024 px) ≈ 2912 px.
still_corners = project_letter(3024, 4032, 2912, tilt_deg=16, roll_deg=5, yaw_deg=-7, fill=0.66)
photo(3024, 4032, still_corners).save(OUT / "doc-photo.jpg", quality=92)

cam_w, cam_h = 960, 1280  # portrait, like a phone held upright
cam_corners = project_letter(cam_w, cam_h, 2912 * cam_w / 3024, tilt_deg=16, roll_deg=5, yaw_deg=-7, fill=0.66)
frame = photo(cam_w, cam_h, cam_corners, blur=0.6)

# Y4M (4:2:0) with ~3 s of identical frames; Chrome loops it.
def to_yuv420(img):
    import numpy as np  # noqa: PLC0415

    a = np.asarray(img).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    y = 16 + 0.257 * r + 0.504 * g + 0.098 * b
    u = 128 - 0.148 * r - 0.291 * g + 0.439 * b
    v = 128 + 0.439 * r - 0.368 * g - 0.071 * b
    u = u.reshape(cam_h // 2, 2, cam_w // 2, 2).mean(axis=(1, 3))
    v = v.reshape(cam_h // 2, 2, cam_w // 2, 2).mean(axis=(1, 3))
    return b"".join(x.clip(0, 255).astype(np.uint8).tobytes() for x in (y, u, v))


yuv = to_yuv420(frame)
with open(OUT / "doc-camera.y4m", "wb") as f:
    f.write(f"YUV4MPEG2 W{cam_w} H{cam_h} F10:1 Ip A1:1 C420jpeg\n".encode())
    for _ in range(30):
        f.write(b"FRAME\n" + yuv)

(OUT / "truth.json").write_text(json.dumps({"doc-photo.jpg": still_corners, "doc-camera.y4m": cam_corners}, indent=2))
print("wrote", sorted(p.name for p in OUT.iterdir()))
