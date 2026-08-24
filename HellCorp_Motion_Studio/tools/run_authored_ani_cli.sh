#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$STUDIO_DIR"

VRM="test_assets/vrm/fem_vroid.vrm"
PROFILE="v3/characters/lucy.json"
CLIP="v3/clips/lucy_catwalk_front.json"
OUT="v3_authored_output"
VIEW="front"
SIZE="512"
CYCLES="1"
FPS=""
NAME=""
BG="0x2b2320"
DO_PIXEL=0
PIXEL_LOGICAL="128"
PIXEL_COLORS="32"

usage() {
  cat <<'EOF'
Usage: bash tools/run_authored_ani_cli.sh [options]

Complete authored animation pipeline, no MediaPipe/mocap:
  build V3 -> load VRM -> authored layered animation -> deterministic cel render
  -> GIF + MP4 preview

Options:
  --vrm PATH          VRM file
  --profile PATH      authored character profile JSON
  --clip PATH         authored clip JSON
  --out DIR           output directory
  --view NAME         front|threequarter|side|back
  --size N            output frame size (default 512)
  --cycles N          number of animation cycles to render
  --fps N             override clip FPS
  --name NAME         output folder/name
  --bg HEX            ffmpeg preview background, e.g. 0x2b2320
  --pixel             also build deterministic pixel-art preview
  --logical-size N    pixel logical size (default 128)
  --colors N          shared palette size (default 32)
  -h, --help          show help

Examples:
  bash tools/run_authored_ani_cli.sh

  bash tools/run_authored_ani_cli.sh --clip v3/clips/lucy_idle_ani.json --name lucy_idle_ani
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vrm) VRM="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --clip) CLIP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --view) VIEW="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --cycles) CYCLES="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --bg) BG="$2"; shift 2 ;;
    --pixel) DO_PIXEL=1; shift ;;
    --logical-size) PIXEL_LOGICAL="$2"; shift 2 ;;
    --colors) PIXEL_COLORS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

[[ -f "$VRM" ]] || { echo "VRM not found: $VRM" >&2; exit 1; }
[[ -f "$PROFILE" ]] || { echo "Profile not found: $PROFILE" >&2; exit 1; }
[[ -f "$CLIP" ]] || { echo "Clip not found: $CLIP" >&2; exit 1; }

if [[ -z "$NAME" ]]; then
  PROFILE_STEM="$(basename "$PROFILE" .json)"
  CLIP_STEM="$(basename "$CLIP" .json)"
  NAME="${PROFILE_STEM}_${CLIP_STEM}_${VIEW}"
fi

if [[ ! -d tools/node_modules/playwright ]]; then
  echo "Installing Playwright..."
  (cd tools && npm install)
fi

python3 v3/build_v3.py

NODE_ARGS=(
  tools/render_authored_cli.mjs
  --vrm "$VRM"
  --profile "$PROFILE"
  --clip "$CLIP"
  --out "$OUT"
  --view "$VIEW"
  --size "$SIZE"
  --cycles "$CYCLES"
  --name "$NAME"
)
if [[ -n "$FPS" ]]; then NODE_ARGS+=(--fps "$FPS"); fi

node "${NODE_ARGS[@]}"

RESULT_DIR="$OUT/$NAME"
FRAMES="$RESULT_DIR/frames"
MANIFEST="$RESULT_DIR/manifest.json"
[[ -d "$FRAMES" ]] || { echo "Frames missing: $FRAMES" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "Manifest missing: $MANIFEST" >&2; exit 1; }

RENDER_FPS="$(python3 - "$MANIFEST" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    print(json.load(f)['fps'])
PY
)"

RAW_GIF="$RESULT_DIR/${NAME}.gif"
RAW_MP4="$RESULT_DIR/${NAME}.mp4"

# Composite alpha over the HellCorp background before GIF palette creation.
# This avoids the neon-green transparency artifacts some GIF viewers display.
ffmpeg -loglevel error -y \
  -framerate "$RENDER_FPS" -i "$FRAMES/frame_%06d.png" \
  -f lavfi -i "color=c=${BG}:s=${SIZE}x${SIZE}:r=${RENDER_FPS}" \
  -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto[comp];[comp]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" \
  "$RAW_GIF"

ffmpeg -loglevel error -y \
  -framerate "$RENDER_FPS" -i "$FRAMES/frame_%06d.png" \
  -f lavfi -i "color=c=${BG}:s=${SIZE}x${SIZE}:r=${RENDER_FPS}" \
  -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p" \
  -c:v libx264 -crf 16 -preset medium "$RAW_MP4"

echo "GIF=$RAW_GIF"
echo "MP4=$RAW_MP4"

if [[ "$DO_PIXEL" -eq 1 ]]; then
  python3 -c 'from PIL import Image' 2>/dev/null || {
    echo "Pillow is required for --pixel. Install with: python3 -m pip install pillow" >&2
    exit 1
  }
  PIXEL_FRAMES="$RESULT_DIR/pixel_frames"
  python3 tools/deterministic_pixel.py \
    --in "$FRAMES" \
    --out "$PIXEL_FRAMES" \
    --logical-size "$PIXEL_LOGICAL" \
    --output-size "$SIZE" \
    --colors "$PIXEL_COLORS"

  PIXEL_GIF="$RESULT_DIR/${NAME}_pixel.gif"
  ffmpeg -loglevel error -y \
    -framerate "$RENDER_FPS" -i "$PIXEL_FRAMES/frame_%06d.png" \
    -f lavfi -i "color=c=${BG}:s=${SIZE}x${SIZE}:r=${RENDER_FPS}" \
    -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto[comp];[comp]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none" \
    "$PIXEL_GIF"
  echo "PIXEL_GIF=$PIXEL_GIF"
fi

echo "DONE=$RESULT_DIR"
