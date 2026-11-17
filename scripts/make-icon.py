#!/usr/bin/env python3
"""Generate the JSON Studio app icon.

Requires Pillow (pip install pillow). This is a development helper; the
checked-in Resources/assets/AppIcon.icns is used directly by build.sh.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "Resources" / "assets"
CANVAS = 1024


def find_font() -> str:
    candidates = [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Menlo.ttc",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    raise SystemExit("No suitable system font found.")


def build_master() -> Image.Image:
    size = CANVAS
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Soft drop shadow.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((118, 132, 906, 920), radius=196, fill=(30, 24, 90, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    image.alpha_composite(shadow)

    # Rounded-square body.
    mask_image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(mask_image).rounded_rectangle((100, 100, 924, 924), radius=196, fill=(255, 255, 255, 255))
    mask = mask_image.getchannel("A")

    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    top = (139, 124, 255)
    bottom = (69, 63, 190)
    for y in range(size):
        t = y / (size - 1)
        eased = t * t * (3 - 2 * t)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * eased) for i in range(3)) + (255,)
        draw.line([(0, y), (size, y)], fill=color)

    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gloss_draw = ImageDraw.Draw(gloss)
    for radius in range(900, 0, -12):
        alpha = int(22 * (1 - radius / 900))
        gloss_draw.ellipse((512 - radius, -260 - radius // 2, 512 + radius, 420 + radius), fill=(255, 255, 255, alpha))
    gradient.alpha_composite(gloss)
    image.paste(gradient, (0, 0), mask)

    # Inner rim.
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rim_draw = ImageDraw.Draw(rim)
    rim_draw.rounded_rectangle((104, 104, 920, 920), radius=192, outline=(255, 255, 255, 60), width=5)
    rim_draw.rounded_rectangle((100, 100, 924, 924), radius=196, outline=(255, 255, 255, 28), width=3)
    image.alpha_composite(rim)

    # Braces.
    font = ImageFont.truetype(find_font(), 590)
    draw = ImageDraw.Draw(image)

    def centered(text: str, cx: float, cy: float, fill: tuple[int, int, int, int]) -> None:
        bbox = draw.textbbox((0, 0), text, font=font)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        x = cx - width / 2 - bbox[0]
        y = cy - height / 2 - bbox[1]
        draw.text((x, y + 10), text, font=font, fill=(28, 24, 90, 80))
        draw.text((x, y), text, font=font, fill=fill)

    centered("{", 350, 500, (255, 255, 255, 255))
    centered("}", 674, 500, (255, 255, 255, 255))

    # Three tree/diff nodes.
    colors = [(112, 240, 199, 255), (255, 255, 255, 210), (255, 203, 112, 255)]
    for index, color in enumerate(colors):
        cy = 400 + index * 112
        draw.ellipse((512 - 31, cy - 31, 512 + 31, cy + 31), fill=(24, 20, 80, 70))
        draw.ellipse((512 - 28, cy - 34, 512 + 28, cy + 22), fill=color)

    return image


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    master = build_master()
    master_path = ASSETS / "AppIcon-1024.png"
    master.save(master_path)

    iconset = ASSETS / "AppIcon.iconset"
    iconset.mkdir(exist_ok=True)
    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, px in sizes.items():
        master.resize((px, px), Image.LANCZOS).save(iconset / name)

    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "AppIcon.icns")],
        check=True,
    )
    print(f"Wrote {master_path} and {ASSETS / 'AppIcon.icns'}")


if __name__ == "__main__":
    main()
