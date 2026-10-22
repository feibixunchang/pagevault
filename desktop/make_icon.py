#!/usr/bin/env python3
"""Generate PageVault app icon (.icns) from a 1024 master.

Design: rounded-square indigo->violet gradient, a white "saved page" card
with text lines, and a green check badge = "page safely stored".
"""
import math
import os
from PIL import Image, ImageDraw

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(__file__), "AppIcon.iconset")
ICNS = os.path.join(os.path.dirname(__file__), "AppIcon.icns")

os.makedirs(OUT_DIR, exist_ok=True)

# ---- palette ----
TOP = (79, 70, 229)      # indigo-600
BOTTOM = (124, 58, 237)  # violet-600
PAGE = (255, 255, 255)
LINE = (203, 213, 225)   # slate-300
BADGE = (34, 197, 94)    # green-500
BADGE_HI = (74, 222, 128)


def make_master():
    img = Image.new("RGBA", (SIZE, SIZE))
    px = img.load()
    for y in range(SIZE):
        t = y / (SIZE - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(SIZE):
            px[x, y] = (r, g, b, 255)
    d = ImageDraw.Draw(img)

    # rounded-square background (full bleed)
    d.rounded_rectangle([0, 0, SIZE, SIZE], radius=224, fill=(0, 0, 0, 0))
    # redraw gradient clipped to rounded shape via mask
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE, SIZE], radius=224, fill=255)
    grad = Image.new("RGBA", (SIZE, SIZE))
    gp = grad.load()
    for y in range(SIZE):
        t = y / (SIZE - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(SIZE):
            gp[x, y] = (r, g, b, 255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # white page card
    card = [300, 232, 724, 812]
    d.rounded_rectangle(card, radius=64, fill=PAGE)

    # folded corner (subtle)
    fc = 120
    d.polygon([(724 - fc, 232), (724, 232), (724, 232 + fc)],
              fill=(229, 231, 235))

    # text lines
    ly = 360
    for w in (300, 240, 200):
        d.rounded_rectangle([372, ly, 372 + w, ly + 34], radius=17, fill=LINE)
        ly += 86

    # check badge (bottom-right)
    cx, cy, rad = 720, 720, 132
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=BADGE)
    d.ellipse([cx - rad + 10, cy - rad + 10, cx + rad - 10, cy + rad - 10],
              outline=BADGE_HI, width=10)
    # checkmark
    chk = [(cx - 58, cy + 6), (cx - 14, cy + 52), (cx + 70, cy - 56)]
    d.line(chk, fill=(255, 255, 255), width=34, joint="curve")

    return img


def main():
    master = make_master()
    specs = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    for name, px in specs:
        resized = master.resize((px, px), Image.LANCZOS)
        # keep alpha crisp
        resized.save(os.path.join(OUT_DIR, name))
    print("iconset written:", OUT_DIR)
    os.system(f'iconutil --convert icns "{OUT_DIR}" -o "{ICNS}"')
    print("icns written:", ICNS, "bytes=", os.path.getsize(ICNS))


if __name__ == "__main__":
    main()
