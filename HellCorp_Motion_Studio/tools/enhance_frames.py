#!/usr/bin/env python3
"""Ameliore un dossier de frames de sprites HellCorp Motion Studio avec le
upscaler diffusion SeedVR2 (deja utilise pour le splash art dans
hellcorp_sprite_pipeline.sh, 100% local/MLX). Le upscaler aplatit la
transparence en noir opaque : ce script restaure l'alpha d'origine (redimensionne
le canal alpha source et le reapplique) pour garder des sprites transparents.

Usage:
  python3 enhance_frames.py --in <dossier_frames> --out <dossier_sortie>
      [--resolution 2x] [--softness 0.35] [--seed 42] [--batch 8]
"""
import argparse
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
UPSCALER = REPO_ROOT / "hellcorp_ai/runtime/mflux-venv/bin/mflux-upscale-seedvr2"


def restore_alpha(original_path, upscaled_path, out_path):
    orig = Image.open(original_path).convert("RGBA")
    up = Image.open(upscaled_path).convert("RGB")
    alpha = orig.split()[3].resize(up.size, Image.LANCZOS)
    out = up.convert("RGBA")
    out.putalpha(alpha)
    out.save(out_path)


def run_batch(paths, out_dir, resolution, softness, seed):
    out_dir.mkdir(parents=True, exist_ok=True)
    stub = out_dir / "_raw.png"
    cmd = [
        str(UPSCALER),
        "--image-path", *[str(p) for p in paths],
        "--resolution", resolution,
        "--softness", str(softness),
        "--seed", str(seed),
        "--output", str(stub),
    ]
    subprocess.run(cmd, check=True)
    raw_outputs = []
    for p in paths:
        candidate = out_dir / f"{stub.stem}_{p.name}"
        if not candidate.exists():
            raise RuntimeError(f"Sortie upscaler manquante: {candidate}")
        raw_outputs.append(candidate)
    return raw_outputs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input_dir", required=True)
    ap.add_argument("--out", dest="output_dir", required=True)
    ap.add_argument("--resolution", default="2x")
    ap.add_argument("--softness", type=float, default=0.35)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--batch", type=int, default=8, help="Images par appel subprocess (amortit le chargement du modele).")
    args = ap.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not UPSCALER.exists():
        print(f"Upscaler introuvable: {UPSCALER}", file=sys.stderr)
        sys.exit(1)

    all_frames = sorted(input_dir.glob("*.png"))
    if not all_frames:
        print(f"Aucun PNG dans {input_dir}", file=sys.stderr)
        sys.exit(1)
    frames = [f for f in all_frames if not (output_dir / f.name).exists()]
    skipped = len(all_frames) - len(frames)

    print(f"{len(frames)} frames a ameliorer depuis {input_dir} -> {output_dir}"
          + (f" ({skipped} deja faites, reprise)" if skipped else ""))
    if not frames:
        print("Rien a faire.")
        return
    done = 0
    for start in range(0, len(frames), args.batch):
        chunk = frames[start:start + args.batch]
        raw_outputs = run_batch(chunk, output_dir, args.resolution, args.softness, args.seed)
        for src, raw in zip(chunk, raw_outputs):
            final_path = output_dir / src.name
            restore_alpha(src, raw, final_path)
            raw.unlink()
            done += 1
        print(f"  {done}/{len(frames)} terminees")

    print(f"Termine: {done} frames ecrites dans {output_dir}")


if __name__ == "__main__":
    main()
