#!/usr/bin/env python3
"""
Assemble les 8 frames capturees par Godot (walk.gd) en: un GIF anime en
boucle, une planche contact (sprite sheet, 1 ligne) et un MP4 (ffmpeg).
Cadrage fixe (bbox union de toutes les frames) pour eviter les sauts d'une
frame a l'autre.
"""
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
GODOT_DIR = ROOT / "hellcorp_ai" / "godot_rig_test"
OUT_DIR = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan" / "walk_cycle_test"

BG = (77, 77, 77)  # clear color par defaut de la fenetre Godot (0x4d4d4d)
BG_TOL = 6


def main():
    frames = sorted(GODOT_DIR.glob("frame_*.png"))
    assert frames, "aucune frame trouvee, relancer walk.gd d'abord"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    imgs = [Image.open(f).convert("RGB") for f in frames]
    arrs = [np.array(im) for im in imgs]

    union_mask = np.zeros(arrs[0].shape[:2], dtype=bool)
    for arr in arrs:
        diff = np.abs(arr.astype(int) - np.array(BG)).sum(axis=2)
        union_mask |= diff > BG_TOL

    ys, xs = np.where(union_mask)
    pad = 12
    x0, x1 = max(0, xs.min() - pad), min(arrs[0].shape[1], xs.max() + pad)
    y0, y1 = max(0, ys.min() - pad), min(arrs[0].shape[0], ys.max() + pad)
    print(f"crop box: ({x0},{y0})-({x1},{y1})")

    cropped = [im.crop((x0, y0, x1, y1)) for im in imgs]

    target_h = 480
    scale = target_h / cropped[0].height
    target_w = int(cropped[0].width * scale)
    resized = [im.resize((target_w, target_h), Image.LANCZOS) for im in cropped]

    for i, im in enumerate(resized):
        im.save(OUT_DIR / f"frame_{i:02d}.png")

    loop = resized + resized[-2:0:-1]  # aller-retour pour une boucle sans a-coup
    gif_path = OUT_DIR / "walk_cycle.gif"
    loop[0].save(
        gif_path, save_all=True, append_images=loop[1:],
        duration=90, loop=0, disposal=2,
    )
    print(f"-> {gif_path}")

    sheet_w = target_w * len(resized)
    sheet = Image.new("RGB", (sheet_w, target_h), (30, 30, 30))
    for i, im in enumerate(resized):
        sheet.paste(im, (i * target_w, 0))
    sheet_path = OUT_DIR / "walk_cycle_sheet.png"
    sheet.save(sheet_path)
    print(f"-> {sheet_path}")

    mp4_path = OUT_DIR / "walk_cycle.mp4"
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-framerate", "11",
                "-i", str(OUT_DIR / "frame_%02d.png"),
                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-pix_fmt", "yuv420p", str(mp4_path),
            ],
            check=True, capture_output=True,
        )
        print(f"-> {mp4_path}")
    except Exception as e:
        print(f"ffmpeg skipped: {e}")


if __name__ == "__main__":
    main()
