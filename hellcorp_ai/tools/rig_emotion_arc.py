#!/usr/bin/env python3
"""
Une emotion = une trajectoire coherente de squelette + visage sur ~10 etapes
d'intensite (0 = neutre, 9 = pleinement exprimee), pas une pose et une
expression choisies independamment. Chaque etape combine :
  - un squelette interpole entre la pose neutre (idle_front) et une pose
    "pic" propre a l'emotion (ControlNet OpenPose + IP-Adapter sur le master)
  - une expression graduee dans une liste ordonnee par intensite pour cette
    emotion (inpainting local du visage + recomposition finale)

Deux phases pour rester efficace en memoire: on charge le pipeline
ControlNet une fois et on genere les 10 squelettes-corps, puis on charge le
pipeline d'inpainting une fois et on applique les 10 expressions par-dessus.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_emotion_arc.py \
        --id main_01_morrigan --emotion anger \
        --reference hellcorp_ai/characters/main_01_morrigan/roster/00.png
"""

import argparse
import json
import sys
from pathlib import Path

import torch
from PIL import Image, ImageFilter, ImageDraw
from diffusers import (
    ControlNetModel,
    StableDiffusionXLControlNetPipeline,
    StableDiffusionXLInpaintPipeline,
    DPMSolverMultistepScheduler,
)
from controlnet_aux.open_pose import Keypoint, BodyResult, PoseResult, draw_poses
from compel import Compel, ReturnedEmbeddingsType

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / "models" / "waiIllustriousSDXL_v170.safetensors"
CONTROLNET_REPO = "xinsir/controlnet-openpose-sdxl-1.0"
OUT_ROOT = ROOT / "hellcorp_ai" / "characters"

TOOLS_DIR = str(Path(__file__).resolve().parent)
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)
from roster_batch_generate import EN_OVERRIDES, STYLE_TAGS, NEGATIVE  # noqa: E402
from rig_pose import POSES as BASE_POSES  # noqa: E402

WIDTH, HEIGHT = 768, 1344
N_STEPS_ARC = 10
POSE_STEPS, EXPR_STEPS = 32, 30
CFG_SCALE = 6.5
CONTROLNET_SCALE = 0.85
IP_ADAPTER_SCALE = 0.55
EXPR_STRENGTH = 0.55
FACE_BOX = (0.28, 0.03, 0.72, 0.22)  # fraction du cadre, meme convention que rig_expression.py

# Squelette "pic" par emotion: mêmes 18 keypoints COCO que rig_pose.py.
# L'etape 0 part toujours de idle_front (neutre); l'etape 9 atteint ce
# squelette pic; les etapes intermediaires interpolent lineairement.
EMOTION_PEAK_SKELETONS = {
    "anger": [
        (0.50, 0.125), (0.50, 0.175),
        (0.43, 0.185), (0.40, 0.29), (0.44, 0.40),
        (0.57, 0.185), (0.60, 0.29), (0.56, 0.40),
        (0.46, 0.48), (0.46, 0.68), (0.47, 0.88),
        (0.54, 0.48), (0.54, 0.68), (0.53, 0.88),
        (0.48, 0.115), (0.52, 0.115), (0.46, 0.12), (0.54, 0.12),
    ],
    "joy": [
        (0.50, 0.115), (0.50, 0.17),
        (0.42, 0.20), (0.36, 0.34), (0.32, 0.46),
        (0.58, 0.20), (0.64, 0.34), (0.68, 0.46),
        (0.47, 0.48), (0.45, 0.68), (0.44, 0.88),
        (0.53, 0.48), (0.55, 0.66), (0.57, 0.86),
        (0.48, 0.105), (0.52, 0.105), (0.46, 0.11), (0.54, 0.11),
    ],
    "sadness": [
        (0.50, 0.16), (0.50, 0.20),
        (0.45, 0.215), (0.44, 0.33), (0.43, 0.45),
        (0.55, 0.215), (0.56, 0.33), (0.57, 0.45),
        (0.46, 0.49), (0.46, 0.69), (0.46, 0.89),
        (0.54, 0.49), (0.54, 0.69), (0.54, 0.89),
        (0.48, 0.15), (0.52, 0.15), (0.46, 0.155), (0.54, 0.155),
    ],
}

