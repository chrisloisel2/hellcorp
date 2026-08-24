#!/usr/bin/env bash
set -euo pipefail

# HellCorp Sprite Pipeline - Apple Silicon / M3
# ------------------------------------------------------------
# Production goal:
#   1. one locked canonical master per adult character;
#   2. reference-conditioned portraits, expressions and sprite concepts;
#   3. fixed-size RGBA exports for Godot;
#   4. clean inspiration sheets assembled outside the image model.
#
# Main model:
#   FLUX.2 Klein 4B through MFLUX (MLX native, Apache-2.0 weights).
# Optional splash upscaler:
#   SeedVR2 3B through MFLUX.
#
# This script does not generate final frame-perfect animation cycles.
# It generates consistent production references and Godot-sized sprite assets.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_ROOT="${HELLCORP_AI_ROOT:-$SCRIPT_DIR/hellcorp_ai}"
VENV="$AI_ROOT/.venv"
BIN="$VENV/bin"
PY="$BIN/python"
HELPER="$AI_ROOT/tools/hellcorp_assets.py"
CONFIG="$AI_ROOT/config/characters.json"
HF_HOME_DIR="$AI_ROOT/cache/huggingface"
MFLUX_CACHE="$AI_ROOT/cache/mflux"
OUTPUT_ROOT="$AI_ROOT/characters"
GUIDE_ROOT="$AI_ROOT/guides"
INSPIRATION_ROOT="$AI_ROOT/inspiration"

MODEL="${HC_MODEL:-flux2-klein-4b}"
STEPS="${HC_STEPS:-4}"
STYLE_LORA="${HC_STYLE_LORA:-}"
STYLE_LORA_SCALE="${HC_STYLE_LORA_SCALE:-0.75}"
WORLD_HEIGHT="${HC_WORLD_HEIGHT:-208}"
WORLD_CELL="${HC_WORLD_CELL:-256}"
WORLD_COLORS="${HC_WORLD_COLORS:-48}"
WORLD_SET="${HC_WORLD_SET:-quick}"
FORCE="${HC_FORCE:-0}"
UPSCALE_SPLASH="${HC_UPSCALE_SPLASH:-0}"

export HF_HOME="$HF_HOME_DIR"
export MFLUX_CACHE_DIR="$MFLUX_CACHE"
export TOKENIZERS_PARALLELISM=false

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
blue='\033[0;34m'
reset='\033[0m'

log() { printf "%b[HELLCORP]%b %s\n" "$blue" "$reset" "$*"; }
ok() { printf "%b[OK]%b %s\n" "$green" "$reset" "$*"; }
warn() { printf "%b[ATTENTION]%b %s\n" "$yellow" "$reset" "$*"; }
die() { printf "%b[ERREUR]%b %s\n" "$red" "$reset" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
HellCorp Sprite Pipeline - commandes

  ./hellcorp_sprite_pipeline.sh doctor
  ./hellcorp_sprite_pipeline.sh setup
  ./hellcorp_sprite_pipeline.sh auth
  ./hellcorp_sprite_pipeline.sh download
  ./hellcorp_sprite_pipeline.sh status

  ./hellcorp_sprite_pipeline.sh train-style
      Entraine une LoRA de style a partir de hellcorp_ai/style_lora/dataset
      (paires image.png + image.txt deposees a la main). Sortie:
      hellcorp_ai/style_lora/output/NNNNNNN_checkpoint.zip
      -> dezipper pour recuperer NNNNNNN_adapter.safetensors
      -> pointer HC_STYLE_LORA dessus pour l'utiliser en generation.

  ./hellcorp_sprite_pipeline.sh master morrigan
  ./hellcorp_sprite_pipeline.sh promote morrigan /chemin/image.png
  ./hellcorp_sprite_pipeline.sh portrait morrigan
  ./hellcorp_sprite_pipeline.sh expressions morrigan
  ./hellcorp_sprite_pipeline.sh world morrigan [quick|full]
  ./hellcorp_sprite_pipeline.sh sheet morrigan
  ./hellcorp_sprite_pipeline.sh upscale morrigan
  ./hellcorp_sprite_pipeline.sh all morrigan [quick|full]

  ./hellcorp_sprite_pipeline.sh inspiration

Personnages integres:
  morrigan, lucy, malphas

Variables utiles:
  HC_FORCE=1                 Regenerer les fichiers existants.
  HC_WORLD_SET=full          Generer les marches dans les 4 directions.
  HC_WORLD_HEIGHT=208        Hauteur visible du personnage dans Godot.
  HC_WORLD_CELL=256          Taille de chaque cellule de sprite.
  HC_WORLD_COLORS=48         Palette maximale apres reduction.
  HC_QUANTIZE=4|6|8          Quantification MLX.
  HC_PROFILE=low|balanced|quality
  HC_STYLE_LORA=/path/x.safetensors
  HC_STYLE_LORA_SCALE=0.75
  HELLCORP_AI_ROOT=/Volumes/SSD/HellCorpAI

Exemples:
  ./hellcorp_sprite_pipeline.sh setup
  ./hellcorp_sprite_pipeline.sh auth
  ./hellcorp_sprite_pipeline.sh download
  ./hellcorp_sprite_pipeline.sh all morrigan quick
  ./hellcorp_sprite_pipeline.sh inspiration
EOF
}

memory_gb() {
  if [ "$(uname -s)" = "Darwin" ]; then
    local bytes
    bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    awk -v b="$bytes" 'BEGIN { printf "%.0f", b/1024/1024/1024 }'
  else
    awk '/MemTotal/ { printf "%.0f", $2/1024/1024 }' /proc/meminfo 2>/dev/null || echo 0
  fi
}

choose_quantize() {
  if [ -n "${HC_QUANTIZE:-}" ]; then
    printf "%s" "$HC_QUANTIZE"
    return
  fi
  local gb
  gb="$(memory_gb)"
  if [ "$gb" -le 18 ]; then
    printf "4"
  elif [ "$gb" -le 32 ]; then
    printf "6"
  else
    printf "8"
  fi
}

choose_profile() {
  if [ -n "${HC_PROFILE:-}" ]; then
    printf "%s" "$HC_PROFILE"
    return
  fi
  local gb
  gb="$(memory_gb)"
  if [ "$gb" -le 16 ]; then
    printf "low"
  elif [ "$gb" -le 32 ]; then
    printf "balanced"
  else
    printf "quality"
  fi
}

