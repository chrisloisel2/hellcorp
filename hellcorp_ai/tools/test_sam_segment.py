#!/usr/bin/env python3
"""
Test: SAM peut-il decouper un master en morceaux rigables (torse, bras,
avant-bras, cuisse, tibia) a partir de points places aux memes coordonnees
que le squelette OpenPose deja utilise pour ControlNet? Un seul schema de
coordonnees, deux usages (piloter la pose, et maintenant segmenter les
membres pour le rig).
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hellcorp_ai" / "tools"))
from rig_pose import POSES  # noqa: E402

from controlnet_aux.segment_anything.predictor import SamPredictor
from controlnet_aux.segment_anything.build_sam import sam_model_registry

IMAGE_PATH = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan" / "master_riggable_test3.png"
SAM_CKPT = ROOT / "hellcorp_ai" / "models" / "sam" / "sam_vit_h_4b8939.pth"
OUT_DIR = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan" / "rig_parts_test"

idle = {i: k for i, k in enumerate(POSES["idle_front"])}


def mid(a, b, w, h):
    ka, kb = idle[a], idle[b]
    return (int((ka.x + kb.x) / 2 * w), int((ka.y + kb.y) / 2 * h))


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
    sam.to("cpu")  # MPS pas supporte par ce build de segment_anything, cpu pour un test
    predictor = SamPredictor(sam)
    predictor.set_image(np.array(image))

    overlay = np.array(image).copy()
    rng = np.random.default_rng(0)

    for name, (x, y) in parts.items():
        masks, scores, _ = predictor.predict(
            point_coords=np.array([[x, y]]),
            point_labels=np.array([1]),
            multimask_output=True,
        )
        best = masks[int(np.argmax(scores))]
        Image.fromarray((best * 255).astype(np.uint8)).save(OUT_DIR / f"{name}_mask.png")

        cut = np.array(image).copy()
        alpha = (best * 255).astype(np.uint8)
        rgba = np.dstack([cut, alpha])
        Image.fromarray(rgba, mode="RGBA").save(OUT_DIR / f"{name}_cutout.png")

        color = rng.integers(60, 255, size=3)
        overlay[best] = (overlay[best] * 0.4 + color * 0.6).astype(np.uint8)
        print(f"{name}: point=({x},{y}) score={scores.max():.3f} area={int(best.sum())}")

    Image.fromarray(overlay).save(OUT_DIR / "_overlay_all_parts.png")
    print(f"-> {OUT_DIR}")


if __name__ == "__main__":
    main()
