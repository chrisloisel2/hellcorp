#!/usr/bin/env bash
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$STUDIO_DIR/puppet2d/.venv"

cd "$STUDIO_DIR"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }

python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$STUDIO_DIR/puppet2d/requirements.txt"

npm --prefix "$STUDIO_DIR/tools" install
npx --prefix "$STUDIO_DIR/tools" playwright install chromium

echo "PUPPET2D_SETUP_PASS"
echo "Python: $VENV/bin/python"