QUANTIZE="$(choose_quantize)"
PROFILE="$(choose_profile)"

profile_dimensions() {
  case "$PROFILE" in
    low)
      MASTER_W=768; MASTER_H=1152; EDIT_W=704; EDIT_H=1024; WORLD_GEN_W=640; WORLD_GEN_H=896 ;;
    balanced)
      MASTER_W=896; MASTER_H=1344; EDIT_W=768; EDIT_H=1152; WORLD_GEN_W=704; WORLD_GEN_H=1024 ;;
    quality)
      MASTER_W=1024; MASTER_H=1536; EDIT_W=896; EDIT_H=1344; WORLD_GEN_W=768; WORLD_GEN_H=1088 ;;
    *) die "HC_PROFILE doit valoir low, balanced ou quality." ;;
  esac
}
profile_dimensions

low_ram_needed() {
  [ "$(memory_gb)" -le 24 ]
}

ensure_macos_arm() {
  if [ "$(uname -s)" != "Darwin" ]; then
    warn "Ce pipeline est optimise pour macOS Apple Silicon. Execution continue sans garantie."
    return
  fi
  if [ "$(uname -m)" != "arm64" ]; then
    die "Apple Silicon arm64 requis."
  fi
}

find_uv() {
  if command -v uv >/dev/null 2>&1; then
    command -v uv
    return
  fi
  for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    if [ -x "$candidate" ]; then
      printf "%s" "$candidate"
      return
    fi
  done
  return 1
}

install_uv() {
  local uv_path
  if uv_path="$(find_uv 2>/dev/null)"; then
    printf "%s" "$uv_path"
    return
  fi
  command -v curl >/dev/null 2>&1 || die "curl est requis pour installer uv."
  log "Installation de uv dans le compte utilisateur."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  uv_path="$(find_uv 2>/dev/null || true)"
  [ -n "$uv_path" ] || die "uv n'a pas ete trouve apres installation."
  printf "%s" "$uv_path"
}

require_setup() {
  [ -x "$PY" ] || die "Pipeline non installe. Lance: ./hellcorp_sprite_pipeline.sh setup"
  [ -x "$BIN/mflux-generate-flux2" ] || die "MFLUX incomplet. Relance setup."
  [ -f "$HELPER" ] || die "Helper manquant. Relance setup."
  [ -f "$CONFIG" ] || "$PY" "$HELPER" init --root "$AI_ROOT"
}

