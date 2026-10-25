"""Prepare Dtray brand assets for the web app.

The source PNGs carry a very faint alpha halo (values 1-4) that extends far
beyond the artwork. A plain alpha bbox therefore keeps hundreds of pixels of
invisible padding, which makes the logo render small with "empty sides".
Crop against an alpha *threshold* instead so the box hugs the real artwork.
"""
import os
from PIL import Image

SRC = r"C:\Users\Rx MHA\Downloads\Designs\output\dtray\Final"
OUT = r"C:\Users\Rx MHA\Downloads\file_share_web\public\assets"

os.makedirs(OUT, exist_ok=True)

ALPHA_THRESHOLD = 16  # ignore the invisible halo (values 1-4)


def tight_crop(img, threshold=ALPHA_THRESHOLD):
    """Crop to the bounding box of pixels whose alpha exceeds `threshold`."""
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    mask = alpha.point(lambda v: 255 if v > threshold else 0)
    bbox = mask.getbbox()
    if not bbox:
        return rgba
    return rgba.crop(bbox)


def square_canvas(img, pad_ratio=0.0):
    """Centre `img` on a transparent square canvas that just contains it."""
    w, h = img.size
    side = max(w, h)
    pad = int(side * pad_ratio)
    side += pad * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def resize_h(img, target_h):
    w, h = img.size
    return img.resize((max(1, round(w * target_h / h)), target_h), Image.LANCZOS)


def report(name, img):
    print(f"  {name}: {img.size}")


print("Cropping to real artwork (alpha > %d):" % ALPHA_THRESHOLD)

# ---- full lockups -------------------------------------------------------
lockups = {
    "dtray-logo-dark-text.png":  ("2026-10-25_dtray-final-logo-full-transparent_v02.png", 36),
    "dtray-logo-white-text.png": ("2026-10-25_dtray-final-logo-full-white-text-transparent_v02.png", 36),
}
for out_name, (src_name, target_h) in lockups.items():
    img = tight_crop(Image.open(os.path.join(SRC, src_name)))
    print(f"\n{src_name}")
    report("tight crop", img)
    out = resize_h(img, target_h)
    out.save(os.path.join(OUT, out_name), "PNG", optimize=True)
    report("saved " + out_name, out)

# ---- symbol -------------------------------------------------------------
sym_src = Image.open(os.path.join(SRC, "2026-10-25_dtray-final-logo-symbol-transparent_v02.png"))
sym = tight_crop(sym_src)
print("\nsymbol")
report("tight crop", sym)

# square version, the symbol fills it with a hair of breathing room
sym_sq = square_canvas(sym, pad_ratio=0.0)
report("square canvas", sym_sq)
for h in (64, 128, 512):
    s = sym_sq.resize((h, h), Image.LANCZOS)
    s.save(os.path.join(OUT, f"dtray-symbol-{h}.png"), "PNG", optimize=True)
    report(f"saved dtray-symbol-{h}.png", s)

# the plain symbol used in the UI
sym_ui = resize_h(sym, 256)
sym_ui.save(os.path.join(OUT, "dtray-symbol.png"), "PNG", optimize=True)
report("saved dtray-symbol.png", sym_ui)

# ---- favicon: square, tightly cropped --------------------------------
fav = sym_sq.resize((128, 128), Image.LANCZOS)
fav.save(os.path.join(OUT, "favicon.png"), "PNG", optimize=True)
report("saved favicon.png (128x128)", fav)

print("\nDone.")
for f in sorted(os.listdir(OUT)):
    if f.endswith(".png"):
        im = Image.open(os.path.join(OUT, f))
        print(f"  {f:28s} {str(im.size):12s} {os.path.getsize(os.path.join(OUT, f))//1024} KB")
