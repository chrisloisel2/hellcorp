#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$STUDIO_DIR"

VRM="test_assets/vrm/fem_vroid.vrm"
PROFILE="v4/characters/lucy.json"
PRESET="v4/presets/lucy_catwalk_organic.json"
OUT="v4_organic_output"
VIEW="front"
SIZE="512"
CYCLES="2"
FPS=""
NAME="lucy_catwalk_organic_v41"
BG="0x2b2320"

usage() {
  cat <<'EOF'
Usage: bash tools/run_organic_walk_cli.sh [options]

V4.1 organic-rig pipeline:
  build -> procedural gait -> phased torso/scapula rig -> elbow/wrist/finger lag
  -> inertial upper-body solver -> soft support-leg IK -> render -> MP4 + GIF

Options:
  --vrm PATH          VRM file
  --profile PATH      organic character profile
  --preset PATH       organic gait preset
  --out DIR           output directory
  --view NAME         front|threequarter|side|back
  --size N            output frame size (default: 512)
  --cycles N          cycles to render (default: 2)
  --fps N             override preset FPS
  --name NAME         output folder/name
  --bg HEX            preview background (default: 0x2b2320)
  -h, --help          show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vrm) VRM="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --preset) PRESET="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --view) VIEW="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --cycles) CYCLES="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --bg) BG="$2"; shift 2 ;;
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
[[ -f "$PRESET" ]] || { echo "Preset not found: $PRESET" >&2; exit 1; }

if [[ ! -d tools/node_modules/playwright ]]; then
  echo "Installing Playwright dependency..."
  (cd tools && npm install)
fi

python3 v4/build_v4.py

NODE_ARGS=(
  tools/render_organic_cli.mjs
  --vrm "$VRM"
  --profile "$PROFILE"
  --preset "$PRESET"
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

RAW_MP4="$RESULT_DIR/${NAME}.mp4"
RAW_GIF="$RESULT_DIR/${NAME}.gif"

ffmpeg -loglevel error -y \
  -framerate "$RENDER_FPS" -i "$FRAMES/frame_%06d.png" \
  -f lavfi -i "color=c=${BG}:s=${SIZE}x${SIZE}:r=${RENDER_FPS}" \
  -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p" \
  -c:v libx264 -crf 15 -preset medium "$RAW_MP4"

ffmpeg -loglevel error -y \
  -framerate "$RENDER_FPS" -i "$FRAMES/frame_%06d.png" \
  -f lavfi -i "color=c=${BG}:s=${SIZE}x${SIZE}:r=${RENDER_FPS}" \
  -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto[comp];[comp]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" \
  "$RAW_GIF"

echo "MP4=$RAW_MP4"
echo "GIF=$RAW_GIF"
echo "DONE=$RESULT_DIR"