# Expressions gradees par intensite 0 (neutre) -> 9 (pic), une liste par
# emotion. Pas d'interpolation possible sur du texte: liste ecrite a la main.
EMOTION_EXPRESSIONS = {
    "anger": [
        "neutral calm expression",
        "slightly tense expression",
        "subtle frown, narrowed eyes",
        "frowning, tight jaw",
        "annoyed expression, furrowed brows",
        "clearly angry eyes, tight mouth",
        "intense anger, gritted teeth",
        "furious glare, clenched jaw",
        "rage, bared teeth, wide furious eyes",
        "full rage expression, screaming",
    ],
    "joy": [
        "neutral calm expression",
        "faint pleasant expression",
        "soft polite smile",
        "warm smile",
        "happy smile, bright eyes",
        "cheerful grin",
        "wide happy smile, sparkling eyes",
        "joyful laughing expression",
        "delighted laughter, eyes closed smiling",
        "ecstatic joyful expression, big laugh",
    ],
    "sadness": [
        "neutral calm expression",
        "faint subdued expression",
        "slightly downcast eyes",
        "sad eyes, soft frown",
        "melancholic expression",
        "sorrowful expression, glassy eyes",
        "clearly sad, trembling lip",
        "tearful eyes, deep sorrow",
        "crying, tears, anguished expression",
        "full grief expression, tears streaming",
    ],
}


def kp(x, y):
    return Keypoint(x=x, y=y, score=1.0)


