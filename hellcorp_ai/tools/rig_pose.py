#!/usr/bin/env python3
"""
Genere une variante de pose d'un personnage deja verrouille, sans repartir
d'un seed independant: ControlNet OpenPose fixe le squelette, IP-Adapter
verrouille visage/tenue sur le master. Le meme mecanisme sert de base au
rigging Skeleton2D cote Godot (le squelette qui pilote ControlNet ici peut
plus tard piloter les boites de decoupe des membres).

Les coordonnees de pose sont ecrites a la main (format OpenPose COCO-18,
normalise 0-1), pas detectees par le reseau CMU: draw_poses() n'est qu'un
utilitaire de dessin, pas le detecteur soumis a la licence non-commerciale
CMU - on ne charge jamais Body()/Hand()/Face().

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_pose.py \
        --id main_01_morrigan --pose idle_front --reference \
        hellcorp_ai/characters/main_01_morrigan/roster/00.png
"""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from diffusers import (
    ControlNetModel,
    StableDiffusionXLControlNetPipeline,
    DPMSolverMultistepScheduler,
)
from controlnet_aux.open_pose import Keypoint, BodyResult, PoseResult, draw_poses
from compel import Compel, ReturnedEmbeddingsType

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / "models" / "waiIllustriousSDXL_v170.safetensors"
CONTROLNET_REPO = "xinsir/controlnet-openpose-sdxl-1.0"
OUT_ROOT = ROOT / "hellcorp_ai" / "characters"

sys_path_fix = str(ROOT / "hellcorp_ai" / "tools")
import sys
if sys_path_fix not in sys.path:
    sys.path.insert(0, sys_path_fix)
from roster_batch_generate import EN_OVERRIDES, STYLE_TAGS, NEGATIVE  # noqa: E402

# Keypoints COCO-18 normalises (0-1), ecrits a la main. Meme convention de
# silhouette que hellcorp_ai/guides/*.png (draw_mannequin) pour rester
# coherent avec les guides deja construits pour la pipeline FLUX.
def kp(x, y):
    return Keypoint(x=x, y=y, score=1.0)

POSES = {
    "idle_front": [
        kp(0.50, 0.12), kp(0.50, 0.17),
        kp(0.44, 0.19), kp(0.42, 0.32), kp(0.41, 0.44),
        kp(0.56, 0.19), kp(0.58, 0.32), kp(0.59, 0.44),
        kp(0.46, 0.48), kp(0.46, 0.68), kp(0.46, 0.88),
        kp(0.54, 0.48), kp(0.54, 0.68), kp(0.54, 0.88),
        kp(0.48, 0.11), kp(0.52, 0.11), kp(0.46, 0.115), kp(0.54, 0.115),
    ],
    "walk_front_a": [
        kp(0.50, 0.12), kp(0.50, 0.17),
        kp(0.44, 0.19), kp(0.39, 0.30), kp(0.37, 0.42),
        kp(0.56, 0.19), kp(0.61, 0.31), kp(0.63, 0.43),
        kp(0.46, 0.48), kp(0.40, 0.68), kp(0.38, 0.88),
        kp(0.54, 0.48), kp(0.58, 0.66), kp(0.60, 0.87),
        kp(0.48, 0.11), kp(0.52, 0.11), kp(0.46, 0.115), kp(0.54, 0.115),
    ],
    "present": [
        kp(0.50, 0.12), kp(0.50, 0.17),
        kp(0.44, 0.19), kp(0.36, 0.27), kp(0.30, 0.22),
        kp(0.56, 0.19), kp(0.58, 0.32), kp(0.59, 0.44),
        kp(0.46, 0.48), kp(0.46, 0.68), kp(0.46, 0.88),
        kp(0.54, 0.48), kp(0.54, 0.68), kp(0.54, 0.88),
        kp(0.48, 0.11), kp(0.52, 0.11), kp(0.46, 0.115), kp(0.54, 0.115),
    ],
    "sit": [
        kp(0.50, 0.14), kp(0.50, 0.19),
        kp(0.44, 0.21), kp(0.42, 0.34), kp(0.41, 0.46),
        kp(0.56, 0.21), kp(0.58, 0.34), kp(0.59, 0.46),
        kp(0.46, 0.50), kp(0.60, 0.52), kp(0.60, 0.72),
        kp(0.54, 0.50), kp(0.40, 0.52), kp(0.40, 0.72),
        kp(0.48, 0.13), kp(0.52, 0.13), kp(0.46, 0.135), kp(0.54, 0.135),
    ],
}

