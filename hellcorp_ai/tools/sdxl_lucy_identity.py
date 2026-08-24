#!/usr/bin/env python3
"""
Genere un premier master Lucy sur waiIllustriousSDXL_v170, avec le visage et
le corps verrouilles via IP-Adapter sur l'ancien anchor (hellcorp_generations/
lucy/00_anchor.png) que l'utilisateur veut preserver.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/sdxl_lucy_identity.py
"""

import json
from pathlib import Path

import torch
from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / "models" / "waiIllustriousSDXL_v170.safetensors"
REFERENCE = ROOT / "hellcorp_generations" / "lucy" / "00_anchor.png"
OUT_DIR = ROOT / "hellcorp_ai" / "characters" / "lucy" / "master_candidates"
CHAR_CFG = json.loads((ROOT / "hellcorp_ai" / "config" / "characters.json").read_text())["lucy"]

# On retire les traits faciaux explicites (lunettes, yeux verts) du texte pour
# ce test: le but est de laisser l'IP-Adapter reproduire le visage/corps de
# la reference plutot que de le faire lutter contre la description texte.
# Prompt volontairement court (<77 tokens CLIP): avec IP-Adapter actif,
# l'identite vient surtout de l'image de reference, pas du texte, et
# passer par prompt=/negative_prompt= directement evite un bug d'incompatibilite
# entre les embeddings compel et le processeur d'attention IP-Adapter.
PROMPT = (
    "Korean webtoon manhwa illustration, one adult woman, honey-blonde hair "
    "high bun, fitted white corporate blouse rolled sleeves, black pencil "
    "skirt, black tights, black pumps, gold watch, confident clean linework, "
    "dramatic cel shading, glossy rim light, rich color grading, full body "
    "head to shoes, feet visible, three-quarter stance, dark studio background"
)

NEGATIVE = (
    "child, underage, teenager, text, watermark, ornamental border, card "
    "frame, wings, tail, extra person, duplicate body, cropped feet, "
    "cropped legs, close-up, cowboy shot, waist-up, bad anatomy, bad hands, "
    "extra fingers, blurry, lowres, flat airbrushed skin, generic AI face"
)

SEED = int(CHAR_CFG["seed"])
STEPS = 32
CFG_SCALE = 6.5
WIDTH, HEIGHT = 768, 1344
IP_ADAPTER_SCALE = 0.65


def main():
    if not REFERENCE.exists():
        raise SystemExit(f"Reference introuvable: {REFERENCE}")

    pipe = StableDiffusionXLPipeline.from_single_file(
        str(CKPT),
        torch_dtype=torch.float16,
        use_safetensors=True,
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config,
        algorithm_type="dpmsolver++",
        use_karras_sigmas=True,
    )

    print("[IP-ADAPTER] Chargement h94/IP-Adapter (sdxl, bigG)...")
    pipe.load_ip_adapter(
        "h94/IP-Adapter",
        subfolder="sdxl_models",
        weight_name="ip-adapter_sdxl.bin",
    )
    pipe.set_ip_adapter_scale(IP_ADAPTER_SCALE)

    pipe.to("mps")

    reference_image = Image.open(REFERENCE).convert("RGB")
    generator = torch.Generator(device="cpu").manual_seed(SEED)

    with torch.inference_mode():
        image = pipe(
            prompt=PROMPT,
            negative_prompt=NEGATIVE,
            ip_adapter_image=reference_image,
            width=WIDTH,
            height=HEIGHT,
            num_inference_steps=STEPS,
            guidance_scale=CFG_SCALE,
            generator=generator,
        ).images[0]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "lucy_ip_adapter_v1.png"
    image.save(out_path)
    print(f"-> {out_path}")


if __name__ == "__main__":
    main()