write_helper() {
  mkdir -p "$AI_ROOT/tools"
  cat > "$HELPER" <<'PY'
#!/usr/bin/env python3
from __future__ import annotations

import argparse
import colorsys
import hashlib
import json
import math
import os
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

DEFAULT_CHARACTERS = {
    "morrigan": {
        "display_name": "Morrigan",
        "age": 31,
        "role": "VP Finance",
        "seed": 666031,
        "description": (
            "fictional adult woman age 31, tall voluptuous hourglass figure, "
            "long voluminous wavy jet-black hair, warm pale skin, amber eyes, "
            "mature angular face, controlled intimidating expression, "
            "black tailored executive blazer, ivory silk blouse, fitted knee-length pencil skirt, "
            "black tights, black pumps, restrained gold jewelry, HellCorp executive badge"
        ),
        "palette": ["#0D0D0F", "#242127", "#4B3434", "#8A2026", "#C38B34", "#E0B99E", "#F2D7C4"],
    },
    "lucy": {
        "display_name": "Lucy",
        "age": 28,
        "role": "Executive Assistant",
        "seed": 666028,
        "description": (
            "fictional adult woman age 28, curvy feminine figure, medium height, "
            "honey-blonde hair in a polished high bun with two loose strands, green eyes, black glasses, "
            "mature intelligent friendly face, fitted white corporate blouse with rolled sleeves, "
            "black knee-length pencil skirt, black tights, black pumps, slim gold watch, "
            "HellCorp assistant badge and black tablet"
        ),
        "palette": ["#171619", "#2F2927", "#6D4A2E", "#B88653", "#E4C29E", "#F1E8DE", "#496252"],
    },
    "malphas": {
        "display_name": "Malphas",
        "age": 34,
        "role": "Head of Occult Affairs",
        "seed": 666034,
        "description": (
            "fictional adult demon woman age 34, tall voluptuous athletic hourglass figure, "
            "very long silver-white hair, violet eyes, pointed ears, symmetrical elegant black horns, "
            "mature calm dangerous face, burgundy tailored blazer over a black blouse, "
            "high-waisted fitted black trousers, black pumps, restrained occult gold jewelry, "
            "HellCorp occult badge and one closed black grimoire"
        ),
        "palette": ["#111116", "#29232C", "#571E29", "#8C3341", "#C08D3F", "#8B7B9D", "#E5D9D6"],
    },
}

POSES = {
    "idle_front": {"view": "front view", "pose": "neutral upright idle stance, arms relaxed at sides"},
    "idle_back": {"view": "back view", "pose": "neutral upright idle stance, arms relaxed at sides"},
    "idle_left": {"view": "left side profile", "pose": "neutral upright idle stance"},
    "idle_right": {"view": "right side profile", "pose": "neutral upright idle stance"},
    "walk_front_a": {"view": "front view", "pose": "walking keyframe, left foot forward, opposite arm swing"},
    "walk_front_b": {"view": "front view", "pose": "walking passing keyframe, feet close, torso centered"},
    "walk_front_c": {"view": "front view", "pose": "walking keyframe, right foot forward, opposite arm swing"},
    "walk_back_a": {"view": "back view", "pose": "walking keyframe, left foot forward, opposite arm swing"},
    "walk_back_b": {"view": "back view", "pose": "walking passing keyframe, feet close, torso centered"},
    "walk_back_c": {"view": "back view", "pose": "walking keyframe, right foot forward, opposite arm swing"},
    "walk_left_a": {"view": "left side profile", "pose": "walking contact keyframe, front leg extended"},
    "walk_left_b": {"view": "left side profile", "pose": "walking passing keyframe, rear foot lifted"},
    "walk_left_c": {"view": "left side profile", "pose": "walking opposite contact keyframe"},
    "walk_right_a": {"view": "right side profile", "pose": "walking contact keyframe, front leg extended"},
    "walk_right_b": {"view": "right side profile", "pose": "walking passing keyframe, rear foot lifted"},
    "walk_right_c": {"view": "right side profile", "pose": "walking opposite contact keyframe"},
    "talk": {"view": "front three-quarter view", "pose": "speaking with one hand making a small professional gesture"},
    "present": {"view": "front three-quarter view", "pose": "presenting information with one open palm"},
    "sit": {"view": "left three-quarter view", "pose": "seated upright on a simple office chair, feet grounded"},
    "use_pc": {"view": "left three-quarter view", "pose": "seated at a minimal office desk using a computer keyboard"},
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def font(size: int, bold: bool = False):
    candidates = []
    if os.uname().sysname == "Darwin":
        candidates.extend([
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        ])
    candidates.extend([
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ])
    for path in candidates:
        try:
            if Path(path).exists():
                return ImageFont.truetype(path, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def init_root(root: Path):
    for rel in ["config", "cache/huggingface", "cache/mflux", "characters", "guides", "inspiration", "tools"]:
        (root / rel).mkdir(parents=True, exist_ok=True)
    cfg = root / "config" / "characters.json"
    if not cfg.exists():
        cfg.write_text(json.dumps(DEFAULT_CHARACTERS, ensure_ascii=False, indent=2), encoding="utf-8")
    create_guides(root / "guides")
    readme = root / "README_FIRST.txt"
    if not readme.exists():
        readme.write_text(
            "HellCorp AI assets\n\n"
            "1. Valider un master unique par personnage.\n"
            "2. Ne jamais regenerer les animations finales directement frame par frame.\n"
            "3. Utiliser les sorties world comme references, puis finaliser les cycles dans Godot/Aseprite.\n"
            "4. Verifier la licence de toute LoRA tierce avant usage commercial.\n",
            encoding="utf-8",
        )


def load_cfg(root: Path):
    cfg = root / "config" / "characters.json"
    if not cfg.exists():
        init_root(root)
    data = json.loads(cfg.read_text(encoding="utf-8"))
    for key, value in data.items():
        if int(value.get("age", 0)) < 21:
            raise SystemExit(f"{key}: age invalide. Tous les personnages doivent etre explicitement adultes.")
    return data


def draw_mannequin(draw: ImageDraw.ImageDraw, pose: str, w: int, h: int):
    spec = POSES.get(pose, POSES["idle_front"])
    cx = w // 2
    top = int(h * 0.12)
    head_r = int(w * 0.055)
    neck_y = top + head_r * 2 + 12
    shoulder_y = neck_y + 25
    hip_y = int(h * 0.54)
    knee_y = int(h * 0.73)
    foot_y = int(h * 0.91)
    color = (38, 46, 58)
    joint = (166, 62, 70)
    width = max(8, w // 70)

    # Pose offsets.
    left_foot_x = cx - int(w * 0.07)
    right_foot_x = cx + int(w * 0.07)
    left_hand = (cx - int(w * 0.16), int(h * 0.47))
    right_hand = (cx + int(w * 0.16), int(h * 0.47))

    if "walk" in pose:
        phase = pose[-1]
        if phase == "a":
            left_foot_x -= int(w * 0.10)
            right_foot_x += int(w * 0.04)
            left_hand = (cx + int(w * 0.13), int(h * 0.42))
            right_hand = (cx - int(w * 0.13), int(h * 0.49))
        elif phase == "c":
            left_foot_x += int(w * 0.04)
            right_foot_x += int(w * 0.10)
            left_hand = (cx - int(w * 0.13), int(h * 0.49))
            right_hand = (cx + int(w * 0.13), int(h * 0.42))
    elif pose == "talk":
        right_hand = (cx + int(w * 0.20), int(h * 0.33))
    elif pose == "present":
        right_hand = (cx + int(w * 0.25), int(h * 0.43))
    elif pose in {"sit", "use_pc"}:
        hip_y = int(h * 0.56)
        knee_y = int(h * 0.66)
        foot_y = int(h * 0.82)
        left_foot_x = cx - int(w * 0.12)
        right_foot_x = cx + int(w * 0.12)
        left_hand = (cx - int(w * 0.08), int(h * 0.57))
        right_hand = (cx + int(w * 0.10), int(h * 0.57))

    head = (cx, top + head_r)
    neck = (cx, neck_y)
    l_sh = (cx - int(w * 0.09), shoulder_y)
    r_sh = (cx + int(w * 0.09), shoulder_y)
    l_el = ((l_sh[0] + left_hand[0]) // 2, (l_sh[1] + left_hand[1]) // 2)
    r_el = ((r_sh[0] + right_hand[0]) // 2, (r_sh[1] + right_hand[1]) // 2)
    hip = (cx, hip_y)
    l_hip = (cx - int(w * 0.055), hip_y)
    r_hip = (cx + int(w * 0.055), hip_y)
    l_knee = ((l_hip[0] + left_foot_x) // 2, knee_y)
    r_knee = ((r_hip[0] + right_foot_x) // 2, knee_y)
    l_foot = (left_foot_x, foot_y)
    r_foot = (right_foot_x, foot_y)

    draw.ellipse([head[0]-head_r, head[1]-head_r, head[0]+head_r, head[1]+head_r], outline=color, width=width)
    for a, b in [
        (neck, hip), (l_sh, r_sh), (l_sh, l_el), (l_el, left_hand),
        (r_sh, r_el), (r_el, right_hand), (l_hip, r_hip),
        (l_hip, l_knee), (l_knee, l_foot), (r_hip, r_knee), (r_knee, r_foot),
    ]:
        draw.line([a, b], fill=color, width=width)
    for p in [neck, l_sh, r_sh, l_el, r_el, left_hand, right_hand, l_hip, r_hip, l_knee, r_knee, l_foot, r_foot]:
        r = max(4, width // 2)
        draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r], fill=joint)

    label_font = font(28, bold=True)
    draw.text((24, 20), pose.upper(), fill=(88, 32, 38), font=label_font)
    draw.text((24, h - 58), f"POSE GUIDE ONLY - {spec['view']}", fill=(70, 70, 74), font=font(20))


def create_guides(folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    for pose in POSES:
        path = folder / f"{pose}.png"
        if path.exists():
            continue
        im = Image.new("RGB", (768, 1024), (244, 241, 235))
        d = ImageDraw.Draw(im)
        draw_mannequin(d, pose, 768, 1024)
        im.save(path)


def remove_flat_background(im: Image.Image, threshold: int = 42) -> Image.Image:
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    samples = [px[0, 0][:3], px[w-1, 0][:3], px[0, h-1][:3], px[w-1, h-1][:3]]
    bg = tuple(sorted(s[i] for s in samples)[len(samples)//2] for i in range(3))

    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            dist = math.sqrt((r-bg[0])**2 + (g-bg[1])**2 + (b-bg[2])**2)
            # White/gray studio backgrounds are removed. Dark character areas remain.
            if dist < threshold or (r > 238 and g > 235 and b > 230):
                ap[x, y] = 0
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.65))
    rgba.putalpha(alpha)
    return rgba


def add_outline(im: Image.Image, radius: int = 1) -> Image.Image:
    if radius <= 0:
        return im
    alpha = im.getchannel("A")
    expanded = alpha.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    outline_alpha = ImageChops.subtract(expanded, alpha)
    outline = Image.new("RGBA", im.size, (19, 18, 22, 0))
    outline.putalpha(outline_alpha)
    return Image.alpha_composite(outline, im)


def quantize_rgba(im: Image.Image, colors: int) -> Image.Image:
    colors = max(8, min(256, int(colors)))
    alpha = im.getchannel("A")
    base = Image.new("RGB", im.size, (244, 241, 235))
    base.paste(im.convert("RGB"), mask=alpha)
    q = base.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).convert("RGBA")
    q.putalpha(alpha)
    return q


def normalize_sprite(input_path: Path, output_path: Path, target_h: int, cell_w: int, cell_h: int, colors: int, outline: int):
    im = Image.open(input_path).convert("RGBA")
    im = remove_flat_background(im)
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        raise SystemExit(f"Fond non retire ou image vide: {input_path}")
    im = im.crop(bbox)
    scale = min(target_h / im.height, (cell_w - 16) / im.width)
    nw = max(1, round(im.width * scale))
    nh = max(1, round(im.height * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    im = quantize_rgba(im, colors)
    im = add_outline(im, outline)

    canvas = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
    baseline = cell_h - 10
    x = (cell_w - im.width) // 2
    y = baseline - im.height
    if y < 2:
        y = 2
    canvas.alpha_composite(im, (x, y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)


def fit(im: Image.Image, box, bg=(25, 26, 29, 255), pad=10):
    x, y, w, h = box
    tile = Image.new("RGBA", (w, h), bg)
    content = ImageOps.contain(im.convert("RGBA"), (max(1, w-pad*2), max(1, h-pad*2)), Image.Resampling.LANCZOS)
    tile.alpha_composite(content, ((w-content.width)//2, (h-content.height)//2))
    return tile


def draw_label(draw, xy, text, size=24, fill=(226, 226, 229), bold=False):
    draw.text(xy, text, font=font(size, bold=bold), fill=fill)


def top_palette(images, n=16):
    counter = Counter()
    for im in images:
        rgba = im.convert("RGBA").resize((64, 64), Image.Resampling.NEAREST)
        for r, g, b, a in rgba.getdata():
            if a > 100:
                key = (r//24*24, g//24*24, b//24*24)
                counter[key] += 1
    return [c for c, _ in counter.most_common(n)]


def sheet(root: Path, character: str):
    cfg = load_cfg(root)
    if character not in cfg:
        raise SystemExit(f"Personnage inconnu: {character}")
    c = cfg[character]
    base = root / "characters" / character
    master = base / "master" / "master.png"
    portrait = base / "portrait" / "portrait.png"
    expr_dir = base / "expressions"
    sprite_dir = base / "world" / "sprites"

    if not master.exists():
        raise SystemExit(f"Master absent: {master}")

    W, H = 2048, 1536
    bg = (17, 19, 22, 255)
    panel = (28, 30, 34, 255)
    line = (86, 54, 49, 255)
    gold = (210, 151, 63, 255)
    white = (233, 231, 229, 255)
    muted = (169, 169, 174, 255)

    canvas = Image.new("RGBA", (W, H), bg)
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, W-1, H-1], outline=(89, 90, 94), width=2)
    d.rectangle([0, 0, W, 92], fill=(12, 14, 17))
    draw_label(d, (36, 20), "HELLCORP", 46, (180, 49, 55), True)
    draw_label(d, (325, 30), f"{c['display_name'].upper()} — {c['role'].upper()}", 32, white, True)
    draw_label(d, (36, 105), "SPLASH / MASTER", 24, gold, True)
    draw_label(d, (590, 105), "PORTRAIT ANIME", 24, gold, True)
    draw_label(d, (1030, 105), "EXPRESSIONS", 24, gold, True)
    draw_label(d, (590, 700), "SPRITES MONDE — GODOT", 24, gold, True)

    # Panels
    d.rounded_rectangle([26, 140, 555, 1478], radius=12, fill=panel, outline=line, width=2)
    d.rounded_rectangle([580, 140, 1005, 670], radius=12, fill=panel, outline=line, width=2)
    d.rounded_rectangle([1020, 140, 2020, 670], radius=12, fill=panel, outline=line, width=2)
    d.rounded_rectangle([580, 735, 2020, 1478], radius=12, fill=panel, outline=line, width=2)

    master_im = Image.open(master).convert("RGBA")
    canvas.alpha_composite(fit(master_im, (44, 160, 493, 1110), panel), (44, 160))
    draw_label(d, (52, 1292), f"AGE: {c['age']}   ROLE: {c['role']}", 22, muted)
    desc = c["description"]
    words = desc.split()
    lines, current = [], []
    for word in words:
        trial = " ".join(current + [word])
        if len(trial) > 46:
            lines.append(" ".join(current)); current = [word]
        else:
            current.append(word)
    if current: lines.append(" ".join(current))
    yy = 1330
    for line_text in lines[:6]:
        draw_label(d, (52, yy), line_text, 18, muted); yy += 25

    if portrait.exists():
        portrait_im = Image.open(portrait).convert("RGBA")
    else:
        portrait_im = master_im
    canvas.alpha_composite(fit(portrait_im, (598, 158, 389, 492), panel), (598, 158))

    exprs = []
    for p in sorted(expr_dir.glob("*.png")) if expr_dir.exists() else []:
        exprs.append((p.stem, Image.open(p).convert("RGBA")))
    if not exprs:
        exprs = [("reference", portrait_im)]
    cols = 3
    cell_w, cell_h = 310, 225
    for idx, (name, im) in enumerate(exprs[:6]):
        col, row = idx % cols, idx // cols
        x, y = 1040 + col * 320, 160 + row * 245
        canvas.alpha_composite(fit(im, (x, y, cell_w, 190), panel, 5), (x, y))
        draw_label(d, (x+8, y+194), name.replace("_", " ").upper(), 18, muted, True)

    sprites = []
    for p in sorted(sprite_dir.glob("*.png")) if sprite_dir.exists() else []:
        sprites.append((p.stem, Image.open(p).convert("RGBA")))
    sprite_cols = 7
    scw, sch = 190, 260
    for idx, (name, im) in enumerate(sprites[:21]):
        col, row = idx % sprite_cols, idx // sprite_cols
        x, y = 604 + col * 198, 770 + row * 224
        checker = Image.new("RGBA", (scw, 190), (22, 23, 27, 255))
        cd = ImageDraw.Draw(checker)
        for cy in range(0, 190, 16):
            for cx in range(0, scw, 16):
                if (cx//16 + cy//16) % 2 == 0:
                    cd.rectangle([cx, cy, cx+15, cy+15], fill=(31, 32, 37, 255))
        content = ImageOps.contain(im, (scw-8, 186), Image.Resampling.NEAREST)
        checker.alpha_composite(content, ((scw-content.width)//2, 190-content.height))
        canvas.alpha_composite(checker, (x, y))
        draw_label(d, (x+4, y+194), name.replace("_", " ").upper(), 14, muted, True)

    palette_images = [im for _, im in sprites] or [portrait_im]
    palette = top_palette(palette_images, 18)
    draw_label(d, (604, 1435), "PALETTE", 17, gold, True)
    for idx, color in enumerate(palette):
        x = 720 + idx * 60
        d.rectangle([x, 1428, x+48, 1462], fill=(*color, 255), outline=(90, 90, 95))

    out = root / "inspiration" / f"{character}_inspiration_sheet.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out, quality=96)
    print(out)


def catalog(root: Path, characters):
    sheets = []
    for char in characters:
        p = root / "inspiration" / f"{char}_inspiration_sheet.png"
        if p.exists():
            sheets.append((char, Image.open(p).convert("RGB")))
    if not sheets:
        raise SystemExit("Aucune planche disponible.")
    width = 1600
    resized = []
    for char, im in sheets:
        h = round(im.height * width / im.width)
        resized.append((char, im.resize((width, h), Image.Resampling.LANCZOS)))
    total_h = sum(im.height for _, im in resized) + 34 * (len(resized) - 1)
    canvas = Image.new("RGB", (width, total_h), (12, 14, 17))
    y = 0
    for _, im in resized:
        canvas.paste(im, (0, y)); y += im.height + 34
    out = root / "inspiration" / "hellcorp_three_characters.png"
    canvas.save(out, quality=95)
    print(out)


def record(root: Path, character: str, kind: str, output: Path, prompt: str, seed: int, model: str, quantize: int, reference: str = ""):
    manifest_path = root / "characters" / character / "manifest.json"
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        data = {"character": character, "created_at": now_iso(), "assets": []}
    item = {
        "kind": kind,
        "file": str(output.relative_to(root)) if output.is_relative_to(root) else str(output),
        "sha256": sha256(output) if output.exists() else None,
        "prompt": prompt,
        "seed": seed,
        "model": model,
        "quantize": quantize,
        "reference": reference,
        "generated_at": now_iso(),
    }
    data["assets"] = [x for x in data.get("assets", []) if x.get("file") != item["file"]]
    data["assets"].append(item)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("init"); a.add_argument("--root", required=True)
    a = sub.add_parser("field"); a.add_argument("--root", required=True); a.add_argument("--character", required=True); a.add_argument("--field", required=True)
    a = sub.add_parser("pose"); a.add_argument("--pose", required=True); a.add_argument("--field", required=True)
    a = sub.add_parser("normalize"); a.add_argument("--input", required=True); a.add_argument("--output", required=True); a.add_argument("--height", type=int, required=True); a.add_argument("--cell", type=int, required=True); a.add_argument("--colors", type=int, required=True); a.add_argument("--outline", type=int, default=1)
    a = sub.add_parser("sheet"); a.add_argument("--root", required=True); a.add_argument("--character", required=True)
    a = sub.add_parser("catalog"); a.add_argument("--root", required=True); a.add_argument("--characters", nargs="+", required=True)
    a = sub.add_parser("record"); a.add_argument("--root", required=True); a.add_argument("--character", required=True); a.add_argument("--kind", required=True); a.add_argument("--output", required=True); a.add_argument("--prompt", required=True); a.add_argument("--seed", type=int, required=True); a.add_argument("--model", required=True); a.add_argument("--quantize", type=int, required=True); a.add_argument("--reference", default="")

    args = p.parse_args()
    if args.cmd == "init":
        init_root(Path(args.root)); print(Path(args.root))
    elif args.cmd == "field":
        cfg = load_cfg(Path(args.root));
        if args.character not in cfg: raise SystemExit(f"Personnage inconnu: {args.character}")
        value = cfg[args.character].get(args.field)
        if isinstance(value, (dict, list)): print(json.dumps(value, ensure_ascii=False))
        else: print(value)
    elif args.cmd == "pose":
        if args.pose not in POSES: raise SystemExit(f"Pose inconnue: {args.pose}")
        print(POSES[args.pose].get(args.field, ""))
    elif args.cmd == "normalize":
        normalize_sprite(Path(args.input), Path(args.output), args.height, args.cell, args.cell, args.colors, args.outline)
    elif args.cmd == "sheet":
        sheet(Path(args.root), args.character)
    elif args.cmd == "catalog":
        catalog(Path(args.root), args.characters)
    elif args.cmd == "record":
        record(Path(args.root), args.character, args.kind, Path(args.output), args.prompt, args.seed, args.model, args.quantize, args.reference)

if __name__ == "__main__":
    main()
PY
  chmod +x "$HELPER"
}

setup_pipeline() {
  ensure_macos_arm
  mkdir -p "$AI_ROOT" "$HF_HOME_DIR" "$MFLUX_CACHE" "$OUTPUT_ROOT" "$GUIDE_ROOT" "$INSPIRATION_ROOT"
  local uv
  uv="$(install_uv)"
  log "Creation de l'environnement Python isole."
  if [ ! -x "$PY" ]; then
    "$uv" venv --python 3.12 "$VENV"
  fi
  log "Installation de MFLUX, Pillow et Hugging Face CLI."
  "$uv" pip install --python "$PY" --upgrade mflux pillow "huggingface_hub>=0.34" hf_transfer
  write_helper
  "$PY" "$HELPER" init --root "$AI_ROOT" >/dev/null
  "$PY" -m pip freeze > "$AI_ROOT/config/requirements.lock.txt" 2>/dev/null || true
  ok "Installation terminee dans $AI_ROOT"
  status_pipeline
}

auth_hf() {
  require_setup
  if [ -x "$BIN/hf" ]; then
    "$BIN/hf" auth login
  elif [ -x "$BIN/huggingface-cli" ]; then
    "$BIN/huggingface-cli" login
  else
    die "CLI Hugging Face introuvable. Relance setup."
  fi
  warn "Accepte aussi les conditions du modele FLUX.2 Klein 4B sur Hugging Face si un acces est demande."
}

common_args() {
  COMMON_ARGS=(
    --model "$MODEL"
    --steps "$STEPS"
    --quantize "$QUANTIZE"
    --metadata
  )
  if low_ram_needed; then
    COMMON_ARGS+=(--low-ram)
  fi
  if [ -n "${HC_MLX_CACHE_LIMIT_GB:-}" ]; then
    COMMON_ARGS+=(--mlx-cache-limit-gb "$HC_MLX_CACHE_LIMIT_GB")
  fi
  if [ -n "$STYLE_LORA" ]; then
    COMMON_ARGS+=(--lora-paths "$STYLE_LORA" --lora-scales "$STYLE_LORA_SCALE")
  fi
}

run_txt2img() {
  local prompt="$1" seed="$2" width="$3" height="$4" output="$5"
  require_setup
  mkdir -p "$(dirname "$output")"
  common_args
  "$BIN/mflux-generate-flux2" \
    "${COMMON_ARGS[@]}" \
    --prompt "$prompt" \
    --seed "$seed" \
    --width "$width" \
    --height "$height" \
    --output "$output"
}

run_edit() {
  local reference="$1" guide="$2" prompt="$3" seed="$4" width="$5" height="$6" output="$7"
  require_setup
  [ -f "$reference" ] || die "Reference absente: $reference"
  mkdir -p "$(dirname "$output")"
  common_args
  IMAGE_ARGS=(--image-paths "$reference")
  if [ -n "$guide" ] && [ -f "$guide" ]; then
    IMAGE_ARGS+=("$guide")
  fi
  "$BIN/mflux-generate-flux2-edit" \
    "${COMMON_ARGS[@]}" \
    "${IMAGE_ARGS[@]}" \
    --prompt "$prompt" \
    --seed "$seed" \
    --width "$width" \
    --height "$height" \
    --output "$output"
}

record_asset() {
  local char="$1" kind="$2" output="$3" prompt="$4" seed="$5" reference="${6:-}"
  "$PY" "$HELPER" record \
    --root "$AI_ROOT" \
    --character "$char" \
    --kind "$kind" \
    --output "$output" \
    --prompt "$prompt" \
    --seed "$seed" \
    --model "$MODEL" \
    --quantize "$QUANTIZE" \
    --reference "$reference"
}

field() {
  "$PY" "$HELPER" field --root "$AI_ROOT" --character "$1" --field "$2"
}

validate_character() {
  require_setup
  field "$1" age >/dev/null
}

master_prompt() {
  local description="$1"
  printf "%s" "Korean webtoon (manhwa) digital illustration for a mature adult dark-corporate series. One single fictional adult woman only. ${description}. Full body from head to shoes, straight front three-quarter presentation stance, feet fully visible, anatomically coherent hands, readable silhouette. Confident clean digital linework with variable line weight, bold outer contour, fine controlled interior detail lines. Dramatic painted cel shading, directional rim light, glossy specular highlights on hair and eyes, controlled skin sheen with visible texture and grain, never flat or uniform. Detailed rendered eyes with catchlights, distinct facial structure specific to this character, no interchangeable generic face. Sensual confident posture and expression, alluring but fully and professionally dressed corporate styling, subtle infernal atmosphere. Rich saturated color grading, strong signature color accents matching the character palette. Neutral warm dark studio background, single dramatic light source. No text, no labels, no logo, no watermark, no signature, no ornamental border, no card frame, no fantasy armor, no wings, no tail, no extra person, no duplicate body, no cropped feet, no exaggerated perspective, no photorealistic render, no 3D render, no flat uniform airbrushed skin, no symmetric mirrored face, no vacant expression, no generic default AI face."
}

make_master() {
  local char="$1"
  validate_character "$char"
  local base="$OUTPUT_ROOT/$char" out="$OUTPUT_ROOT/$char/master/master.png"
  local desc seed prompt
  desc="$(field "$char" description)"
  seed="$(field "$char" seed)"
  prompt="$(master_prompt "$desc")"
  mkdir -p "$base/master" "$base/archive"
  if [ -f "$out" ] && [ "$FORCE" != "1" ]; then
    ok "Master verrouille deja present: $out"
    return
  fi
  if [ -f "$out" ]; then
    cp "$out" "$base/archive/master_$(date +%Y%m%d_%H%M%S).png"
  fi
  log "Generation du master canonique de $char."
  run_txt2img "$prompt" "$seed" "$MASTER_W" "$MASTER_H" "$out"
  record_asset "$char" "master" "$out" "$prompt" "$seed"
  ok "Master: $out"
}

promote_master() {
  local char="$1" source="$2"
  validate_character "$char"
  [ -f "$source" ] || die "Image source absente: $source"
  local base="$OUTPUT_ROOT/$char" out="$OUTPUT_ROOT/$char/master/master.png"
  mkdir -p "$base/master" "$base/archive"
  if [ -f "$out" ]; then
    cp "$out" "$base/archive/master_$(date +%Y%m%d_%H%M%S).png"
  fi
  cp "$source" "$out"
  local seed
  seed="$(field "$char" seed)"
  record_asset "$char" "master_promoted" "$out" "Master approuve manuellement" "$seed" "$source"
  ok "Master promu: $out"
}

make_portrait() {
  local char="$1"
  validate_character "$char"
  make_master "$char"
  local master="$OUTPUT_ROOT/$char/master/master.png" out="$OUTPUT_ROOT/$char/portrait/portrait.png"
  local desc seed prompt
  desc="$(field "$char" description)"
  seed="$(( $(field "$char" seed) + 100 ))"
  prompt="Image 1 is the canonical identity and costume. Create a waist-up dialogue portrait of the exact same fictional adult woman: ${desc}. Preserve exact face geometry, eye color, hairstyle, body proportions, outfit colors, jewelry and badge. Neutral confident sensual expression, shoulders visible, hands outside frame. Korean webtoon digital portrait style: clean confident linework with variable weight, dramatic painted cel shading, glossy hair and eye highlights, visible skin texture, rich color grading, single directional light source, warm dark background. No text, no logo, no redesign, no second person, no flat plastic skin, no generic AI face."
  if [ -f "$out" ] && [ "$FORCE" != "1" ]; then
    ok "Portrait deja present: $out"
    return
  fi
  log "Generation du portrait de $char."
  run_edit "$master" "" "$prompt" "$seed" "$EDIT_W" "$EDIT_H" "$out"
  record_asset "$char" "portrait" "$out" "$prompt" "$seed" "$master"
}

make_expressions() {
  local char="$1"
  validate_character "$char"
  make_portrait "$char"
  local ref="$OUTPUT_ROOT/$char/portrait/portrait.png" desc base_seed
  desc="$(field "$char" description)"
  base_seed="$(field "$char" seed)"
  mkdir -p "$OUTPUT_ROOT/$char/expressions"
  while IFS='|' read -r name offset expression; do
    [ -n "$name" ] || continue
    local out="$OUTPUT_ROOT/$char/expressions/$name.png"
    local seed="$((base_seed + offset))"
    local prompt="Image 1 is the canonical portrait. Render the exact same fictional adult woman, same face, same hair, same outfit, same camera framing, same manhwa linework and cel-shaded rendering. Change only the facial expression to: ${expression}. Keep head angle, lighting and line style stable. No text, no redesign, no second person, no generic AI face. Character description: ${desc}."
    if [ -f "$out" ] && [ "$FORCE" != "1" ]; then
      continue
    fi
    log "Expression $char/$name"
    run_edit "$ref" "" "$prompt" "$seed" "$EDIT_W" "$EDIT_H" "$out"
    record_asset "$char" "expression:$name" "$out" "$prompt" "$seed" "$ref"
  done <<'EOF'
neutral|201|neutral attentive expression
confident|202|subtle confident smile
amused|203|restrained amused smile
annoyed|204|professionally annoyed expression
worried|205|controlled worried expression
cold_glare|206|cold disapproving glare
EOF
  ok "Expressions terminees pour $char."
}

quick_pose_list() {
  cat <<'EOF'
idle_front|301
idle_back|302
idle_left|303
idle_right|304
walk_left_a|311
walk_left_b|312
walk_left_c|313
talk|321
present|322
sit|323
EOF
}

full_pose_list() {
  cat <<'EOF'
idle_front|301
idle_back|302
idle_left|303
idle_right|304
walk_front_a|305
walk_front_b|306
walk_front_c|307
walk_back_a|308
walk_back_b|309
walk_back_c|310
walk_left_a|311
walk_left_b|312
walk_left_c|313
walk_right_a|314
walk_right_b|315
walk_right_c|316
talk|321
present|322
sit|323
use_pc|324
EOF
}

make_world() {
  local char="$1" mode="${2:-$WORLD_SET}"
  validate_character "$char"
  make_master "$char"
  [ "$mode" = "quick" ] || [ "$mode" = "full" ] || die "Mode world: quick ou full."
  local master="$OUTPUT_ROOT/$char/master/master.png" desc base_seed
  desc="$(field "$char" description)"
  base_seed="$(field "$char" seed)"
  mkdir -p "$OUTPUT_ROOT/$char/world/raw" "$OUTPUT_ROOT/$char/world/sprites"
  local list_cmd="quick_pose_list"
  [ "$mode" = "full" ] && list_cmd="full_pose_list"

  "$list_cmd" | while IFS='|' read -r pose offset; do
    [ -n "$pose" ] || continue
    local raw="$OUTPUT_ROOT/$char/world/raw/$pose.png"
    local sprite="$OUTPUT_ROOT/$char/world/sprites/$pose.png"
    local guide="$GUIDE_ROOT/$pose.png"
    local view pose_text seed prompt
    view="$($PY "$HELPER" pose --pose "$pose" --field view)"
    pose_text="$($PY "$HELPER" pose --pose "$pose" --field pose)"
    seed="$((base_seed + offset))"
    prompt="Image 1 is the canonical adult character identity and outfit. Image 2 is a pose guide only for proportions; do not copy its drawing style. Render the exact same fictional adult woman: ${desc}. Korean webtoon 2D game world sprite concept, ${view}, ${pose_text}. Full body and shoes fully visible, one character only, fixed proportions, clean readable silhouette, confident bold outline, simplified hair masses with a clear shape read, simplified jewelry, simplified clothing folds, cel shading pulled back toward flat tones for small-size legibility, no cinematic lighting, no cast shadow, no furniture unless required by the pose, warm neutral flat background, no text, no labels, no border, no duplicate limbs, no redesign, no photorealism, no 3D, no generic AI face."
    if [ ! -f "$raw" ] || [ "$FORCE" = "1" ]; then
      log "Sprite reference $char/$pose"
      run_edit "$master" "$guide" "$prompt" "$seed" "$WORLD_GEN_W" "$WORLD_GEN_H" "$raw"
      record_asset "$char" "world_raw:$pose" "$raw" "$prompt" "$seed" "$master"
    fi
    "$PY" "$HELPER" normalize \
      --input "$raw" \
      --output "$sprite" \
      --height "$WORLD_HEIGHT" \
      --cell "$WORLD_CELL" \
      --colors "$WORLD_COLORS" \
      --outline 1
  done
  ok "Sprites world exportes: $OUTPUT_ROOT/$char/world/sprites"
}

make_sheet() {
  local char="$1"
  validate_character "$char"
  "$PY" "$HELPER" sheet --root "$AI_ROOT" --character "$char"
}

upscale_splash() {
  local char="$1"
  validate_character "$char"
  make_master "$char"
  local input="$OUTPUT_ROOT/$char/master/master.png"
  local expected="$OUTPUT_ROOT/$char/master/master_upscaled.png"
  local out="$OUTPUT_ROOT/$char/splash/${char}_splash_2x.png"
  mkdir -p "$OUTPUT_ROOT/$char/splash"
  if [ -f "$out" ] && [ "$FORCE" != "1" ]; then
    ok "Splash upscale deja present: $out"
    return
  fi
  log "Upscale SeedVR2 2x pour le splash uniquement."
  UPSCALE_ARGS=(--image-path "$input" --resolution 2x --softness 0.35)
  if low_ram_needed; then
    UPSCALE_ARGS+=(--low-ram)
  fi
  "$BIN/mflux-upscale-seedvr2" "${UPSCALE_ARGS[@]}"
  [ -f "$expected" ] || die "Sortie SeedVR2 introuvable: $expected"
  mv "$expected" "$out"
  local seed prompt
  seed="$(field "$char" seed)"
  prompt="SeedVR2 faithful 2x upscale"
  record_asset "$char" "splash_upscaled" "$out" "$prompt" "$seed" "$input"
  ok "Splash: $out"
}

all_character() {
  local char="$1" mode="${2:-$WORLD_SET}"
  make_master "$char"
  make_portrait "$char"
  make_expressions "$char"
  make_world "$char" "$mode"
  if [ "$UPSCALE_SPLASH" = "1" ]; then
    upscale_splash "$char"
  fi
  make_sheet "$char"
}

make_inspiration() {
  require_setup
  local char
  for char in morrigan lucy malphas; do
    all_character "$char" quick
  done
  "$PY" "$HELPER" catalog --root "$AI_ROOT" --characters morrigan lucy malphas
  ok "Catalogue: $INSPIRATION_ROOT/hellcorp_three_characters.png"
}

download_model() {
  require_setup
  local test_dir="$AI_ROOT/download_test" out="$AI_ROOT/download_test/flux2_test.png"
  mkdir -p "$test_dir"
  log "Telechargement initial de FLUX.2 Klein 4B et test minimal."
  local prompt="A simple red geometric corporate emblem on a plain light background, no text."
  if ! run_txt2img "$prompt" 42 512 512 "$out"; then
    warn "Le telechargement a echoue. Lance auth et accepte les conditions du modele sur Hugging Face."
    exit 1
  fi
  ok "Modele disponible dans le cache: $HF_HOME_DIR"
}

train_style() {
  require_setup
  local lora_root="$SCRIPT_DIR/hellcorp_ai/style_lora"
  local cfg="$lora_root/train.json"
  local dataset="$lora_root/dataset"
  [ -f "$cfg" ] || die "Config introuvable: $cfg"
  local n
  n="$(find "$dataset" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) ! -iname 'preview*' | wc -l | tr -d ' ')"
  if [ "$n" -lt 1 ]; then
    die "Aucune image dans $dataset (hors preview*). Depose des paires image + legende .txt avant de lancer l'entrainement."
  fi
  log "Entrainement LoRA de style: $n image(s) de reference trouvees."
  ( cd "$lora_root" && HF_HOME="$HF_HOME_DIR" MFLUX_CACHE_DIR="$MFLUX_CACHE" "$BIN/mflux-train" --config train.json )
  ok "Sortie: $lora_root/output (checkpoints .zip, contenant NNNNNNN_adapter.safetensors)"
}

doctor() {
  printf "HELLCORP SPRITE PIPELINE — DOCTOR\n"
  printf "OS                : %s\n" "$(uname -s)"
  printf "Architecture      : %s\n" "$(uname -m)"
  printf "Puce              : %s\n" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo inconnue)"
  printf "Memoire unifiee   : %s Go\n" "$(memory_gb)"
  printf "Profil            : %s\n" "$PROFILE"
  printf "Quantification    : %s bits\n" "$QUANTIZE"
  printf "Modele            : %s\n" "$MODEL"
  printf "Racine AI         : %s\n" "$AI_ROOT"
  printf "Espace libre      : %s\n" "$(df -h "$SCRIPT_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || echo inconnu)"
  printf "uv                : %s\n" "$(find_uv 2>/dev/null || echo absent)"
  printf "MFLUX             : %s\n" "$([ -x "$BIN/mflux-generate-flux2" ] && echo installe || echo absent)"
  printf "Configuration     : %s\n" "$([ -f "$CONFIG" ] && echo presente || echo absente)"
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    warn "Machine non Apple Silicon."
  fi
  if [ "$(memory_gb)" -le 16 ]; then
    warn "16 Go ou moins: conserve HC_PROFILE=low et HC_QUANTIZE=4."
  fi
}

status_pipeline() {
  printf "\nConfiguration active\n"
  printf "  AI_ROOT          %s\n" "$AI_ROOT"
  printf "  MODEL            %s\n" "$MODEL"
  printf "  PROFILE          %s\n" "$PROFILE"
  printf "  MASTER           %sx%s\n" "$MASTER_W" "$MASTER_H"
  printf "  EDIT             %sx%s\n" "$EDIT_W" "$EDIT_H"
  printf "  WORLD RAW        %sx%s\n" "$WORLD_GEN_W" "$WORLD_GEN_H"
  printf "  WORLD EXPORT     %sx%s, personnage %spx\n" "$WORLD_CELL" "$WORLD_CELL" "$WORLD_HEIGHT"
  printf "  PALETTE          %s couleurs\n" "$WORLD_COLORS"
  printf "  QUANTIZE         %s bits\n" "$QUANTIZE"
  printf "  STYLE LORA       %s\n" "${STYLE_LORA:-aucune}"
  printf "\nSorties\n"
  printf "  %s\n" "$OUTPUT_ROOT"
  printf "  %s\n" "$INSPIRATION_ROOT"
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    help|-h|--help) usage ;;
    doctor) doctor ;;
    setup) setup_pipeline ;;
    auth) auth_hf ;;
    download) download_model ;;
    train-style) train_style ;;
    status) require_setup; status_pipeline ;;
    master) [ $# -ge 2 ] || die "master requiert un personnage"; make_master "$2" ;;
    promote) [ $# -ge 3 ] || die "promote requiert personnage + image"; promote_master "$2" "$3" ;;
    portrait) [ $# -ge 2 ] || die "portrait requiert un personnage"; make_portrait "$2" ;;
    expressions) [ $# -ge 2 ] || die "expressions requiert un personnage"; make_expressions "$2" ;;
    world) [ $# -ge 2 ] || die "world requiert un personnage"; make_world "$2" "${3:-$WORLD_SET}" ;;
    sheet) [ $# -ge 2 ] || die "sheet requiert un personnage"; make_sheet "$2" ;;
    upscale) [ $# -ge 2 ] || die "upscale requiert un personnage"; upscale_splash "$2" ;;
    all) [ $# -ge 2 ] || die "all requiert un personnage"; all_character "$2" "${3:-$WORLD_SET}" ;;
    inspiration) make_inspiration ;;
    *) usage; die "Commande inconnue: $cmd" ;;
  esac
}

main "$@"
