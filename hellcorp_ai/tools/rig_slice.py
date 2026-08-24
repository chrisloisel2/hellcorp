#!/usr/bin/env python3
"""
Decoupe deterministe d'un master en morceaux rigables: pas d'IA, pas de
segmentation "intelligente" - juste un detourage de fond + des coupes
perpendiculaires a chaque os, positionnees exactement aux coordonnees
d'articulation deja connues (les memes que celles envoyees a ControlNet).
Chaque morceau garde un pivot (l'articulation proximale) pour un futur
Skeleton2D/Bone2D dans Godot.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_slice.py \
        --input hellcorp_ai/characters/main_01_morrigan/rig_nude_reference.png \
        --id main_01_morrigan
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT_ROOT = ROOT / "hellcorp_ai" / "characters"

# Memes coordonnees normalisees que master_rig_reference2.png / rig_nude_reference.png
RIG_POSE = [
    (0.50, 0.12), (0.50, 0.17),
    (0.40, 0.19), (0.24, 0.24), (0.10, 0.28),
    (0.60, 0.19), (0.76, 0.24), (0.90, 0.28),
    (0.46, 0.48), (0.44, 0.68), (0.42, 0.88),
    (0.54, 0.48), (0.56, 0.68), (0.58, 0.88),
    (0.48, 0.11), (0.52, 0.11), (0.46, 0.115), (0.54, 0.115),
]

# (joint_proximal, joint_distal, nom, largeur_relative_au_torse, parent)
BONES = [
    (2, 3, "upper_arm_R", 0.42, "torso"),
    (3, 4, "forearm_R", 0.34, "upper_arm_R"),
    (5, 6, "upper_arm_L", 0.42, "torso"),
    (6, 7, "forearm_L", 0.34, "upper_arm_L"),
    (8, 9, "thigh_R", 0.55, "torso"),
    (9, 10, "shin_R", 0.42, "thigh_R"),
    (11, 12, "thigh_L", 0.55, "torso"),
    (12, 13, "shin_L", 0.42, "thigh_L"),
]


def remove_flat_background(im: Image.Image, threshold: int = 36) -> Image.Image:
    im = im.convert("RGBA")
    arr = np.array(im)
    corner = arr[2, 2, :3].astype(int)
    diff = np.abs(arr[:, :, :3].astype(int) - corner).sum(axis=2)
    alpha = np.where(diff < threshold, 0, 255).astype(np.uint8)
    arr[:, :, 3] = alpha
    return Image.fromarray(arr)


def bone_rectangle(p0, p1, width, extend=0.12):
    """Rectangle tourne le long de l'os p0->p1, elargi legerement aux deux
    bouts (extend) pour garantir un recouvrement complet du membre a la
    coupe plutot qu'un bord net qui rate un pixel de silhouette."""
    x0, y0 = p0
    x1, y1 = p1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length  # direction de l'os
    nx, ny = -uy, ux  # normale (perpendiculaire)
    ext = length * extend
    a = (x0 - ux * ext, y0 - uy * ext)
    b = (x1 + ux * ext, y1 + uy * ext)
    half_w = width / 2
    corners = [
        (a[0] + nx * half_w, a[1] + ny * half_w),
        (b[0] + nx * half_w, b[1] + ny * half_w),
        (b[0] - nx * half_w, b[1] - ny * half_w),
        (a[0] - nx * half_w, a[1] - ny * half_w),
    ]
    return corners


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--id", required=True)
    args = ap.parse_args()

    image = Image.open(args.input).convert("RGB")
    w, h = image.size
    cutout = remove_flat_background(image)
    alpha = np.array(cutout)[:, :, 3] > 0

    px = [(x * w, y * h) for x, y in RIG_POSE]
    torso_width_px = abs(px[5][0] - px[2][0])  # distance epaule-epaule

    out_dir = OUT_ROOT / args.id / "rig_parts"
    out_dir.mkdir(parents=True, exist_ok=True)

    debug = image.convert("RGBA").copy()
    draw = ImageDraw.Draw(debug)

    remaining = alpha.copy()
    manifest = {"canvas": [w, h], "parts": {}}

    for a_idx, b_idx, name, width_ratio, parent in BONES:
        p0, p1 = px[a_idx], px[b_idx]
        rect = bone_rectangle(p0, p1, torso_width_px * width_ratio)

        band = Image.new("L", (w, h), 0)
        ImageDraw.Draw(band).polygon(rect, fill=255)
        band_mask = np.array(band) > 0

        part_mask = band_mask & remaining
        remaining &= ~part_mask

        piece = np.array(cutout).copy()
        piece[:, :, 3] = np.where(part_mask, piece[:, :, 3], 0)
        Image.fromarray(piece).save(out_dir / f"{name}.png")

        draw.line([p0, p1], fill=(255, 0, 0, 255), width=3)
        draw.polygon(rect, outline=(0, 255, 255, 255))
        draw.ellipse([p0[0] - 5, p0[1] - 5, p0[0] + 5, p0[1] + 5], fill=(255, 255, 0, 255))

        manifest["parts"][name] = {
            "pivot_px": [round(p0[0], 1), round(p0[1], 1)],
            "pivot_norm": list(RIG_POSE[a_idx]),
            "parent": parent,
            "bbox_px": [round(v, 1) for v in Image.fromarray(piece).getbbox() or (0, 0, 0, 0)],
        }

    # tout ce qui reste (tete + torse) = le morceau racine
    root = np.array(cutout).copy()
    root[:, :, 3] = np.where(remaining, root[:, :, 3], 0)
    Image.fromarray(root).save(out_dir / "head_torso.png")
    manifest["parts"]["head_torso"] = {
        "pivot_px": [round(px[1][0], 1), round(px[1][1], 1)],
        "pivot_norm": list(RIG_POSE[1]),
        "parent": None,
        "bbox_px": [round(v, 1) for v in Image.fromarray(root).getbbox() or (0, 0, 0, 0)],
    }

    (out_dir / "rig_manifest.json").write_text(json.dumps(manifest, indent=2))
    debug.save(out_dir / "_cut_lines_debug.png")
    cutout.save(out_dir / "_cutout_alpha.png")
    print(f"-> {out_dir}")


if __name__ == "__main__":
    main()
