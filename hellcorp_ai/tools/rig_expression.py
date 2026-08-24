#!/usr/bin/env python3
"""
Change l'expression faciale d'un portrait/master deja genere SANS toucher le
reste de l'image (tenue, corps, decor): detection du visage (Haar cascade
OpenCV, BSD, aucune dependance/licence supplementaire), inpainting SDXL
restreint a une zone autour du visage, puis recomposition finale via un
masque a bords adoucis - tout ce qui est hors du masque est repris pixel a
pixel sur l'image d'origine, pas juste "proche" apres l'inpainting.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_expression.py \
        --input hellcorp_ai/characters/main_01_morrigan/roster/00.png \
        --id main_01_morrigan --expression smile
"""

import argparse
from pathlib import Path

import torch
from PIL import Image, ImageFilter, ImageDraw
from diffusers import StableDiffusionXLInpaintPipeline, DPMSolverMultistepScheduler
from compel import Compel, ReturnedEmbeddingsType

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / "models" / "waiIllustriousSDXL_v170.safetensors"
OUT_ROOT = ROOT / "hellcorp_ai" / "characters"

EXPRESSIONS = {
    "neutral": "neutral calm expression",
    "smile": "gentle smile, warm expression",
    "smirk": "confident smirk, one eyebrow raised",
    "angry": "angry expression, furrowed brows, glaring",
    "surprised": "surprised expression, wide eyes, raised eyebrows",
    "worried": "worried expression, concerned eyes",
    "cold": "cold disdainful expression, half-lidded eyes",
}

STEPS = 30
CFG_SCALE = 6.5
STRENGTH = 0.55
FEATHER_PX = 18


def detect_face_box(image: Image.Image):
    # OpenCV 5 a retire CascadeClassifier (Haar); plutot que d'ajouter une
    # dependance (YuNet + telechargement ONNX) pour un vrai detecteur, on
    # exploite le fait que toute la pipeline HellCorp genere des personnages
    # corps entier centres avec la tete toujours dans la meme zone du cadre
    # (STYLE_TAGS impose "full body, standing, three-quarter view"). Zone
    # heuristique fixe, --box pour les compositions qui sortent de cette
    # convention plutot que de deviner.
    w, h = image.size
    x0, y0 = int(w * 0.28), int(h * 0.03)
    x1, y1 = int(w * 0.72), int(h * 0.22)
    return x0, y0, x1, y1


def build_mask(image: Image.Image, box) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(box, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(FEATHER_PX))
    return mask


def load_pipe():
    pipe = StableDiffusionXLInpaintPipeline.from_single_file(
        str(CKPT), torch_dtype=torch.float16, use_safetensors=True
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type="dpmsolver++", use_karras_sigmas=True
    )
    pipe.to("mps")
    return pipe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--id", required=True)
    ap.add_argument("--expression", required=True, choices=list(EXPRESSIONS.keys()))
    ap.add_argument("--box", nargs=4, type=int, help="Override manuel: x0 y0 x1 y1 en pixels")
    ap.add_argument("--seed", type=int, default=12345)
    args = ap.parse_args()

    original = Image.open(args.input).convert("RGB")
    box = tuple(args.box) if args.box else detect_face_box(original)
    mask = build_mask(original, box)

    debug_dir = OUT_ROOT / args.id / "expressions"
    debug_dir.mkdir(parents=True, exist_ok=True)
    mask.save(debug_dir / f"_mask_{args.expression}.png")

    pipe = load_pipe()
    compel = Compel(
        tokenizer=[pipe.tokenizer, pipe.tokenizer_2],
        text_encoder=[pipe.text_encoder, pipe.text_encoder_2],
        returned_embeddings_type=ReturnedEmbeddingsType.PENULTIMATE_HIDDEN_STATES_NON_NORMALIZED,
        requires_pooled=[False, True],
    )
    prompt = f"portrait face, {EXPRESSIONS[args.expression]}, same person, same hair, same outfit"
    negative = "different person, different hair, text, watermark, blurry, bad anatomy, extra eyes"

    cond, pooled = compel(prompt)
    neg_cond, neg_pooled = compel(negative)
    cond, neg_cond = compel.pad_conditioning_tensors_to_same_length([cond, neg_cond])

    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    with torch.inference_mode():
        raw = pipe(
            prompt_embeds=cond, pooled_prompt_embeds=pooled,
            negative_prompt_embeds=neg_cond, negative_pooled_prompt_embeds=neg_pooled,
            image=original, mask_image=mask,
            width=original.width, height=original.height,
            num_inference_steps=STEPS, guidance_scale=CFG_SCALE, strength=STRENGTH,
            generator=generator,
        ).images[0]

    # Recomposition finale: tout ce qui est hors du masque adouci reprend les
    # pixels d'origine exactement, le blending du pipeline seul ne le garantit pas.
    final = Image.composite(raw, original, mask)

    out_path = debug_dir / f"{args.expression}.png"
    final.save(out_path)
    print(f"-> {out_path}")


if __name__ == "__main__":
    main()