def lerp_skeleton(start_coords, end_coords, t):
    kps = []
    for (x0, y0), (x1, y1) in zip(start_coords, end_coords):
        kps.append(kp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    return kps


def idle_coords():
    return [(k.x, k.y) for k in BASE_POSES["idle_front"]]


def make_skeleton_image(keypoints):
    body = BodyResult(keypoints=keypoints, total_score=len(keypoints), total_parts=len(keypoints))
    pose = PoseResult(body=body, left_hand=None, right_hand=None, face=None)
    canvas = draw_poses([pose], HEIGHT, WIDTH, draw_body=True, draw_hand=False, draw_face=False)
    return Image.fromarray(canvas)


def build_face_mask(size):
    w, h = size
    x0, y0, x1, y1 = FACE_BOX
    box = (int(w * x0), int(h * y0), int(w * x1), int(h * y1))
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    return mask.filter(ImageFilter.GaussianBlur(18))


def character_prompt(girl, en):
    bits = [en["espece"]]
    if en.get("corne"):
        bits.append(en["corne"])
    bits += [b for b in [en["cheveux"], en["yeux"], en["gabarit"], en["peau"], en["bureau"]] if b]
    return STYLE_TAGS + ", " + girl["nom"] + ", " + ", ".join(bits)


def make_compel(pipe):
    return Compel(
        tokenizer=[pipe.tokenizer, pipe.tokenizer_2],
        text_encoder=[pipe.text_encoder, pipe.text_encoder_2],
        returned_embeddings_type=ReturnedEmbeddingsType.PENULTIMATE_HIDDEN_STATES_NON_NORMALIZED,
        requires_pooled=[False, True],
    )


def phase1_pose_arc(char_id, emotion, reference_image, prompt, out_dir, base_seed):
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

    compel = make_compel(pipe)
    cond, pooled = compel(prompt)
    neg_cond, neg_pooled = compel(NEGATIVE)
    cond, neg_cond = compel.pad_conditioning_tensors_to_same_length([cond, neg_cond])

    start, end = idle_coords(), EMOTION_PEAK_SKELETONS[emotion]
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    for i in range(N_STEPS_ARC):
        t = i / (N_STEPS_ARC - 1)
        out_path = raw_dir / f"frame_{i:02d}.png"
        if out_path.exists():
            continue
        skeleton = make_skeleton_image(lerp_skeleton(start, end, t))
        skeleton.save(raw_dir / f"frame_{i:02d}_skeleton.png")
        generator = torch.Generator(device="cpu").manual_seed(base_seed + i)
        with torch.inference_mode():
            image = pipe(
                prompt_embeds=cond, pooled_prompt_embeds=pooled,
                negative_prompt_embeds=neg_cond, negative_pooled_prompt_embeds=neg_pooled,
                image=skeleton, controlnet_conditioning_scale=CONTROLNET_SCALE,
                ip_adapter_image=reference_image,
                width=WIDTH, height=HEIGHT, num_inference_steps=POSE_STEPS, guidance_scale=CFG_SCALE,
                generator=generator,
            ).images[0]
        image.save(out_path)
        print(f"[pose] {char_id}/{emotion} frame {i}/{N_STEPS_ARC - 1} (t={t:.2f}) -> {out_path}")

    del pipe
    torch.mps.empty_cache()


def phase2_expression_arc(char_id, emotion, out_dir, base_seed):
    pipe = StableDiffusionXLInpaintPipeline.from_single_file(
        str(CKPT), torch_dtype=torch.float16, use_safetensors=True
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type="dpmsolver++", use_karras_sigmas=True
    )
    pipe.to("mps")
    compel = make_compel(pipe)
    negative = "different person, different hair, text, watermark, blurry, bad anatomy, extra eyes"
    neg_cond, neg_pooled = compel(negative)

    raw_dir = out_dir / "raw"
    expressions = EMOTION_EXPRESSIONS[emotion]

    for i in range(N_STEPS_ARC):
        raw_path = raw_dir / f"frame_{i:02d}.png"
        out_path = out_dir / f"frame_{i:02d}.png"
        if out_path.exists():
            continue
        original = Image.open(raw_path).convert("RGB")
        mask = build_face_mask(original.size)
        prompt = f"portrait face, {expressions[i]}, same person, same hair, same outfit"
        cond, pooled = compel(prompt)
        cond2, neg_cond2 = compel.pad_conditioning_tensors_to_same_length([cond, neg_cond])
        generator = torch.Generator(device="cpu").manual_seed(base_seed + 500 + i)
        with torch.inference_mode():
            raw = pipe(
                prompt_embeds=cond2, pooled_prompt_embeds=pooled,
                negative_prompt_embeds=neg_cond2, negative_pooled_prompt_embeds=neg_pooled,
                image=original, mask_image=mask,
                width=original.width, height=original.height,
                num_inference_steps=EXPR_STEPS, guidance_scale=CFG_SCALE, strength=EXPR_STRENGTH,
                generator=generator,
            ).images[0]
        final = Image.composite(raw, original, mask)
        final.save(out_path)
        print(f"[expr] {char_id}/{emotion} frame {i}/{N_STEPS_ARC - 1}: {expressions[i]} -> {out_path}")

    del pipe
    torch.mps.empty_cache()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--emotion", required=True, choices=list(EMOTION_PEAK_SKELETONS.keys()))
    ap.add_argument("--reference", required=True)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    roster = json.loads((ROOT / "hellcorp_ai" / "inspiration" / "hellcorp_girls_roster.json").read_text())["girls"]
    girl = next(g for g in roster if g["id"] == args.id)
    en = EN_OVERRIDES[args.id]
    prompt = character_prompt(girl, en)
    reference_image = Image.open(args.reference).convert("RGB")

    out_dir = OUT_ROOT / args.id / "emotions" / args.emotion
    out_dir.mkdir(parents=True, exist_ok=True)
    base_seed = args.seed if args.seed is not None else (abs(hash(args.id + args.emotion)) % 900000) + 100000

    phase1_pose_arc(args.id, args.emotion, reference_image, prompt, out_dir, base_seed)
    phase2_expression_arc(args.id, args.emotion, out_dir, base_seed)
    print(f"Arc '{args.emotion}' termine pour {args.id}: {out_dir}")


if __name__ == "__main__":
    main()
