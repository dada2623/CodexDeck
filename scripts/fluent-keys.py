#!/usr/bin/env python3
"""Regenerate assets/fluent-keys/ from the raw Fluent icons in fluent-candidates/.

Composites each white-on-transparent Fluent glyph onto a pure black key
background (#000000, matching the official Codex Micro key look) at 144/288 px
and writes 20/40 px transparent palette icons, then updates the plugin bundle
via `npm run icons` (see scripts/make-icons.mjs).
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = {
    "accept": "accept_checkmark_circle.png",
    "reject": "reject_dismiss_circle.png",
    "send": "send.png",
    "newchat": "newchat_chat_multiple.png",
    "reasoning": "reasoning_brain_circuit.png",
    "ptt": "ptt_mic_on.png",
    "chevronLeft": "prev_arrow_left.png",
    "chevronRight": "next_arrow_right.png",
}
BG = (0, 0, 0)  # pure black, matches the official Codex Micro key look
OUT = ROOT / "assets" / "fluent-keys"


def composite(src: Path, size: int) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    if im.size != (size, size):
        resample = Image.LANCZOS if size < im.size[0] else Image.NEAREST
        im = im.resize((size, size), resample)
    bg = Image.new("RGBA", (size, size), BG + (255,))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def main() -> None:
    for name, file in SRC.items():
        dst = OUT / name
        dst.mkdir(parents=True, exist_ok=True)
        src = ROOT / "fluent-candidates" / file
        for size, suffix in [(144, ""), (288, "@2x")]:
            composite(src, size).save(dst / f"key{suffix}.png")
        im = Image.open(src).convert("RGBA")
        for size, suffix in [(20, ""), (40, "@2x")]:
            im.resize((size, size), Image.LANCZOS).save(dst / f"icon{suffix}.png")
        print(f"fluent-keys/{name}: OK")


if __name__ == "__main__":
    main()
