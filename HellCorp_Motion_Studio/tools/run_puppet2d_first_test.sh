#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$STUDIO_DIR/.." && pwd)"
MODE="${1:-walk}"

case "$MODE" in
  walk)
    FBX="$STUDIO_DIR/mixamo/animations/Female Walk.fbx"
    ROOT_MODE="detrend"
    DEFAULT_SAMPLES=16
    ;;
  greeting)
    FBX="$STUDIO_DIR/mixamo/animations/Standing Greeting.fbx"
    ROOT_MODE="preserve"
    DEFAULT_SAMPLES=24
    ;;
  phone)
    FBX="$STUDIO_DIR/mixamo/animations/Talking On Phone.fbx"
    ROOT_MODE="preserve"
    DEFAULT_SAMPLES=24
    ;;
  *)
    echo "Usage: bash tools/run_puppet2d_first_test.sh [walk|greeting|phone]" >&2
    exit 2
    ;;
esac

VRM="${VRM:-$STUDIO_DIR/test_assets/vrm/fem_vroid.vrm}"
ART="${ART:-$ROOT_DIR/sdxl_lora_bench/out/characters_summer_memories/lucy_pixel_art.png}"
CHARACTER="${CHARACTER:-$STUDIO_DIR/puppet2d/characters/lucy/character.json}"
SAMPLES="${SAMPLES:-$DEFAULT_SAMPLES}"
SIZE="${SIZE:-384}"
FPS="${FPS:-16}"
OUT="${OUT:-$STUDIO_DIR/puppet2d/output/lucy_${MODE}_front}"
POSE="$OUT/pose.json"
PYTHON="$STUDIO_DIR/puppet2d/.venv/bin/python"

for file in "$VRM" "$FBX" "$ART" "$CHARACTER"; do
  if [ ! -f "$file" ]; then
    echo "Missing required file: $file" >&2
    exit 1
  fi
done
if [ ! -x "$PYTHON" ]; then
  echo "Puppet2D virtualenv is missing. Run: bash tools/setup_puppet2d.sh" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

cd "$STUDIO_DIR"
node tools/export_puppet_pose_cli.mjs \
  --vrm "$VRM" \
  --fbx "$FBX" \
  --out "$POSE" \
  --view front \
  --samples "$SAMPLES" \
  --root-mode "$ROOT_MODE"

"$PYTHON" puppet2d/render_mesh.py \
  --character "$CHARACTER" \
  --pose "$POSE" \
  --art "$ART" \
  --out "$OUT" \
  --size "$SIZE" \
  --fps "$FPS" \
  --cols 4 \
  --palette-colors 96

"$PYTHON" puppet2d/validate_manifest.py "$OUT/manifest.json"

echo "PUPPET2D_FIRST_TEST_PASS"
echo "Preview:  $OUT/preview.gif"
echo "Atlas:    $OUT/atlas.png"
echo "Metadata: $OUT/atlas.json"
echo "Frames:   $OUT/frames"
