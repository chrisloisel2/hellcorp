#!/usr/bin/env python3
"""
Test de deformation mesh (Spine/Godot-like) vs cutout rigide (methode
actuelle rig_slice.py), sur le bras droit de Morrigan.

Compare deux methodes de rendu d'un coude qui se plie, a partir de la MEME
image source deja detouree par rig_slice.py (rig_parts/_cutout_alpha.png,
memes pivots) :

  - rigid : reutilise directement rig_parts/upper_arm_R.png + forearm_R.png
    (production actuelle) et fait pivoter le morceau forearm autour du
    pivot du coude comme un objet rigide -> seam/gap visible au coude des
    que l'angle depasse quelques degres.
  - mesh  : grille de vertices ponderee (linear blend skinning : chaque
    vertex est influence par upper_arm ET forearm avec un poids qui varie
    en douceur autour du coude, exactement ce que fait Polygon2D+Skeleton2D
    dans Godot ou un mesh Spine) -> deformation continue de l'illustration,
    pas de morceaux separes.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_mesh_test.py \
        --bend-deg 75
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from skimage.transform import PiecewiseAffineTransform, warp

ROOT = Path(__file__).resolve().parents[2]
CHAR_DIR = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan"
RIG_PARTS = CHAR_DIR / "rig_parts"
OUT_DIR = CHAR_DIR / "rig_mesh_test"

# Memes pivots que rig_manifest.json (produits par rig_slice.py depuis
# rig_nude_reference.png, canvas 768x1344).
SHOULDER = (307.2, 255.4)
ELBOW = (184.3, 322.6)
WRIST = (76.8, 376.3)

GRID_COLS, GRID_ROWS = 24, 10
WEIGHT_FALLOFF_PX = 55  # largeur de la zone de blend autour du coude


def rotate_point(p, center, deg):
    a = math.radians(deg)
    dx, dy = p[0] - center[0], p[1] - center[1]
    ca, sa = math.cos(a), math.sin(a)
    return (center[0] + dx * ca - dy * sa, center[1] + dx * sa + dy * ca)


def bone_weight_upper(vertex_orig):
    """Poids du bone upper_arm (0..1) pour un vertex en coordonnees image
    d'origine, avec falloff smoothstep centre sur le coude le long de l'axe
    de l'os shoulder->elbow (linear blend skinning a 2 bones)."""
    ax, ay = SHOULDER[0] - ELBOW[0], SHOULDER[1] - ELBOW[1]
    bone_len = math.hypot(ax, ay)
    ux, uy = ax / bone_len, ay / bone_len
    vx, vy = vertex_orig[0] - ELBOW[0], vertex_orig[1] - ELBOW[1]
    signed_dist = vx * ux + vy * uy  # >0 cote shoulder, <0 cote wrist
    t = np.clip((signed_dist + WEIGHT_FALLOFF_PX) / (2 * WEIGHT_FALLOFF_PX), 0.0, 1.0)
    return float(t * t * (3 - 2 * t))  # smoothstep


def build_grid(x0, y0, x1, y1, cols, rows):
    xs = np.linspace(x0, x1, cols)
    ys = np.linspace(y0, y1, rows)
    return np.array([[x, y] for y in ys for x in xs])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bend-deg", type=float, default=75.0,
                     help="Angle de flexion du coude (biceps curl)")
    args = ap.parse_args()
    bend = args.bend_deg

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    cutout = Image.open(RIG_PARTS / "_cutout_alpha.png").convert("RGBA")

    pad = 150
    crop_box = (
        int(WRIST[0]) - pad, int(SHOULDER[1]) - pad,
        int(SHOULDER[0]) + pad, int(WRIST[1]) + pad,
    )
    canvas_w = crop_box[2] - crop_box[0]
    canvas_h = crop_box[3] - crop_box[1]
    ox, oy = -crop_box[0], -crop_box[1]

    def to_ws(p):
        return (p[0] + ox, p[1] + oy)

    shoulder_w, elbow_w, wrist_w = to_ws(SHOULDER), to_ws(ELBOW), to_ws(WRIST)

    arm_crop = cutout.crop(crop_box)
    src_arr = np.array(arm_crop).astype(np.float64) / 255.0

    # ---------------------------------------------------------------
    # MESH : grille ponderee (linear blend skinning, style Godot/Spine)
    # ---------------------------------------------------------------
    grid = build_grid(0, shoulder_w[1] - 90, canvas_w, wrist_w[1] + 90, GRID_COLS, GRID_ROWS)
    weights = np.array([bone_weight_upper((gx - ox, gy - oy)) for gx, gy in grid])

    deformed = np.empty_like(grid)
    for i, ((gx, gy), w) in enumerate(zip(grid, weights)):
        pos_upper = (gx, gy)  # bone upper_arm : pivot shoulder fixe, ne bouge pas
        pos_forearm = rotate_point((gx, gy), elbow_w, bend)  # bone forearm : rotation autour du coude
        deformed[i] = (w * pos_upper[0] + (1 - w) * pos_forearm[0],
                       w * pos_upper[1] + (1 - w) * pos_forearm[1])

    tform = PiecewiseAffineTransform()
    tform.estimate(deformed, grid)  # inverse map: pixel deforme -> pixel source
    out_mesh = warp(src_arr, tform, output_shape=(canvas_h, canvas_w), order=1)
    out_mesh_img = Image.fromarray((np.clip(out_mesh, 0, 1) * 255).astype(np.uint8), mode="RGBA")
    out_mesh_img.save(OUT_DIR / "mesh_after_deformed.png")

    # debug: grille + poids colorimetrique (bleu=upper_arm, rouge=forearm)
    debug = arm_crop.convert("RGBA").copy()
    draw = ImageDraw.Draw(debug)
    for (gx, gy), w in zip(grid, weights):
        color = (int(255 * (1 - w)), 40, int(255 * w), 255)
        draw.ellipse([gx - 3, gy - 3, gx + 3, gy + 3], fill=color)
    draw.line([shoulder_w, elbow_w, wrist_w], fill=(0, 255, 0, 255), width=2)
    debug.save(OUT_DIR / "_debug_weight_grid.png")

    # ---------------------------------------------------------------
    # RIGID : pipeline actuelle rig_slice.py (deux morceaux, rotation rigide)
    # ---------------------------------------------------------------
    upper_full = Image.open(RIG_PARTS / "upper_arm_R.png").convert("RGBA")
    forearm_full = Image.open(RIG_PARTS / "forearm_R.png").convert("RGBA")
    forearm_rot = forearm_full.rotate(-bend, center=ELBOW, resample=Image.BICUBIC)

    rigid_full = Image.new("RGBA", upper_full.size, (0, 0, 0, 0))
    rigid_full.alpha_composite(upper_full)
    rigid_full.alpha_composite(forearm_rot)
    rigid_full.crop(crop_box).save(OUT_DIR / "rigid_after_deformed.png")

    manifest = {
        "bend_deg": bend,
        "pivots_px": {"shoulder": SHOULDER, "elbow": ELBOW, "wrist": WRIST},
        "grid": {"cols": GRID_COLS, "rows": GRID_ROWS, "weight_falloff_px": WEIGHT_FALLOFF_PX},
        "crop_box_px": list(crop_box),
        "outputs": {
            "mesh": "mesh_after_deformed.png",
            "rigid": "rigid_after_deformed.png",
            "debug_grid": "_debug_weight_grid.png",
        },
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"-> {OUT_DIR}")


if __name__ == "__main__":
    main()
