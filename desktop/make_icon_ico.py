"""Generate AppIcon.ico (Windows) from the 512x512 master PNG."""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "AppIcon.iconset", "icon_512x512.png")
OUT = os.path.join(HERE, "AppIcon.ico")


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(OUT, format="ICO", sizes=sizes)
    print("Generated %s (%d bytes)" % (OUT, os.path.getsize(OUT)))


if __name__ == "__main__":
    sys.exit(main())
