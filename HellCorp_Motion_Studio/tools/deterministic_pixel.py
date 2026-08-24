#!/usr/bin/env python3
"""Deterministic sprite post-processing for HellCorp Motion Studio.

No diffusion, no LoRA, no frame-wise stochastic generation. For the same input
PNG sequence and parameters this script returns byte-stable visual decisions
apart from PNG encoder metadata.

Pipeline:
  RGBA source -> optional downscale -> fixed palette quantization -> alpha
  cleanup -> isolated-pixel cleanup -> nearest-neighbor upscale.

Usage:
  python3 tools/deterministic_pixel.py --in path/to/frames --out path/to/pixel_frames \
      --logical-size 128 --output-size 512 --colors 32
"""
from __future__ import annotations

import argparse
from pathlib import Path
from PIL import Image, ImageFilter


def stable_palette(images: list[Image.Image], colors: int) -> Image.Image:
    """Build one palette for the entire sequence, not one palette per frame."""
    if not images:
        raise ValueError("empty image sequence")
    sample_w = max(im.width for im in images)
    sample_h = max(im.height for im in images)
    thumb = 96
    tiles = []
    for im in images:
        rgb = Image.new("RGB", im.size)
        rgb.paste(im.convert("RGB"), mask=im.getchannel("A"))
        rgb.thumbnail((thumb, thumb), Image.Resampling.LANCZOS)
        tiles.append(rgb)
    width = max(t.width for t in tiles)
    height = sum(t.height for t in tiles)
    sheet = Image.new("RGB", (width, height), (0, 0, 0))
    y = 0
    for tile in tiles:
        sheet.paste(tile, (0, y))
        y += tile.height
    return sheet.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


def remove_isolated_pixels(im: Image.Image) -> Image.Image:
    """Conservative 3x3 cleanup on opaque RGB while preserving silhouettes."""
    rgba = im.convert("RGBA")
    px = rgba.load()
    src = rgba.copy().load()
    w, h = rgba.size
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if src[x, y][3] < 8:
                continue
            center = src[x, y][:3]
            neighbors = [
                src[x - 1, y][:3], src[x + 1, y][:3], src[x, y - 1][:3], src[x, y + 1][:3]
            ]
            same = sum(1 for c in neighbors if c == center)
            if same == 0:
                counts = {}
                for c in neighbors:
                    counts[c] = counts.get(c, 0) + 1
                best, n = max(counts.items(), key=lambda kv: kv[1])
                if n >= 3:
                    px[x, y] = (*best, src[x, y][3])
    return rgba


def process(im: Image.Image, palette: Image.Image, logical_size: int, output_size: int) -> Image.Image:
    rgba = im.convert("RGBA")
    bbox = rgba.getbbox()
    if bbox is None:
        return Image.new("RGBA", (output_size, output_size), (0, 0, 0, 0))

    low = rgba.resize((logical_size, logical_size), Image.Resampling.LANCZOS)
    alpha = low.getchannel("A")
    # Harden only the alpha fringe. This avoids semi-transparent crawling edges.
    alpha = alpha.point(lambda a: 0 if a < 48 else (255 if a > 208 else a))

    rgb = Image.new("RGB", low.size, (0, 0, 0))
    rgb.paste(low.convert("RGB"), mask=alpha)
    q = rgb.quantize(palette=palette, dither=Image.Dither.NONE).convert("RGB")
    out = q.convert("RGBA")
    out.putalpha(alpha)
    out = remove_isolated_pixels(out)
    if output_size != logical_size:
        out = out.resize((output_size, output_size), Image.Resampling.NEAREST)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input_dir", required=True)
    ap.add_argument("--out", dest="output_dir", required=True)
    ap.add_argument("--logical-size", type=int, default=128)
    ap.add_argument("--output-size", type=int, default=512)
    ap.add_argument("--colors", type=int, default=32)
    args = ap.parse_args()

    src = Path(args.input_dir)
    dst = Path(args.output_dir)
    paths = sorted(src.glob("*.png"))
    if not paths:
        raise SystemExit(f"No PNG frames found in {src}")
    dst.mkdir(parents=True, exist_ok=True)

    originals = [Image.open(p).convert("RGBA") for p in paths]
    palette = stable_palette(originals, max(8, min(args.colors, 256)))
    for path, im in zip(paths, originals):
        out = process(im, palette, args.logical_size, args.output_size)
        out.save(dst / path.name, optimize=False)
    print(f"Processed {len(paths)} frames -> {dst}")


if __name__ == "__main__":
    main()
