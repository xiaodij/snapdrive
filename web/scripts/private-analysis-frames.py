"""Convert the private real-photo fixtures to PNGs the Node analyser test can read.

Reads test/fixtures/private/raw/** (JPEG/HEIC phone photos, never committed), applies EXIF
orientation, caps the long edge at 2400 px (the analyser's own tone resolution, so nothing it
measures is lost) and writes test/fixtures/private/analysis/NN-<name>.png plus index.json (file -> source photo).

    python -P -E scripts/private-analysis-frames.py
"""
import json, pathlib, re
from PIL import Image, ImageOps
import pillow_heif

pillow_heif.register_heif_opener()
root = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures" / "private"
src, out = root / "raw", root / "analysis"
out.mkdir(exist_ok=True)
files = sorted(p for p in src.rglob("*") if p.is_file() and not p.name.startswith("._"))
index = {}
for i, p in enumerate(files, 1):
    im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
    im.thumbnail((2400, 2400), Image.LANCZOS)
    name = re.sub(r"[^A-Za-z0-9]+", "_", p.stem)[:30]
    im.save(out / f"{i:02d}-{name}.png")
    index[f"{i:02d}-{name}.png"] = {"source": p.relative_to(src).as_posix(), "width": im.width, "height": im.height}
    print(f"{i:02d} {im.width}x{im.height} {p.relative_to(src)}")
(out / "index.json").write_text(json.dumps(index, indent=1))
