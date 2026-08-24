#!/usr/bin/env python3
"""Test SAM sur le master rig final, avec les VRAIES coordonnees de la pose
en A utilisee pour cette image (pas idle_front)."""

from pathlib import Path

import numpy as np
from PIL import Image
from controlnet_aux.segment_anything.predictor import SamPredictor
from controlnet_aux.segment_anything.build_sam import sam_model_registry

ROOT = Path(__file__).resolve().parents[2]
IMAGE_PATH = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan" / "master_rig_final2.png"
SAM_CKPT = ROOT / "hellcorp_ai" / "models" / "sam" / "sam_vit_h_4b8939.pth"
OUT_DIR = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan" / "rig_parts_test2"

# Memes coordonnees normalisees que la generation du master_rig_reference2.png
RIG_POSE = [
    (0.50, 0.12), (0.50, 0.17),
    (0.40, 0.19), (0.24, 0.24), (0.10, 0.28),
    (0.60, 0.19), (0.76, 0.24), (0.90, 0.28),
    (0.46, 0.48), (0.44, 0.68), (0.42, 0.88),
    (0.54, 0.48), (0.56, 0.68), (0.58, 0.88),
    (0.48, 0.11), (0.52, 0.11), (0.46, 0.115), (0.54, 0.115),
]


def mid(a, b, w, h):
    xa, ya = RIG_POSE[a]
    xb, yb = RIG_POSE[b]
    return (int((xa + xb) / 2 * w), int((ya + yb) / 2 * h))


def main():
    image = Image.open(IMAGE_PATH).convert("RGB")
    w, h = image.size
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    parts = {
        "head": mid(0, 1, w, h),
        "torso": mid(1, 8, w, h),
        "upper_arm_R": mid(2, 3, w, h),
        "forearm_R": mid(3, 4, w, h),
        "upper_arm_L": mid(5, 6, w, h),
        "forearm_L": mid(6, 7, w, h),
        "thigh_R": mid(8, 9, w, h),
        "shin_R": mid(9, 10, w, h),
        "thigh_L": mid(11, 12, w, h),
        "shin_L": mid(12, 13, w, h),
    }

    print("Chargement SAM ViT-H...")
    sam = sam_model_registry["vit_h"](checkpoint=str(SAM_CKPT))
    sam.to("cpu")
    predictor = SamPredictor(sam)
    predictor.set_image(np.array(image))

    overlay = np.array(image).copy()
    rng = np.random.default_rng(1)

    for name, (x, y) in parts.items():
        masks, scores, _ = predictor.predict(
            point_coords=np.array([[x, y]]),
            point_labels=np.array([1]),
            multimask_output=True,
        )
        best = masks[int(np.argmax(scores))]
        Image.fromarray((best * 255).astype(np.uint8)).save(OUT_DIR / f"{name}_mask.png")

        color = rng.integers(60, 255, size=3)
        overlay[best] = (overlay[best] * 0.4 + color * 0.6).astype(np.uint8)
        print(f"{name}: point=({x},{y}) score={scores.max():.3f} area={int(best.sum())}")

    Image.fromarray(overlay).save(OUT_DIR / "_overlay_all_parts.png")
    print(f"-> {OUT_DIR}")


if __name__ == "__main__":
    main()
