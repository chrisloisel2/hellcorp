#!/usr/bin/env bash
# Pipeline complet HellCorp Motion Studio "ameliore" : rendu VRM+mocap (CLI
# headless) -> upscale/refine SeedVR2 de chaque frame -> reconstruction des
# atlas Godot a la nouvelle resolution. Tout tourne en local (MLX/M3).
#
# Usage:
#   ./build_enhanced_set.sh --vrm <fichier.vrm> --body <video.mp4> \
#     [--face <video.mp4>] --out <dossier> [--fps-mode body] \
#     [--resolution 2x] [--softness 0.35] [--seed 42]
set -euo pipefail
cd "$(dirname "$0")"

VRM="" BODY="" FACE="" OUT="" FPS_MODE="body"
RESOLUTION="2x" SOFTNESS="0.35" SEED="42"

while [ $# -gt 0 ]; do
  case "$1" in
    --vrm) VRM="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --face) FACE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --fps-mode) FPS_MODE="$2"; shift 2 ;;
    --resolution) RESOLUTION="$2"; shift 2 ;;
    --softness) SOFTNESS="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    *) echo "Option inconnue: $1" >&2; exit 1 ;;
  esac
done
[ -n "$VRM" ] && [ -n "$BODY" ] && [ -n "$OUT" ] || {
  echo "Usage: $0 --vrm <fichier.vrm> --body <video.mp4> [--face <video.mp4>] --out <dossier>" >&2
  exit 1
}

RAW_DIR="$OUT/raw"
ENHANCED_DIR="$OUT/enhanced"
PY="../../hellcorp_ai/runtime/mflux-venv/bin/python3"

echo "== 1/3 Rendu VRM + mocap =="
FACE_ARGS=()
[ -n "$FACE" ] && FACE_ARGS=(--face "$FACE")
node render_cli.mjs --vrm "$VRM" --body "$BODY" "${FACE_ARGS[@]}" --out "$RAW_DIR" --fps-mode "$FPS_MODE"

CLIP_DIR=$(find "$RAW_DIR" -mindepth 2 -maxdepth 2 -type d | head -1)
FPS=$(python3 -c "import json;print(json.load(open('$CLIP_DIR/clip.json'))['fps'])")
echo "Clip: $CLIP_DIR (fps=$FPS)"

for view_dir in "$CLIP_DIR"/*/; do
  view=$(basename "$view_dir")
  [ -d "$view_dir/frames" ] || continue
  echo "== 2/3 Enhance ($view) =="
  "$PY" enhance_frames.py --in "$view_dir/frames" --out "$ENHANCED_DIR/$view/frames" \
    --resolution "$RESOLUTION" --softness "$SOFTNESS" --seed "$SEED"
  echo "== 3/3 Atlas ($view) =="
  "$PY" rebuild_atlas.py --frames "$ENHANCED_DIR/$view/frames" --out "$ENHANCED_DIR/$view" \
    --view "$view" --fps "$FPS"
done

cp "$CLIP_DIR/clip.json" "$ENHANCED_DIR/clip.json" 2>/dev/null || true
echo "Termine. Frames + atlas ameliores dans: $ENHANCED_DIR"