WIDTH, HEIGHT = 768, 1344
STEPS = 32
CFG_SCALE = 6.5
CONTROLNET_SCALE = 0.85
IP_ADAPTER_SCALE = 0.55


def make_skeleton_image(pose_name: str) -> Image.Image:
    keypoints = POSES[pose_name]
    body = BodyResult(keypoints=keypoints, total_score=len(keypoints), total_parts=len(keypoints))
    pose = PoseResult(body=body, left_hand=None, right_hand=None, face=None)
    canvas = draw_poses([pose], HEIGHT, WIDTH, draw_body=True, draw_hand=False, draw_face=False)
    return Image.fromarray(canvas)


def load_pipe():
    controlnet = ControlNetModel.from_pretrained(CONTROLNET_REPO, torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetPipeline.from_single_file(
        str(CKPT), controlnet=controlnet, torch_dtype=torch.float16, use_safetensors=True
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type="dpmsolver++", use_karras_sigmas=True
    )
    pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.bin")
    pipe.set_ip_adapter_scale(IP_ADAPTER_SCALE)
    pipe.to("mps")
    return pipe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--pose", required=True, choices=list(POSES.keys()))
    ap.add_argument("--reference", required=True, help="Master/roster image a garder comme identite")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    roster = json.loads((ROOT / "hellcorp_ai" / "inspiration" / "hellcorp_girls_roster.json").read_text())["girls"]
    girl = next(g for g in roster if g["id"] == args.id)
    en = EN_OVERRIDES[args.id]

    skeleton = make_skeleton_image(args.pose)
    out_dir = OUT_ROOT / args.id / "poses"
    out_dir.mkdir(parents=True, exist_ok=True)
    skeleton.save(out_dir / f"{args.pose}_skeleton.png")

    reference_image = Image.open(args.reference).convert("RGB")

    pipe = load_pipe()
    compel = Compel(
        tokenizer=[pipe.tokenizer, pipe.tokenizer_2],
        text_encoder=[pipe.text_encoder, pipe.text_encoder_2],
        returned_embeddings_type=ReturnedEmbeddingsType.PENULTIMATE_HIDDEN_STATES_NON_NORMALIZED,
        requires_pooled=[False, True],
    )
    bits = [en["espece"]]
    if en.get("corne"):
        bits.append(en["corne"])
    bits += [b for b in [en["cheveux"], en["yeux"], en["gabarit"], en["peau"], en["bureau"]] if b]
    prompt = STYLE_TAGS + ", " + girl["nom"] + ", " + ", ".join(bits)

    cond, pooled = compel(prompt)
    neg_cond, neg_pooled = compel(NEGATIVE)
    cond, neg_cond = compel.pad_conditioning_tensors_to_same_length([cond, neg_cond])

    seed = args.seed if args.seed is not None else int(hash(args.id + args.pose) % 900000) + 100000
    generator = torch.Generator(device="cpu").manual_seed(seed)

    with torch.inference_mode():
        image = pipe(
            prompt_embeds=cond, pooled_prompt_embeds=pooled,
            negative_prompt_embeds=neg_cond, negative_pooled_prompt_embeds=neg_pooled,
            image=skeleton, controlnet_conditioning_scale=CONTROLNET_SCALE,
            ip_adapter_image=reference_image,
            width=WIDTH, height=HEIGHT, num_inference_steps=STEPS, guidance_scale=CFG_SCALE,
            generator=generator,
        ).images[0]

    out_path = out_dir / f"{args.pose}.png"
    image.save(out_path)
    print(f"-> {out_path}")


if __name__ == "__main__":
    main()
