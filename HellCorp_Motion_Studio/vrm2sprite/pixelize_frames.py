#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from pathlib import Path

import imageio.v2 as imageio
import numpy as np
from PIL import Image


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_rgba(img: Image.Image) -> Image.Image:
    return img.convert("RGBA")


def trim_alpha(img: Image.Image):
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return img, (0, 0, img.width, img.height)
    return img.crop(bbox), bbox


def fit_center(img: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - img.width) // 2
    y = (size - img.height) // 2
    canvas.alpha_composite(img, (x, y))
    return canvas


def get_palette_from_reference(reference_path: Path, colors: int):
    ref = Image.open(reference_path).convert("RGBA")
    ref_rgb = Image.new("RGB", ref.size, (0, 0, 0))
    ref_rgb.paste(ref, mask=ref.getchannel("A"))
    pal = ref_rgb.convert("P", palette=Image.Palette.ADAPTIVE, colors=colors)
    return pal


def quantize_to_reference_palette(img: Image.Image, palette_img: Image.Image) -> Image.Image:
    rgb = Image.new("RGB", img.size, (0, 0, 0))
    rgb.paste(img, mask=img.getchannel("A"))
    q = rgb.quantize(palette=palette_img)
    q = q.convert("RGBA")
    alpha = img.getchannel("A")
    q.putalpha(alpha)
    return q


def normalize_frame(frame_path: Path, out_size: int, palette_img: Image.Image, scale: float) -> Image.Image:
    src = ensure_rgba(Image.open(frame_path))
    cropped, _ = trim_alpha(src)
    target_h = max(1, int(out_size * scale))
    ratio = target_h / max(1, cropped.height)
    target_w = max(1, int(cropped.width * ratio))
    resized = cropped.resize((target_w, target_h), resample=Image.Resampling.LANCZOS)
    canvas = fit_center(resized, out_size)
    quant = quantize_to_reference_palette(canvas, palette_img)
    return quant


def make_atlas(images, cols):
    if not images:
        raise ValueError("No images for atlas")
    w, h = images[0].size
    rows = math.ceil(len(images) / cols)
    atlas = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, im in enumerate(images):
        x = (i % cols) * w
        y = (i // cols) * h
        atlas.alpha_composite(im, (x, y))
    return atlas


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--frames", required=True)
    p.add_argument("--reference", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=384)
    p.add_argument("--cols", type=int, default=4)
    p.add_argument("--fps", type=int, default=16)
    p.add_argument("--palette-colors", type=int, default=96)
    p.add_argument("--scale", type=float, default=0.90)
    args = p.parse_args()

    frames_dir = Path(args.frames)
    reference = Path(args.reference)
    out_dir = Path(args.out)
    frames_out = out_dir / "frames"
    frames_out.mkdir(parents=True, exist_ok=True)

    frame_paths = sorted(frames_dir.glob("frame_*.png"))
    if not frame_paths:
        raise SystemExit("No input frames found")

    palette_img = get_palette_from_reference(reference, args.palette_colors)

    processed = []
    manifest_frames = []
    for i, frame_path in enumerate(frame_paths):
        im = normalize_frame(frame_path, args.size, palette_img, args.scale)
        dst = frames_out / f"frame_{i:06d}.png"
        im.save(dst)
        processed.append(im)
        manifest_frames.append({
            "index": i,
            "path": f"frames/{dst.name}",
            "sha256": sha256_file(dst),
            "size": [im.width, im.height],
        })

    atlas = make_atlas(processed, args.cols)
    atlas_path = out_dir / "atlas.png"
    atlas.save(atlas_path)

    atlas_json = {
        "frame_width": args.size,
        "frame_height": args.size,
        "cols": args.cols,
        "count": len(processed),
        "atlas": "atlas.png",
        "frames": [
            {
                "index": i,
                "x": (i % args.cols) * args.size,
                "y": (i // args.cols) * args.size,
                "w": args.size,
                "h": args.size,
            }
            for i in range(len(processed))
        ]
    }
    with open(out_dir / "atlas.json", "w", encoding="utf-8") as f:
        json.dump(atlas_json, f, indent=2)

    gif_path = out_dir / "preview.gif"
    gif_frames = [np.array(im) for im in processed]
    imageio.mimsave(gif_path, gif_frames, duration=1.0 / args.fps, loop=0, disposal=2)

    manifest = {
        "format": "HellCorpVrm2SpriteV1",
        "reference": str(reference),
        "input_frames_dir": str(frames_dir),
        "output_dir": str(out_dir),
        "frame_count": len(processed),
        "frame_size": [args.size, args.size],
        "fps": args.fps,
        "palette_colors": args.palette_colors,
        "atlas": {
            "path": "atlas.png",
            "sha256": sha256_file(atlas_path),
            "cols": args.cols,
        },
        "gif": {
            "path": "preview.gif",
            "sha256": sha256_file(gif_path),
        },
        "frames": manifest_frames,
    }
    with open(out_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("VRM2SPRITE_PASS")
    print(f"Output: {out_dir}")


if __name__ == "__main__":
    main()
