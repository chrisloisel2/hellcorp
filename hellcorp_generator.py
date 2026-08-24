#!/usr/bin/env python3
"""
HellCorp Character Generator
============================

But:
- telecharger automatiquement un checkpoint SDXL/Illustrious depuis Hugging Face;
- generer des "master references" de personnages adultes;
- reutiliser chaque reference avec IP-Adapter pour produire des poses plus coherentes;
- sauvegarder prompts, seeds et metadata pour construire ensuite un dataset LoRA/sprites.

Usage:
    python hellcorp_generator.py
    python hellcorp_generator.py --characters morrigan lucy
    python hellcorp_generator.py --reuse-anchor
    python hellcorp_generator.py --no-ip-adapter
    python hellcorp_generator.py --model John6666/wai-nsfw-illustrious-sdxl-v150-sdxl

Materiel conseille:
- NVIDIA 12 Go VRAM ou plus: confortable.
- NVIDIA 8-10 Go: le script active l'offload CPU.
- CPU seulement: fonctionne en theorie, mais SDXL sera tres lent.

Tous les personnages d'exemple sont explicitement des adultes.
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from datetime import datetime


# ---------------------------------------------------------------------
# 0. DEPENDANCES: un seul script
# ---------------------------------------------------------------------

REQUIRED = {
    "torch": "torch",
    "diffusers": "diffusers>=0.35.0",
    "transformers": "transformers>=4.55.0",
    "accelerate": "accelerate>=1.10.0",
    "safetensors": "safetensors>=0.6.0",
    "huggingface_hub": "huggingface_hub>=0.34.0",
    "PIL": "Pillow>=10.0.0",
}

def ensure_dependencies():
    missing = []
    for module_name, pip_name in REQUIRED.items():
        if importlib.util.find_spec(module_name) is None:
            missing.append(pip_name)

    if missing:
        print("[SETUP] Installation automatique:", " ".join(missing))
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-U", *missing]
        )
        print("[SETUP] Redemarrage du script...")
        os.execv(sys.executable, [sys.executable, *sys.argv])


ensure_dependencies()

import torch
from PIL import Image, ImageOps, ImageDraw
from diffusers import DiffusionPipeline, DPMSolverMultistepScheduler


# ---------------------------------------------------------------------
# 1. CONFIGURATION
# ---------------------------------------------------------------------

DEFAULT_MODEL = "Ine007/waiNSFWIllustrious_v140"
IP_ADAPTER_REPO = "h94/IP-Adapter"
IP_ADAPTER_SUBFOLDER = "sdxl_models"
IP_ADAPTER_WEIGHT = "ip-adapter_sdxl.bin"

OUTPUT_ROOT = Path("hellcorp_generations")
CACHE_DIR = Path("hf_cache")

BASE_STYLE = (
    "masterpiece, best quality, polished game concept art, "
    "dark corporate fantasy, infernal multinational corporation, "
    "stylized illustration, clean readable silhouette, detailed face, "
    "professional character design, full body, centered composition, "
    "feet visible, neutral studio background, no text, no logo"
)

# On veut bloquer toute ambiguite d'age dans notre pipeline de production.
NEGATIVE = (
    "child, minor, underage, teenager, teen, young-looking, loli, shota, "
    "bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, "
    "extra limbs, malformed limbs, duplicated body, duplicate person, "
    "cropped feet, cropped head, out of frame, blurry, lowres, jpeg artifacts, "
    "watermark, signature, text, logo"
)

# Descriptions verrouillees: elles doivent rester aussi stables que possible.
# Le nom du personnage sert seulement au classement; le modele ne connait pas
# encore ces personnages. La vraie stabilite viendra ensuite d'une LoRA par personnage.
CHARACTERS = {
    "morrigan": {
        "display_name": "Morrigan",
        "age": 31,
        "seed": 666031,
        "description": (
            "adult woman age 31, voluptuous curvy hourglass figure, tall, "
            "long wavy jet-black hair, pale warm skin, amber eyes, "
            "confident intimidating expression, elegant black tailored business suit, "
            "fitted blazer, pencil skirt, silk blouse, gold jewelry, executive ID badge, "
            "luxury finance executive, subtle demonic elegance"
        ),
    },
    "lucy": {
        "display_name": "Lucy",
        "age": 28,
        "seed": 666028,
        "description": (
            "adult woman age 28, curvy feminine figure, medium height, "
            "blonde hair in a polished high bun with loose strands, green eyes, glasses, "
            "warm clever expression, fitted white corporate blouse, black pencil skirt, "
            "lanyard and executive assistant badge, tablet in hand, "
            "high-end executive assistant, understated infernal details"
        ),
    },
    "malphas": {
        "display_name": "Malphas",
        "age": 34,
        "seed": 666034,
        "description": (
            "adult demon woman age 34, voluptuous athletic hourglass figure, tall, "
            "very long silver-white hair, violet eyes, elegant dark horns, pointed ears, "
            "calm dangerous expression, burgundy tailored blazer, black fitted trousers, "
            "occult department badge, leather folder with arcane seal, "
            "head of occult affairs, sophisticated corporate demon"
        ),
    },
    "raven": {
        "display_name": "Raven",
        "age": 33,
        "seed": 666033,
        "description": (
            "adult woman age 33, curvy athletic powerful figure, tall, deep brown skin, "
            "long black ponytail, dark eyes, stern protective expression, "
            "rolled-sleeve white corporate shirt, black fitted waistcoat, black trousers, "
            "security director badge, discreet earpiece, premium corporate security aesthetic"
        ),
    },
}

POSES = [
    (
        "front",
        "standing straight, front view, neutral A-pose, arms slightly away from torso, "
        "clear unobstructed costume design, character turnaround reference"
    ),
    (
        "three_quarter",
        "standing three-quarter view, one hand on hip, confident corporate pose, "
        "full body, clear face and costume"
    ),
    (
        "side",
        "standing side profile view, neutral posture, full body, "
        "character turnaround reference, clear silhouette"
    ),
    (
        "office",
        "standing beside a modern executive desk, holding a slim folder, "
        "subtle confident expression, full body interaction reference"
    ),
]


# ---------------------------------------------------------------------
# 2. UTILITAIRES
# ---------------------------------------------------------------------

def pick_device(requested: str):
    if requested != "auto":
        return requested

    if torch.cuda.is_available():
        return "cuda"

    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"

    return "cpu"


def dtype_for(device: str):
    if device in ("cuda", "mps"):
        return torch.float16
    return torch.float32


def configure_memory(pipe, device: str):
    """Configure la pipeline sans imposer une grosse VRAM."""
    if device == "cuda":
        total_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        print(f"[GPU] {torch.cuda.get_device_name(0)} - {total_gb:.1f} Go VRAM")

        if total_gb < 12:
            print("[GPU] VRAM < 12 Go: activation CPU offload.")
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")

        pipe.enable_vae_slicing()
        pipe.enable_attention_slicing()

    elif device == "mps":
        pipe.to("mps")
        pipe.enable_attention_slicing()
        print("[GPU] Apple MPS active.")
    else:
        pipe.to("cpu")
        print("[WARN] CPU actif. SDXL sera tres lent.")


def build_pipeline(model_id: str, device: str):
    dtype = dtype_for(device)

    print(f"[MODEL] Chargement/telechargement: {model_id}")
    print(f"[CACHE] {CACHE_DIR.resolve()}")

    kwargs = {
        "torch_dtype": dtype,
        "cache_dir": str(CACHE_DIR),
        "use_safetensors": True,
    }

    # Si HF_TOKEN est defini, Diffusers/HF l'utilisera pour les repos gated.
    token = os.getenv("HF_TOKEN")
    if token:
        kwargs["token"] = token

    pipe = DiffusionPipeline.from_pretrained(model_id, **kwargs)

    # DPM++ + Karras: bon compromis pour SDXL.
    try:
        pipe.scheduler = DPMSolverMultistepScheduler.from_config(
            pipe.scheduler.config,
            algorithm_type="dpmsolver++",
            use_karras_sigmas=True,
        )
    except Exception as exc:
        print(f"[WARN] Scheduler par defaut conserve: {exc}")

    configure_memory(pipe, device)
    return pipe


def try_enable_ip_adapter(pipe):
    """
    Charge l'IP-Adapter SDXL officiel.
    Si un checkpoint custom n'est pas compatible, le script continue sans lui.
    """
    try:
        print("[IP-ADAPTER] Telechargement/chargement h94/IP-Adapter...")
        pipe.load_ip_adapter(
            IP_ADAPTER_REPO,
            subfolder=IP_ADAPTER_SUBFOLDER,
            weight_name=IP_ADAPTER_WEIGHT,
        )
        pipe.set_ip_adapter_scale(0.62)
        print("[IP-ADAPTER] Actif, scale=0.62")
        return True
    except Exception as exc:
        print("[WARN] IP-Adapter indisponible avec cette pipeline.")
        print("[WARN]", exc)
        return False


def generator_for(seed: int, device: str):
    # Un generator CPU reste reproductible et fonctionne avec l'offload.
    return torch.Generator(device="cpu").manual_seed(seed)


def save_metadata(folder: Path, data: dict):
    with (folder / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def make_contact_sheet(images, labels, out_path: Path):
    if not images:
        return

    thumb_w, thumb_h = 384, 512
    label_h = 42
    cols = 2
    rows = (len(images) + cols - 1) // cols

    sheet = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h)), "white")
    draw = ImageDraw.Draw(sheet)

    for i, (img, label) in enumerate(zip(images, labels)):
        x = (i % cols) * thumb_w
        y = (i // cols) * (thumb_h + label_h)
        thumb = ImageOps.contain(img.convert("RGB"), (thumb_w, thumb_h))
        tx = x + (thumb_w - thumb.width) // 2
        ty = y + (thumb_h - thumb.height) // 2
        sheet.paste(thumb, (tx, ty))
        draw.text((x + 10, y + thumb_h + 10), label, fill="black")

    sheet.save(out_path, quality=95)


# ---------------------------------------------------------------------
# 3. GENERATION
# ---------------------------------------------------------------------

def generate_one(
    pipe,
    prompt: str,
    negative_prompt: str,
    seed: int,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    device: str,
    ip_image=None,
):
    kwargs = dict(
        prompt=prompt,
        negative_prompt=negative_prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=cfg,
        generator=generator_for(seed, device),
    )
    if ip_image is not None:
        kwargs["ip_adapter_image"] = ip_image

    with torch.inference_mode():
        result = pipe(**kwargs)

    return result.images[0]


def generate_character(
    pipe,
    key: str,
    cfg_data: dict,
    args,
    ip_adapter_active: bool,
):
    out = OUTPUT_ROOT / key
    out.mkdir(parents=True, exist_ok=True)

    display = cfg_data["display_name"]
    age = int(cfg_data["age"])
    if age < 21:
        raise ValueError(f"{display}: les personnages de production doivent etre adultes (21+ ici).")

    seed = int(cfg_data["seed"])
    description = cfg_data["description"]

    anchor_prompt = (
        f"{BASE_STYLE}, {description}, "
        "standing straight, front view, neutral expression, neutral A-pose, "
        "character model sheet reference, consistent facial features, consistent outfit"
    )

    anchor_path = out / "00_anchor.png"

    if args.reuse_anchor and anchor_path.exists():
        print(f"[{display}] Reutilisation anchor: {anchor_path}")
        anchor = Image.open(anchor_path).convert("RGB")
    else:
        print(f"[{display}] Generation MASTER, seed={seed}")
        anchor = generate_one(
            pipe=pipe,
            prompt=anchor_prompt,
            negative_prompt=NEGATIVE,
            seed=seed,
            width=args.width,
            height=args.height,
            steps=args.steps,
            cfg=args.cfg,
            device=args.device_resolved,
        )
        anchor.save(anchor_path)

    images = [anchor]
    labels = [f"{display} - MASTER"]
    entries = [{
        "file": anchor_path.name,
        "type": "anchor",
        "seed": seed,
        "prompt": anchor_prompt,
        "negative_prompt": NEGATIVE,
    }]

    for idx, (pose_name, pose_text) in enumerate(POSES, start=1):
        pose_seed = seed + idx
        pose_prompt = (
            f"{BASE_STYLE}, {description}, {pose_text}, "
            "same person, same face, same hairstyle, same outfit, "
            "character animation reference"
        )

        print(f"[{display}] Pose {pose_name}, seed={pose_seed}")

        # Si IP-Adapter est actif, le master devient l'image-guide.
        ref = anchor if ip_adapter_active else None

        image = generate_one(
            pipe=pipe,
            prompt=pose_prompt,
            negative_prompt=NEGATIVE,
            seed=pose_seed,
            width=args.width,
            height=args.height,
            steps=args.steps,
            cfg=args.cfg,
            device=args.device_resolved,
            ip_image=ref,
        )

        path = out / f"{idx:02d}_{pose_name}.png"
        image.save(path)
        images.append(image)
        labels.append(f"{display} - {pose_name}")

        entries.append({
            "file": path.name,
            "type": "pose",
            "pose": pose_name,
            "seed": pose_seed,
            "prompt": pose_prompt,
            "negative_prompt": NEGATIVE,
            "ip_adapter": bool(ip_adapter_active),
            "ip_adapter_scale": 0.62 if ip_adapter_active else None,
        })

    make_contact_sheet(images, labels, out / "contact_sheet.jpg")

    save_metadata(out, {
        "character": display,
        "age": age,
        "model": args.model,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "width": args.width,
        "height": args.height,
        "steps": args.steps,
        "guidance_scale": args.cfg,
        "ip_adapter": bool(ip_adapter_active),
        "entries": entries,
    })

    print(f"[{display}] Termine -> {out.resolve()}")


# ---------------------------------------------------------------------
# 4. CLI
# ---------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="HellCorp SDXL character generator")
    p.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Repo Hugging Face Diffusers/SDXL a utiliser.",
    )
    p.add_argument(
        "--characters",
        nargs="+",
        default=list(CHARACTERS.keys()),
        choices=list(CHARACTERS.keys()),
        help="Personnages a generer.",
    )
    p.add_argument("--width", type=int, default=768)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--steps", type=int, default=28)
    p.add_argument("--cfg", type=float, default=6.0)
    p.add_argument("--device", choices=["auto", "cuda", "mps", "cpu"], default="auto")
    p.add_argument(
        "--reuse-anchor",
        action="store_true",
        help="Reutilise 00_anchor.png si deja genere.",
    )
    p.add_argument(
        "--no-ip-adapter",
        action="store_true",
        help="Desactive IP-Adapter.",
    )
    p.add_argument(
        "--extra-prompt",
        default="",
        help="Texte ajoute a toutes les generations.",
    )
    return p.parse_args()


def main():
    args = parse_args()
    args.device_resolved = pick_device(args.device)

    if args.extra_prompt:
        global BASE_STYLE
        BASE_STYLE = f"{BASE_STYLE}, {args.extra_prompt}"

    print("=" * 72)
    print("HELLCORP CHARACTER GENERATOR")
    print("=" * 72)
    print("Modele :", args.model)
    print("Device :", args.device_resolved)
    print("Sortie :", OUTPUT_ROOT.resolve())
    print()
    print("IMPORTANT: ce pipeline est configure uniquement avec des personnages")
    print("explicitement adultes. Ne retire pas les garde-fous d'age pour un")
    print("pipeline de contenu adulte.")
    print()

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    pipe = build_pipeline(args.model, args.device_resolved)

    ip_adapter_active = False
    if not args.no_ip_adapter:
        ip_adapter_active = try_enable_ip_adapter(pipe)

    for key in args.characters:
        generate_character(
            pipe,
            key,
            CHARACTERS[key],
            args,
            ip_adapter_active,
        )

    print()
    print("=" * 72)
    print("GENERATION TERMINEE")
    print("=" * 72)
    print("Etape suivante:")
    print("1. choisir un MASTER valide par personnage;")
    print("2. regenerer les poses avec --reuse-anchor;")
    print("3. accumuler 20-40 references propres;")
    print("4. entrainer une LoRA personnage;")
    print("5. ajouter ensuite ControlNet/OpenPose pour les sprites/animations.")


if __name__ == "__main__":
    main()
