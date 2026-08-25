#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$STUDIO_DIR"

VRM="test_assets/vrm/fem_vroid.vrm"
FBX=""
OUT="mixamo_clean_output"
VIEW="front"
SIZE="768"
FPS="30"
ROOT_MODE="preserve"
CLIP=""
START=""
END=""
NAME=""
BG="0x2b2320"

usage() {
  cat <<'EOF'
Usage: bash tools/run_mixamo_clean_cli.sh --fbx PATH [options]

Clean Mixamo -> VRM validation pipeline.
No MediaPipe. No procedural animation. No IK. No pixel-art. No toon post-FX.
The retarget math follows the official pixiv/three-vrm normalized-bone method.

Options:
  --fbx PATH                    Mixamo animation FBX (required)
  --vrm PATH                    target VRM
  --out DIR                     output root (default: mixamo_clean_output)
  --view NAME                   front|threequarter|side|back
  --size N                      frame size (default: 768)
  --fps N                       export FPS (default: 30)
  --root-mode MODE              preserve|detrend|lock-horizontal
  --clip INDEX_OR_NAME          select FBX animation clip
  --start SEC                   trim start
  --end SEC                     trim end
  --name NAME                   output folder/name
  --bg HEX                      MP4 background (default: 0x2b2320)
  -h, --help                    show help

For the first validation use --root-mode preserve. That keeps the original
Mixamo hips translation and is the least destructive way to verify retargeting.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fbx) FBX="$2"; shift 2 ;;
    --vrm) VRM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --view) VIEW="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --root-mode) ROOT_MODE="$2"; shift 2 ;;
    --clip) CLIP="$2"; shift 2 ;;
    --start) START="$2"; shift 2 ;;
    --end) END="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --bg) BG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$FBX" ]] || { echo "--fbx is required" >&2; usage >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[[ -f "$VRM" ]] || { echo "VRM not found: $VRM" >&2; exit 1; }
[[ -f "$FBX" ]] || { echo "FBX not found: $FBX" >&2; exit 1; }

if [[ ! -d tools/node_modules/playwright || ! -d tools/node_modules/three || ! -d tools/node_modules/@pixiv/three-vrm ]]; then
  echo "Installing pinned Mixamo clean runtime dependencies..."
  (cd tools && npm install && npx playwright install chromium)
fi

if [[ -z "$NAME" ]]; then
  NAME="$(python3 - "$VRM" "$FBX" "$VIEW" <<'PY'
import os, re, sys
parts = [os.path.splitext(os.path.basename(p))[0] for p in sys.argv[1:3]] + [sys.argv[3]]
name = '_'.join(parts)
name = re.sub(r'[^A-Za-z0-9._-]+', '_', name).strip('_')
print(name or 'mixamo_clean')
PY
)"
fi

NODE_ARGS=(
  tools/render_mixamo_clean_cli.mjs
  --vrm "$VRM"
  --fbx "$FBX"
  --out "$OUT"
  --view "$VIEW"
  --size "$SIZE"
  --fps "$FPS"
  --root-mode "$ROOT_MODE"
  --name "$NAME"
)
[[ -n "$CLIP" ]] && NODE_ARGS+=(--clip "$CLIP")
[[ -n "$START" ]] && NODE_ARGS+=(--start "$START")
[[ -n "$END" ]] && NODE_ARGS+=(--end "$END")

node "${NODE_ARGS[@]}"

RESULT_DIR="$OUT/$NAME"
FRAMES="$RESULT_DIR/frames"
MANIFEST="$RESULT_DIR/manifest.json"
[[ -d "$FRAMES" ]] || { echo "Frames missing: $FRAMES" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "Manifest missing: $MANIFEST" >&2; exit 1; }

python3 - "$MANIFEST" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    m = json.load(f)
validation = m.get('validation', {})
if validation.get('status') != 'PASS':
    raise SystemExit('Retarget validation did not PASS')
print('RETARGET_VALIDATION=PASS')
print('CORE_COVERAGE=%.1f%%' % (float(validation.get('core_coverage', 0)) * 100.0))
print('CONVERTED_TRACKS=%s' % m.get('retarget', {}).get('convertedTrackCount'))
print('SOURCE_CLIP=%s' % m.get('retarget', {}).get('sourceClip'))
print('SOURCE_DURATION=%s' % m.get('source_clip_duration'))
PY

MP4="$RESULT_DIR/${NAME}.mp4"
ffmpeg -loglevel error -y \
  -framerate "$FPS" -i "$FRAMES/frame_%06d.png" \
  -f lavfi -i "color=c=${BG}:s=${SIZE}x${SIZE}:r=${FPS}" \
  -filter_complex "[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p" \
  -c:v libx264 -crf 15 -preset medium "$MP4"

echo "FRAMES=$FRAMES"
echo "MANIFEST=$MANIFEST"
echo "MP4=$MP4"
echo "DONE=$RESULT_DIR"
