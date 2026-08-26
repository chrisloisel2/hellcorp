#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-walk}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VRM="${VRM:-test_assets/vrm/fem_vroid.vrm}"
SIZE3D="${SIZE3D:-768}"
OUT_SIZE="${SIZE:-384}"
FPS="${FPS:-16}"
PALETTE_COLORS="${PALETTE_COLORS:-96}"
COLS="${COLS:-4}"

case "$ACTION" in
  walk)
    FBX="${FBX:-mixamo/animations/Female Walk.fbx}"
    NAME="lucy_walk_front"
    ;;
  greeting)
    FBX="${FBX:-mixamo/animations/Standing Greeting.fbx}"
    NAME="lucy_greeting_front"
    ;;
  phone)
    FBX="${FBX:-mixamo/animations/Talking On Phone.fbx}"
    NAME="lucy_phone_front"
    ;;
  *)
    echo "Unknown action: $ACTION"
    exit 1
    ;;
esac

CHARACTER="${CHARACTER:-lucy}"
case "$CHARACTER" in
  lucy)
    REFERENCE="${REFERENCE:-../sdxl_lora_bench/out/characters_summer_memories/lucy_pixel_art.png}"
    ;;
  malphas)
    REFERENCE="${REFERENCE:-../sdxl_lora_bench/out/characters_summer_memories/malphas_pixel_art.png}"
    ;;
  morrigan)
    REFERENCE="${REFERENCE:-../sdxl_lora_bench/out/characters_summer_memories/morrigan_pixel_art.png}"
    ;;
  *)
    echo "Unknown character: $CHARACTER"
    exit 1
    ;;
esac

RAW_OUT="mixamo_clean_output/${NAME}_raw"
FINAL_OUT="vrm2sprite/output/${NAME}"

rm -rf "$RAW_OUT" "$FINAL_OUT"

node tools/render_mixamo_clean_cli.mjs \
  --vrm "$VRM" \
  --fbx "$FBX" \
  --out mixamo_clean_output \
  --view front \
  --size "$SIZE3D" \
  --fps "$FPS" \
  --root-mode preserve \
  --name "${NAME}_raw"

source vrm2sprite/.venv/bin/activate
python vrm2sprite/pixelize_frames.py \
  --frames "${RAW_OUT}/frames" \
  --reference "$REFERENCE" \
  --out "$FINAL_OUT" \
  --size "$OUT_SIZE" \
  --fps "$FPS" \
  --cols "$COLS" \
  --palette-colors "$PALETTE_COLORS"

python vrm2sprite/validate_manifest.py "${FINAL_OUT}/manifest.json"

echo "VRM2SPRITE_FIRST_TEST_PASS"
echo "Preview GIF: ${FINAL_OUT}/preview.gif"
echo "Atlas: ${FINAL_OUT}/atlas.png"
