#!/usr/bin/env python3
"""
Genere N images par personnage a partir de hellcorp_ai/inspiration/
hellcorp_girls_roster.json, sur waiIllustriousSDXL_v170, style manhwa
etabli pour HellCorp. Charge le checkpoint une seule fois pour tout le lot.

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/roster_batch_generate.py \
        --tier main --count 2
    ... --ids main_01_morrigan main_05_lilith --count 3
"""

import argparse
import hashlib
import json
from pathlib import Path

import torch
from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler
from compel import Compel, ReturnedEmbeddingsType

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / "models" / "waiIllustriousSDXL_v170.safetensors"
ROSTER_PATH = ROOT / "hellcorp_ai" / "inspiration" / "hellcorp_girls_roster.json"
OUT_ROOT = ROOT / "hellcorp_ai" / "characters"

# Checkpoint danbooru/Illustrious: repond bien aux tags courts separes par
# virgules, s'effondre en silhouette generique avec des phrases en prose
# (constate empiriquement - voir commentaire EN_OVERRIDES). Tags prioritaires
# en premier (identite), tags de style generiques a la fin.
STYLE_TAGS = (
    "manhwa illustration, korean webtoon style, clean linework, cel shading, "
    "rim light, glossy highlights, detailed eyes, full body, feet visible, "
    "standing, three-quarter view, office background, 1girl, solo"
)

NEGATIVE = (
    "child, underage, teenager, loli, "
    "text, watermark, logo, border, frame, extra person, duplicate body, "
    "cropped feet, cropped legs, close-up, cowboy shot, waist-up, "
    "wings, bat wings, tail, "
    "bad anatomy, bad hands, extra fingers, blurry, lowres, "
    "flat airbrushed skin, generic ai face, photorealistic, 3d render"
)

WIDTH, HEIGHT = 768, 1344
STEPS = 32
CFG_SCALE = 6.5

# Le roster (meta.language = "fr") decrit les personnages en francais, mais
# CLIP/SDXL ne comprend fiablement que l'anglais: un prompt francais brut se
# fait ignorer et le modele retombe sur une silhouette generique a contre-jour
# (constate sur le premier essai Morrigan). Traduction manuelle pour le tier
# main; a etendre (traduction automatique) avant de traiter les tiers suivants.
# Version condensee (tags courts, ~8-12 par personnage): un essai avec la
# richesse complete traduite (~30 tags) a degrade l'adherence par attribut
# (cornes devenues ailes, meches de couleur non demandees, teint fausse) meme
# sans collapse total. On sacrifie une partie du detail du roster pour rester
# dans la zone ou le modele suit fidelement chaque tag.
EN_OVERRIDES = {
    "main_01_morrigan": {
        "espece": "demoness", "corne": "black bronze ringed horns curved back",
        "cheveux": "dark wine red long wavy hair", "yeux": "gold eyes red ring",
        "gabarit": "slender figure", "peau": "warm ivory skin",
        "visage": "", "bureau": "black suit burgundy lapels, dark red shirt, gold chains",
        "silhouette_kw": "long coat",
    },
    "main_02_lucy": {
        "espece": "demoness", "corne": "small polished ivory horns",
        "cheveux": "platinum blonde hair above shoulders", "yeux": "light gray blue eyes, thin glasses",
        "gabarit": "soft curvy figure", "peau": "very light ivory skin",
        "visage": "", "bureau": "ivory structured suit, black shirt, gold glasses",
        "silhouette_kw": "epaulettes",
    },
    "main_03_malphas": {
        "espece": "goetic demoness", "corne": "tall black twisted horns violet tips",
        "cheveux": "ink violet long straight hair", "yeux": "electric violet eyes dark pupil",
        "gabarit": "pear shaped figure", "peau": "smoky lilac skin",
        "visage": "", "bureau": "violet black security uniform, long jacket, metal badge",
        "silhouette_kw": "pendant",
    },
    "main_04_raven": {
        "espece": "cambion", "corne": "two small black horns in hair bun",
        "cheveux": "blue black hair in loose bun", "yeux": "espresso brown eyes, rectangular glasses",
        "gabarit": "elegant rectilinear figure", "peau": "golden beige skin",
        "visage": "", "bureau": "black suit, burgundy shirt, rolled sleeves",
        "silhouette_kw": "epaulettes",
    },
    "main_05_lilith": {
        "espece": "demoness", "corne": "thin bronze horns curved like a crown",
        "cheveux": "very long blue black wavy hair", "yeux": "absinthe green eyes",
        "gabarit": "compact wiry figure", "peau": "warm mahogany brown skin",
        "visage": "", "bureau": "black dress suit, long jacket, bronze jewelry",
        "silhouette_kw": "long coat",
    },
    "main_06_nyx": {
        "espece": "mortal witch", "corne": "no horns, black ink glyphs on temples",
        "cheveux": "smoky silver long straight hair, black ribbon", "yeux": "amethyst violet eyes, heavy lidded",
        "gabarit": "tall sculptural figure", "peau": "cool ivory skin",
        "visage": "", "bureau": "long black cardigan, satin shirt, many rings",
        "silhouette_kw": "epaulettes",
    },
    "main_07_veloura": {
        "espece": "succubus", "corne": "small twisted dark red horns in hair",
        "cheveux": "dark auburn wavy hair shoulder length", "yeux": "dark turquoise eyes, wide",
        "gabarit": "hourglass figure", "peau": "light copper skin",
        "visage": "", "bureau": "brown black suit copper details, satin blouse",
        "silhouette_kw": "long coat",
    },
}


