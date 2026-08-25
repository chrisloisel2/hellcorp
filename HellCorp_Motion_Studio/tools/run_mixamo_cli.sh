#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$STUDIO_DIR"

VRM="test_assets/vrm/fem_vroid.vrm"
FBX=""
FBX_DIR=""
OUT="v5_mixamo_output"
VIEWS="front"
SIZE="768"
FPS="30"
CLIP="0"
ROOT_MODE="inplace"
ROTATION_STRENGTH="1.0"
ROOT_STRENGTH="1.0"
START=""
END=""
PRE_ROLL=""
MAKE_GIF=0

usage() {
  cat <<'EOF'
Usage:
  bash tools/run_mixamo_cli.sh --fbx "/path/Animation.fbx" [options]
  bash tools/run_mixamo_cli.sh --fbx-dir "/path/to/mixamo" [options]

Production V5:
  Mixamo FBX -> rest-pose calibrated retarget -> VRM -> clean supersampled PNG frames -> MP4

Options:
  --vrm PATH                target VRM (default: test_assets/vrm/fem_vroid.vrm)
  --fbx PATH                one Mixamo FBX
  --fbx-dir DIR             batch every *.fbx in a directory
  --out DIR                 output root (default: v5_mixamo_output)
  --views CSV               front,threequarter,side,back (default: front)
  --size N                  PNG size (default: 768)
  --fps N                   export FPS (default: 30)
  --clip NAME_OR_INDEX      FBX animation clip (default: 0)
  --root-mode MODE          inplace|full|horizontal|locked (default: inplace)
  --rotation-strength N     retarget rotation strength (default: 1.0)
  --root-strength N         root translation strength (default: 1.0)
  --start SECONDS           optional trim start
  --end SECONDS             optional trim end
  --pre-roll FRAMES         spring-bone preroll
  --gif                     also create a convenience GIF
  -h, --help                show help

Examples:
  bash tools/run_mixamo_cli.sh \
    --fbx "/Users/me/Downloads/Talking On Phone.fbx"

  bash tools/run_mixamo_cli.sh \
    --fbx-dir "/Users/me/Downloads/mixamo" \
    --views front,threequarter,side,back \
    --size 768 \
    --fps 30
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vrm) VRM="$2"; shift 2 ;;
    --fbx) FBX="$2"; shift 2 ;;
    --fbx-dir) FBX_DIR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --views) VIEWS="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --clip) CLIP="$2"; shift 2 ;;
    --root-mode) ROOT_MODE="$2"; shift 2 ;;
    --rotation-strength) ROTATION_STRENGTH="$2"; shift 2 ;;
    --root-strength) ROOT_STRENGTH="$2"; shift 2 ;;
    --start) START="$2"; shift 2 ;;
    --end) END="$2"; shift 2 ;;
    --pre-roll) PRE_ROLL="$2"; shift 2 ;;
    --gif) MAKE_GIF=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

[[ -f "$VRM" ]] || { echo "VRM not found: $VRM" >&2; exit 1; }
if [[ -n "$FBX" && -n "$FBX_DIR" ]]; then
  echo "Use either --fbx or --fbx-dir, not both." >&2
  exit 2
fi
if [[ -z "$FBX" && -z "$FBX_DIR" ]]; then
  echo "--fbx or --fbx-dir is required." >&2
  usage >&2
  exit 2
fi
if [[ -n "$FBX" && ! -f "$FBX" ]]; then
  echo "FBX not found: $FBX" >&2
  exit 1
fi
if [[ -n "$FBX_DIR" && ! -d "$FBX_DIR" ]]; then
  echo "FBX directory not found: $FBX_DIR" >&2
  exit 1
fi

case "$ROOT_MODE" in
  inplace|vertical|full|horizontal|locked) ;;
  *) echo "Invalid --root-mode: $ROOT_MODE" >&2; exit 2 ;;
esac

if [[ ! -d tools/node_modules/playwright ]]; then
  echo "Installing Playwright dependency..."
  (cd tools && npm install)
fi

python3 v5/build_v5.py
mkdir -p "$OUT"

safe_stem() {
  local name
  name="$(basename "$1")"
  name="${name%.*}"
  printf '%s' "$name" | sed 's/[^a-zA-Z0-9._-]/_/g; s/^_*//; s/_*$//'
}

vrm_stem="$(safe_stem "$VRM")"

render_one() {
  local fbx="$1"
  local view="$2"
  local fbx_stem name result_dir render_fps
  fbx_stem="$(safe_stem "$fbx")"
  name="${vrm_stem}_${fbx_stem}_${view}"
  result_dir="$OUT/$name"

  echo
  echo "=== MIXAMO: $(basename "$fbx") | view=$view ==="

  local args=(
    tools/render_mixamo_cli.mjs
    --vrm "$VRM"
    --fbx "$fbx"
    --out "$OUT"
    --view "$view"
    --size "$SIZE"
    --fps "$FPS"
    --clip "$CLIP"
    --root-mode "$ROOT_MODE"
    --rotation-strength "$ROTATION_STRENGTH"
    --root-strength "$ROOT_STRENGTH"
    --name "$name"
  )
  if [[ -n "$START" ]]; then args+=(--start "$START"); fi
  if [[ -n "$END" ]]; then args+=(--end "$END"); fi
  if [[ -n "$PRE_ROLL" ]]; then args+=(--pre-roll "$PRE_ROLL"); fi

  node "${args[@]}"

  [[ -f "$result_dir/manifest.json" ]] || {
    echo "Missing manifest: $result_dir/manifest.json" >&2
    exit 1
  }
  [[ -d "$result_dir/frames" ]] || {
    echo "Missing frames: $result_dir/frames" >&2
    exit 1
  }

  render_fps="$(python3 - "$result_dir/manifest.json" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f)["fps"])
PY
)"

  ffmpeg -loglevel error -y \
    -framerate "$render_fps" \
    -i "$result_dir/frames/frame_%06d.png" \
    -f lavfi -i "color=c=0x2b2320:s=${SIZE}x${SIZE}:r=${render_fps}" \
    -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p" \
    -c:v libx264 -crf 14 -preset medium \
    "$result_dir/$name.mp4"

  echo "MP4=$result_dir/$name.mp4"
  echo "FRAMES=$result_dir/frames"

  if [[ "$MAKE_GIF" -eq 1 ]]; then
    ffmpeg -loglevel error -y \
      -framerate "$render_fps" \
      -i "$result_dir/frames/frame_%06d.png" \
      -f lavfi -i "color=c=0x2b2320:s=${SIZE}x${SIZE}:r=${render_fps}" \
      -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto[comp];[comp]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" \
      "$result_dir/$name.gif"
    echo "GIF=$result_dir/$name.gif"
  fi
}

OLD_IFS="$IFS"
IFS=',' read -r -a VIEW_LIST <<< "$VIEWS"
IFS="$OLD_IFS"

render_fbx_all_views() {
  local fbx="$1"
  local view
  for view in "${VIEW_LIST[@]}"; do
    render_one "$fbx" "$view"
  done
}

if [[ -n "$FBX" ]]; then
  render_fbx_all_views "$FBX"
else
  found=0
  while IFS= read -r -d '' fbx_file; do
    found=1
    render_fbx_all_views "$fbx_file"
  done < <(find "$FBX_DIR" -type f \( -iname '*.fbx' \) -print0 | sort -z)
  if [[ "$found" -eq 0 ]]; then
    echo "No .fbx files found in: $FBX_DIR" >&2
    exit 1
  fi
fi

echo
echo "DONE=$OUT"
