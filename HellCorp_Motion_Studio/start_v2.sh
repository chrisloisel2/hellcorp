#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
python3 v2/build_v2.py
python3 launch.py
