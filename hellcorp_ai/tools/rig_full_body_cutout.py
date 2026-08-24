#!/usr/bin/env python3
"""
Detourage corps entier propre via SAM (deja utilise dans ce repo pour les
masques par partie, test_sam_segment2.py), avec un prompt boite englobant
tout le personnage plutot que des points par morceau: un seul masque
coherent, pas de risque de trous entre morceaux adjacents.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_full_body_cutout.py
"""
from pathlib import Path

import numpy as np
from PIL import Image
from controlnet_aux.segment_anything.predictor import SamPredictor
from controlnet_aux.segment_anything.build_sam import sam_model_registry

ROOT = Path(__file__).resolve().parents[2]
CHAR_DIR = ROOT / "hellcorp_ai" / "characters" / "main_01_morrigan"
SRC = CHAR_DIR / "rig_nude_reference.png"
SAM_CKPT = ROOT / "hellcorp_ai" / "models" / "sam" / "sam_vit_h_4b8939.pth"
OUT = ROOT / "hellcorp_ai" / "godot_rig_test" / "clean_full_body.png"

# Boite englobant tout le personnage (T-pose, bras ecartes) sur le canvas
# 768x1344, marge de securite pour ne pas rogner mains/pieds.
BOX = (10, 130, 758, 1310)

# Points de renfort positifs: le box seul laisse tomber la majeure partie
# des cheveux (fines meches, couleur proche du fond marron) ainsi que
# cornes/ailes. On les pointe explicitement pour qu'ils rejoignent le
# meme masque coherent plutot que de faire un mask separe a unioner.
HAIR_POINTS = [
    (384, 55), (345, 160), (425, 160),
    (295, 420), (475, 420), (270, 620), (500, 620),
    (310, 60), (460, 60), (230, 110), (545, 110),
]


def main():
    image = Image.open(SRC).convert("RGB")
    arr = np.array(image)

    print("Chargement SAM ViT-H...")
    sam = sam_model_registry["vit_h"](checkpoint=str(SAM_CKPT))
    sam.to("cpu")
    predictor = SamPredictor(sam)
    predictor.set_image(arr)

    masks, scores, _ = predictor.predict(
        box=np.array(BOX),
        point_coords=np.array(HAIR_POINTS),
        point_labels=np.ones(len(HAIR_POINTS), dtype=int),
        multimask_output=True,
    )
    best = masks[int(np.argmax(scores))]
    print(f"mask score={scores.max():.3f} area={int(best.sum())} / {arr.shape[0]*arr.shape[1]}")

    rgba = np.dstack([arr, (best * 255).astype(np.uint8)])
    Image.fromarray(rgba).save(OUT)
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
