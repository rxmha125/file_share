"""Prepare Dtray brand assets for the web app.

Takes the approved final PNGs from the Designs folder and produces web-ready
variants: transparent whitespace auto-cropped, downscaled to sensible sizes,
with light-mode (dark wordmark) and dark-mode (white wordmark) lockups.
"""
import os
from PIL import Image

SRC = r"C:\Users\Rx MHA\Downloads\Designs\output\dtray\Final"
OUT = r"C:\Users\Rx MHA\Downloads\file_share_web\public\assets"

os.makedirs(OUT, exist_ok=True)

# name -> (source file, target height in px, is_full_lockup)
JOBS = [
    # symbol only
    ("2026-10-25_dtray-final-logo-symbol-transparent_v02.png", "dtray-symbol.png", 256, False),
    # full lockup, dark text (light backgrounds)
    ("2026-10-25_dtray-final-logo-full-transparent_v02.png", "dtray-logo-dark-text.png", 96, True),
    # full lockup, white text (dark backgrounds)
    ("2026-10-25_dtray-final-logo-full-white-text-transparent_v02.png", "dtray-logo-white-text.png", 96, True),
]


def crop_to_content(img, pad_ratio=0.0):
    """Crop fully-transparent margins away. pad_ratio adds breathing room."""
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return rgba
    if pad_ratio:
        w, h = rgba.size
        px = int(w * pad_ratio)
        py = int(h * pad_ratio)
        bbox = (
            max(0, bbox[0] - px),
            max(0, bbox[1] - py),
            min(w, bbox[2] + px),
            min(h, bbox[3] + py),
        )
    return rgba.crop(bbox)


def scale_to_height(img, target_h):
    w, h = img.size
    if h == 0:
        return img
    scale = target_h / h
    new_w = max(1, round(w * scale))
    return img.resize((new_w, target_h), Image.LANCZOS)


for src_name, out_name, target_h, is_full in JOBS:
    src_path = os.path.join(SRC, src_name)
    img = Image.open(src_path)
    print(f"{src_name}: original {img.size} mode={img.mode}")

    cropped = crop_to_content(img)
    print(f"  cropped -> {cropped.size}")

    scaled = scale_to_height(cropped, target_h)
    out_path = os.path.join(OUT, out_name)
    scaled.save(out_path, "PNG", optimize=True)
    print(f"  saved {out_name}: {scaled.size} ({os.path.getsize(out_path)//1024}KB)")

# Also emit the symbol at a couple of sizes for crispness at different UI densities
sym = crop_to_content(Image.open(os.path.join(SRC, "2026-10-25_dtray-final-logo-symbol-transparent_v02.png")))
for h in (64, 128, 512):
    s = scale_to_height(sym, h)
    p = os.path.join(OUT, f"dtray-symbol-{h}.png")
    s.save(p, "PNG", optimize=True)
    print(f"  saved dtray-symbol-{h}.png: {s.size}")

# Favicon: symbol on transparent, small
fav = scale_to_height(sym, 64)
fav.save(os.path.join(OUT, "favicon.png"), "PNG", optimize=True)
print("  saved favicon.png")

print("\nDone. Output dir:", OUT)
for f in sorted(os.listdir(OUT)):
    print("  ", f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KB")
