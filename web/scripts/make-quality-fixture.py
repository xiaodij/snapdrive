"""A deskewed page as a phone actually delivers it: soft, ~212 dpi, unevenly lit, JPEG noise.

Small serif and sans text with thin strokes (the strokes v1's B&W path broke: serif E arms,
i-dots), thin rules and a lightly shaded band, with the exact text kept as ground truth so
the quality lab can score OCR word accuracy of each rendering.

Outputs (gitignored): test/fixtures/quality/soft-page.png, soft-page.txt
Run: python -P -E scripts/make-quality-fixture.py
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures" / "quality"
OUT.mkdir(parents=True, exist_ok=True)
FONTS = Path("C:/Windows/Fonts")
rng = random.Random(11)

DPI = 600
W, H = int(8.5 * DPI), int(11 * DPI)


def font(name, pt):
    return ImageFont.truetype(str(FONTS / name), int(pt * DPI / 72))


page = Image.new("L", (W, H), 250)
d = ImageDraw.Draw(page)
words = (
    "assessment successor petroleum corporate taxation interest balance refund payable notice "
    "agreement assignment procedure consent purchase vendor partnership respectfully transaction "
    "royalty undertaking provisions continue effect directors resolution statement deposit cheque "
    "account summary charges journey energy monitoring limited exploration alberta calgary"
).split()

truth_lines = []
y = int(0.6 * DPI)
blocks = [("timesbd.ttf", 12, 1), ("times.ttf", 11, 6), ("times.ttf", 9, 6), ("arial.ttf", 10, 5), ("arial.ttf", 8, 6), ("times.ttf", 10, 5)]
for name, pt, n in blocks:
    f = font(name, pt)
    for _ in range(n):
        line = " ".join(rng.choice(words).capitalize() if rng.random() < 0.15 else rng.choice(words) for _ in range(rng.randint(6, 9)))
        if rng.random() < 0.3:
            line += f" {rng.randint(100, 99999):,}.{rng.randint(0, 99):02d}"
        d.text((int(0.75 * DPI), y), line, font=f, fill=15)
        truth_lines.append(line)
        y += int(pt * DPI / 72 * 1.55)
    y += int(0.18 * DPI)
    d.line([(int(0.75 * DPI), y - int(0.1 * DPI)), (W - int(0.75 * DPI), y - int(0.1 * DPI))], fill=40, width=3)  # thin rule
# A lightly shaded band (table header) with text on it.
d.rectangle([int(0.75 * DPI), y, W - int(0.75 * DPI), y + int(0.35 * DPI)], fill=205)
d.text((int(0.85 * DPI), y + int(0.08 * DPI)), "Opening balance prior to this assessment", font=font("times.ttf", 10), fill=15)
truth_lines.append("Opening balance prior to this assessment")

# Lens softness, then down to ~212 dpi like v1's VisionKit pages (1800 px wide).
page = page.filter(ImageFilter.GaussianBlur(3.8))
page = page.resize((1800, 2329), Image.Resampling.LANCZOS)
# Uneven lighting: a soft shadow from one corner.
grad = Image.linear_gradient("L").rotate(-30, expand=False).resize(page.size).filter(ImageFilter.GaussianBlur(120))
page = Image.composite(page, page.point(lambda v: int(v * 0.68)), grad.point(lambda v: min(255, v * 2)))
# Sensor noise + camera JPEG.
noise = Image.effect_noise(page.size, 6).point(lambda v: v - 128)
page = Image.eval(Image.merge("RGB", [page] * 3), lambda v: v)
page.save(OUT / "soft-page.jpg", quality=85)
Image.open(OUT / "soft-page.jpg").convert("RGB").save(OUT / "soft-page.png")
(OUT / "soft-page.txt").write_text("\n".join(truth_lines), encoding="utf-8")
print("wrote", OUT / "soft-page.png", page.size, len(truth_lines), "lines")
