"""Build Dtray web assets from the new source artwork.

Sources (in ~/Downloads):
  dtray-transparent-text-logo-new.png  — symbol + wordmark, wordmark is WHITE
  dtray-transparent-logo-new.png       — symbol only

The wordmark is white, which is invisible on the light theme, so this emits
two lockups: the original white one for dark backgrounds, and a recoloured
dark-ink one for light backgrounds. Only achromatic bright pixels to the right
of the symbol are recoloured, so the blue/green/yellow mark is untouched.
"""
import os
from PIL import Image

SRC_DIR = os.path.expanduser("~/Downloads")
OUT = r"C:\Users\Rx MHA\Downloads\file_share_web\public\assets"
os.makedirs(OUT, exist_ok=True)

ALPHA_THRESHOLD = 16
INK = (31, 31, 31)  # matches --text in the light theme


def tight_crop(img, threshold=ALPHA_THRESHOLD):
    rgba = img.convert("RGBA")
    mask = rgba.getchannel("A").point(lambda v: 255 if v > threshold else 0)
    bbox = mask.getbbox()
    return rgba.crop(bbox) if bbox else rgba


def symbol_right_edge(img):
    """Right-most x that contains a saturated (coloured) opaque pixel."""
    w, h = img.size
    edge = 0
    for x in range(w):
        for y in range(0, h, 2):
            r, g, b, a = img.getpixel((x, y))
            if a > 128 and (max(r, g, b) - min(r, g, b)) > 60:
                edge = x
                break
    return edge


def recolour_wordmark(img, edge, ink=INK):
    """Turn near-white opaque pixels right of `edge` into `ink`, keeping alpha."""
    out = img.copy()
    px = out.load()
    w, h = out.size
    for x in range(max(0, edge), w):
        for y in range(h):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if max(r, g, b) - min(r, g, b) < 28 and min(r, g, b) > 140:
                px[x, y] = (ink[0], ink[1], ink[2], a)
    return out


def resize_h(img, target_h):
    w, h = img.size
    return img.resize((max(1, round(w * target_h / h)), target_h), Image.LANCZOS)


def square_canvas(img):
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


# ---------------------------------------------------------------- lockups
src = Image.open(os.path.join(SRC_DIR, "dtray-transparent-text-logo-new.png"))
lock = tight_crop(src)
print("text logo tight crop:", lock.size)

edge = symbol_right_edge(lock)
print("symbol right edge:", edge, f"({edge / lock.width:.0%} of width)")

# white wordmark — for dark backgrounds
white = resize_h(lock, 72)   # 2x of the 36px CSS height
white.save(os.path.join(OUT, "dtray-logo-white-text.png"), "PNG", optimize=True)
print("  dtray-logo-white-text.png ", white.size)

# dark ink wordmark — for light backgrounds
dark = resize_h(recolour_wordmark(lock, edge), 72)   # 2x of the 36px CSS height
dark.save(os.path.join(OUT, "dtray-logo-dark-text.png"), "PNG", optimize=True)
print("  dtray-logo-dark-text.png  ", dark.size)

# ---------------------------------------------------------------- symbol
sym_src = Image.open(os.path.join(SRC_DIR, "dtray-transparent-logo-new.png"))
sym = tight_crop(sym_src)
print("\nsymbol tight crop:", sym.size)

sq = square_canvas(sym)
for size in (64, 128, 512):
    sq.resize((size, size), Image.LANCZOS).save(
        os.path.join(OUT, f"dtray-symbol-{size}.png"), "PNG", optimize=True)
    print(f"  dtray-symbol-{size}.png")

resize_h(sym, 256).save(os.path.join(OUT, "dtray-symbol.png"), "PNG", optimize=True)

# favicon: square, artwork touches top and bottom
sq.resize((128, 128), Image.LANCZOS).save(
    os.path.join(OUT, "favicon.png"), "PNG", optimize=True)
print("  favicon.png (128x128)")

sq.resize((180, 180), Image.LANCZOS).save(
    os.path.join(OUT, "apple-touch-icon.png"), "PNG", optimize=True)
print("  apple-touch-icon.png (180x180)")

print("\nDone.")
for f in sorted(os.listdir(OUT)):
    if f.endswith(".png"):
        im = Image.open(os.path.join(OUT, f))
        print(f"  {f:28s} {str(im.size):12s} {os.path.getsize(os.path.join(OUT, f))//1024} KB")
