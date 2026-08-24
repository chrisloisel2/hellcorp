#!/usr/bin/env python3
"""
Compare deux checkpoints SDXL locaux sur le meme prompt/seed pour choisir
lequel devient le moteur de style HellCorp. Usage:

    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/sdxl_compare.py
"""

import json
from pathlib import Path

import torch
from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler
from compel import Compel, ReturnedEmbeddingsType

ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = ROOT / "models"
OUT_DIR = ROOT / "hellcorp_ai" / "characters" / "morrigan" / "master_candidates"
CHAR_CFG = json.loads((ROOT / "hellcorp_ai" / "config" / "characters.json").read_text())["morrigan"]

CHECKPOINTS = {
    "shibui": MODELS_DIR / "shibuiIllu_v20.safetensors",
    "wai": MODELS_DIR / "waiIllustriousSDXL_v170.safetensors",
}

PROMPT = (
    "Korean webtoon (manhwa) digital illustration for a mature adult dark-corporate series. "
    "One single fictional adult woman only. " + CHAR_CFG["description"] + ". "
    "Full body from head to shoes, straight front three-quarter presentation stance, feet fully "
    "visible, anatomically coherent hands, readable silhouette. Confident clean digital linework "
    "with variable line weight, bold outer contour, fine controlled interior detail lines. "
    "Dramatic painted cel shading, directional rim light, glossy specular highlights on hair and "
    "eyes, controlled skin sheen with visible texture and grain, never flat or uniform. Detailed "
    "rendered eyes with catchlights, distinct facial structure specific to this character, no "
    "interchangeable generic face. Sensual confident posture and expression, alluring but fully "
    "and professionally dressed corporate styling, subtle infernal atmosphere. Rich saturated "
    "color grading, strong signature color accents matching the character palette. Neutral warm "
    "dark studio background, single dramatic light source."
)

NEGATIVE = (
    "child, minor, underage, teenager, teen, young-looking, loli, shota, "
    "text, label, logo, watermark, signature, ornamental border, card frame, fantasy armor, "
    "wings, tail, extra person, duplicate body, cropped feet, cropped head, "
    "bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra limbs, "
    "malformed limbs, blurry, lowres, jpeg artifacts, flat uniform airbrushed skin, "
    "symmetric mirrored face, vacant expression, generic default AI face, photorealistic, 3d render"
)

SEED = int(CHAR_CFG["seed"])
STEPS = 32
CFG_SCALE = 6.5
WIDTH, HEIGHT = 832, 1216


def run_one(name: str, ckpt_path: Path):
    print(f"\n=== {name}: {ckpt_path.name} ===")
    pipe = StableDiffusionXLPipeline.from_single_file(
        str(ckpt_path),
        torch_dtype=torch.float16,
        use_safetensors=True,
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config,
        algorithm_type="dpmsolver++",
        use_karras_sigmas=True,
    )
    pipe.to("mps")
    pipe.enable_attention_slicing()

    # SDXL's CLIP encoders hard-truncate at 77 tokens; our style prompt is ~240.
    # compel chunks/concatenates embeddings across both encoders so nothing is
    # silently dropped (a plain prompt= call would cut off everything after
    # the character description, i.e. the entire manhwa style block).
    compel = Compel(
        tokenizer=[pipe.tokenizer, pipe.tokenizer_2],
        text_encoder=[pipe.text_encoder, pipe.text_encoder_2],
        returned_embeddings_type=ReturnedEmbeddingsType.PENULTIMATE_HIDDEN_STATES_NON_NORMALIZED,
        requires_pooled=[False, True],
    )
    conditioning, pooled = compel(PROMPT)
    neg_conditioning, neg_pooled = compel(NEGATIVE)
    conditioning, neg_conditioning = compel.pad_conditioning_tensors_to_same_length(
        [conditioning, neg_conditioning]
    )

    generator = torch.Generator(device="cpu").manual_seed(SEED)
    with torch.inference_mode():
        image = pipe(
            prompt_embeds=conditioning,
            pooled_prompt_embeds=pooled,
            negative_prompt_embeds=neg_conditioning,
            negative_pooled_prompt_embeds=neg_pooled,
            width=WIDTH,
            height=HEIGHT,
            num_inference_steps=STEPS,
            guidance_scale=CFG_SCALE,
            generator=generator,
        ).images[0]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{name}.png"
    image.save(out_path)
    print(f"-> {out_path}")

    del pipe
    torch.mps.empty_cache()


def main():
    for name, path in CHECKPOINTS.items():
        if not path.exists():
            print(f"[SKIP] {name}: {path} introuvable")
            continue
        run_one(name, path)
    print("\nTermine. Compare avec le master FLUX:")
    print("  hellcorp_ai/characters/morrigan/master/master.png")


if __name__ == "__main__":
    main()
