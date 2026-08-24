#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$STUDIO_DIR"

VRM="test_assets/vrm/fem_vroid.vrm"
BODY="video/perfect.mp4"
FACE=""
OUT="v2_cli_output"
VIEW="front"
SIZE="512"
PIXEL_LOGICAL="128"
PIXEL_COLORS="32"
FPS_MODE="body"
CUSTOM_FPS=""
SKIP_PIXEL=0

usage() {
  cat <<'EOF'
Usage: ./tools/run_v2_cli.sh [options]

Runs the complete Motion Studio V2 pipeline without opening the UI:
  build V2 -> MediaPipe tracking -> biomechanical pass -> deterministic render
  -> raw GIF -> deterministic pixel pass -> pixel GIF

Options:
  --vrm PATH             VRM file (default: test_assets/vrm/fem_vroid.vrm)
  --body PATH            body video (default: video/perfect.mp4)
  --face PATH            optional face video
  --out DIR              output directory (default: v2_cli_output)
  --view NAME            front|threequarter|side|back (default: front)
  --size N               rendered frame size (default: 512)
  --logical-size N       pixel-art logical resolution (default: 128)
  --colors N             shared pixel palette size (default: 32)
  --fps-mode MODE        body|max|custom (default: body)
  --custom-fps N         required when --fps-mode custom
  --skip-pixel           only generate the raw biomechanical GIF
  -h, --help             show this help

Example:
  ./tools/run_v2_cli.sh

Custom:
  ./tools/run_v2_cli.sh \
    --vrm test_assets/vrm/fem_vroid.vrm \
    --body video/perfect.mp4 \
    --out results/lucy_v2 \
    --view front \
    --size 512 \
    --logical-size 128 \
    --colors 32
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vrm) VRM="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --face) FACE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --view) VIEW="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --logical-size) PIXEL_LOGICAL="$2"; shift 2 ;;
    --colors) PIXEL_COLORS="$2"; shift 2 ;;
    --fps-mode) FPS_MODE="$2"; shift 2 ;;
    --custom-fps) CUSTOM_FPS="$2"; shift 2 ;;
    --skip-pixel) SKIP_PIXEL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

[[ -f "$VRM" ]] || { echo "VRM not found: $VRM" >&2; exit 1; }
[[ -f "$BODY" ]] || { echo "Body video not found: $BODY" >&2; exit 1; }
if [[ -n "$FACE" && ! -f "$FACE" ]]; then
  echo "Face video not found: $FACE" >&2
  exit 1
fi
if [[ "$FPS_MODE" == "custom" && -z "$CUSTOM_FPS" ]]; then
  echo "--custom-fps is required with --fps-mode custom" >&2
  exit 1
fi

if [[ ! -d tools/node_modules/playwright ]]; then
  echo "Installing Playwright dependency..."
  (cd tools && npm install)
fi

# Build generated V2 entrypoints while leaving V1 untouched.
python3 v2/build_v2.py

TMP_CLI="$(mktemp "${TMPDIR:-/tmp}/hellcorp-render-v2.XXXXXX.mjs")"
trap 'rm -f "$TMP_CLI"' EXIT

# Reuse the tested headless renderer. Only two behaviors differ for V2:
# - navigate to index_v2.html;
# - disable the legacy in-place root lock so reconstructed biomechanical root
#   motion is actually rendered.
python3 - "$TMP_CLI" <<'PY'
from pathlib import Path
import sys

src = Path("tools/render_cli.mjs").read_text(encoding="utf-8")
src = src.replace("/index.html", "/index_v2.html", 1)
needle = "    await page.selectOption('#sizeSelect', size);\n"
replacement = needle + "    await page.uncheck('#lockRoot');\n"
if needle not in src:
    raise SystemExit("Could not patch render_cli.mjs: sizeSelect marker not found")
src = src.replace(needle, replacement, 1)
Path(sys.argv[1]).write_text(src, encoding="utf-8")
PY

mkdir -p "$OUT"

ARGS=(
  "$TMP_CLI"
  --vrm "$VRM"
  --body "$BODY"
  --out "$OUT"
  --fps-mode "$FPS_MODE"
  --size "$SIZE"
  --views "$VIEW"
)
if [[ -n "$FACE" ]]; then ARGS+=(--face "$FACE"); fi
if [[ -n "$CUSTOM_FPS" ]]; then ARGS+=(--custom-fps "$CUSTOM_FPS"); fi

node "${ARGS[@]}"

stem() {
  local name
  name="$(basename "$1")"
  printf '%s' "${name%.*}" | sed 's/[^a-zA-Z0-9._-]/_/g; s/^_*//; s/_*$//'
}

CHAR="$(stem "$VRM")"
CLIP="$(stem "$BODY")"
CLIP_DIR="$OUT/$CHAR/$CLIP"
FRAMES="$CLIP_DIR/$VIEW/frames"
CLIP_JSON="$CLIP_DIR/clip.json"

[[ -d "$FRAMES" ]] || { echo "Rendered frames not found: $FRAMES" >&2; exit 1; }
[[ -f "$CLIP_JSON" ]] || { echo "clip.json not found: $CLIP_JSON" >&2; exit 1; }

FPS="$(python3 - "$CLIP_JSON" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f)["fps"])
PY
)"

RAW_GIF="$CLIP_DIR/${CLIP}_${VIEW}_v2_biomechanical.gif"
ffmpeg -loglevel error -y \
  -framerate "$FPS" \
  -i "$FRAMES/frame_%06d.png" \
  -filter_complex "[0:v]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none" \
  "$RAW_GIF"

echo "RAW_GIF=$RAW_GIF"

if [[ "$SKIP_PIXEL" -eq 0 ]]; then
  PIXEL_FRAMES="$CLIP_DIR/$VIEW/pixel_frames"
  python3 tools/deterministic_pixel.py \
    --in "$FRAMES" \
    --out "$PIXEL_FRAMES" \
    --logical-size "$PIXEL_LOGICAL" \
    --output-size "$SIZE" \
    --colors "$PIXEL_COLORS"

  PIXEL_GIF="$CLIP_DIR/${CLIP}_${VIEW}_v2_pixel.gif"
  ffmpeg -loglevel error -y \
    -framerate "$FPS" \
    -i "$PIXEL_FRAMES/frame_%06d.png" \
    -filter_complex "[0:v]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none" \
    "$PIXEL_GIF"
  echo "PIXEL_GIF=$PIXEL_GIF"
fi

echo "DONE=$CLIP_DIR"