def seed_for(girl_id: str, variant: int) -> int:
    h = hashlib.sha256(girl_id.encode("utf-8")).hexdigest()
    base = int(h[:8], 16) % 900000 + 100000
    return base + variant


def build_prompt(girl: dict) -> str:
    en = EN_OVERRIDES.get(girl["id"])
    if en is None:
        raise SystemExit(
            f"{girl['id']}: pas de traduction anglaise disponible (EN_OVERRIDES). "
            "Le roster est en francais; un prompt francais brut est ignore par "
            "CLIP, ET un prompt en phrases (meme traduites) fait s'effondrer ce "
            "checkpoint danbooru/Illustrious vers une silhouette generique - "
            "voir commentaire au-dessus d'EN_OVERRIDES. Ajouter une entree en "
            "tags courts avant de generer ce personnage."
        )
    # Marqueurs les plus distinctifs en premier (cornes/cheveux/yeux): avec
    # beaucoup de tags, l'adherence par tag individuel se dilue, donc l'ordre
    # de priorite compte.
    bits = [en["espece"], f"apparent age {girl['age_apparent']}"]
    if en.get("corne"):
        bits.append(en["corne"])
    bits += [en["cheveux"], en["yeux"], en["gabarit"], en["peau"], en["visage"]]
    bits.append(en["bureau"])
    bits.append(en["silhouette_kw"])
    bits = [b for b in bits if b]

    return STYLE_TAGS + ", " + girl["nom"] + ", " + ", ".join(bits)


def load_pipe():
    pipe = StableDiffusionXLPipeline.from_single_file(
        str(CKPT), torch_dtype=torch.float16, use_safetensors=True
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type="dpmsolver++", use_karras_sigmas=True
    )
    pipe.to("mps")
    # Securite bon marche contre le bug SDXL classique de debordement VAE en
    # fp16; n'etait pas la cause de la silhouette generique observee ici
    # (c'etait le style de prompt, voir STYLE_TAGS/EN_OVERRIDES), mais ca ne
    # coute presque rien de le garder.
    pipe.vae.to(torch.float32)
    pipe.vae.config.force_upcast = True
    return pipe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=["main", "prestige", "rare", "common"])
    ap.add_argument("--ids", nargs="+")
    ap.add_argument("--count", type=int, default=2)
    args = ap.parse_args()

    roster = json.loads(ROSTER_PATH.read_text())["girls"]
    if args.ids:
        girls = [g for g in roster if g["id"] in args.ids]
    elif args.tier:
        girls = [g for g in roster if g["tier"] == args.tier]
    else:
        raise SystemExit("Precise --tier ou --ids.")

    print(f"Personnages a traiter: {len(girls)} x {args.count} images")
    for g in girls:
        assert g["adulte"] and int(g["age_apparent"]) >= 21, f"Garde-fou age: {g['id']}"

    pipe = load_pipe()
    compel = Compel(
        tokenizer=[pipe.tokenizer, pipe.tokenizer_2],
        text_encoder=[pipe.text_encoder, pipe.text_encoder_2],
        returned_embeddings_type=ReturnedEmbeddingsType.PENULTIMATE_HIDDEN_STATES_NON_NORMALIZED,
        requires_pooled=[False, True],
    )
    neg_conditioning, neg_pooled = compel(NEGATIVE)

    for gi, girl in enumerate(girls, start=1):
        out_dir = OUT_ROOT / girl["id"] / "roster"
        out_dir.mkdir(parents=True, exist_ok=True)
        prompt = build_prompt(girl)
        conditioning, pooled = compel(prompt)
        cond, neg_cond = compel.pad_conditioning_tensors_to_same_length(
            [conditioning, neg_conditioning]
        )

        for v in range(args.count):
            out_path = out_dir / f"{v:02d}.png"
            if out_path.exists():
                print(f"[SKIP] {girl['id']} {v} deja present")
                continue
            seed = seed_for(girl["id"], v)
            print(f"[{gi}/{len(girls)}] {girl['id']} variant {v} seed={seed}")
            generator = torch.Generator(device="cpu").manual_seed(seed)
            with torch.inference_mode():
                image = pipe(
                    prompt_embeds=cond,
                    pooled_prompt_embeds=pooled,
                    negative_prompt_embeds=neg_cond,
                    negative_pooled_prompt_embeds=neg_pooled,
                    width=WIDTH,
                    height=HEIGHT,
                    num_inference_steps=STEPS,
                    guidance_scale=CFG_SCALE,
                    generator=generator,
                ).images[0]
            image.save(out_path)
            (out_dir / f"{v:02d}.json").write_text(
                json.dumps({"id": girl["id"], "seed": seed, "prompt": prompt}, indent=2, ensure_ascii=False)
            )

    print("Termine.")


if __name__ == "__main__":
    main()
