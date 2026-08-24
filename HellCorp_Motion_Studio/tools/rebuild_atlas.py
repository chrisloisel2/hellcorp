#!/usr/bin/env python3
"""Reconstruit un atlas 8x8 + manifest HellCorpAtlasV1 a partir d'un dossier de
frames PNG (ex: apres passage par enhance_frames.py, qui change la resolution
des frames sans toucher a l'atlas d'origine). Format identique a celui ecrit
par app.js pour rester compatible avec godot_atlas_loader.gd.

Usage:
  python3 rebuild_atlas.py --frames <dossier_frames> --out <dossier_sortie> \
      --view front --fps 10
"""
import argparse
import json
from pathlib import Path

from PIL import Image

GRID = 8


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--view", required=True)
    ap.add_argument("--fps", type=float, required=True)
    args = ap.parse_args()

    frames_dir = Path(args.frames)
    out_dir = Path(args.out)
    atlas_dir = out_dir / "atlases"
    atlas_dir.mkdir(parents=True, exist_ok=True)

    frame_paths = sorted(frames_dir.glob("frame_*.png"))
    if not frame_paths:
        raise SystemExit(f"Aucune frame dans {frames_dir}")

    with Image.open(frame_paths[0]) as im:
        size = im.size[0]

    pages = []
    frame_entries = []
    per_page = GRID * GRID
    for start in range(0, len(frame_paths), per_page):
        chunk = frame_paths[start:start + per_page]
        page_index = start // per_page
        atlas = Image.new("RGBA", (size * GRID, size * GRID), (0, 0, 0, 0))
        for idx, fp in enumerate(chunk):
            frame_index = start + idx
            col = idx % GRID
            row = idx // GRID
            with Image.open(fp) as im:
                atlas.paste(im, (col * size, row * size))
            frame_entries.append({
                "frame": frame_index,
                "time": round(frame_index / args.fps, 6),
                "page": page_index,
                "x": col * size,
                "y": row * size,
                "w": size,
                "h": size,
            })
        atlas_name = f"atlas_{page_index:03d}.png"
        atlas.save(atlas_dir / atlas_name)
        pages.append({"page": page_index, "file": f"atlases/{atlas_name}"})

    manifest = {
        "format": "HellCorpAtlasV1",
        "view": args.view,
        "fps": args.fps,
        "frame_count": len(frame_paths),
        "frame_size": [size, size],
        "grid": [GRID, GRID],
        "pages": pages,
        "frames": frame_entries,
    }
    (out_dir / "atlas_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"{args.view}: {len(frame_paths)} frames -> {len(pages)} page(s) atlas, taille {size}px")


if __name__ == "__main__":
    main()
