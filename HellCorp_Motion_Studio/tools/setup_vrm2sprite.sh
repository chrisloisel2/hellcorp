#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/tools"
npm install

cd "$ROOT"
python3 -m venv vrm2sprite/.venv
source vrm2sprite/.venv/bin/activate
pip install --upgrade pip
pip install -r vrm2sprite/requirements.txt

echo "SETUP_VRM2SPRITE_PASS"
