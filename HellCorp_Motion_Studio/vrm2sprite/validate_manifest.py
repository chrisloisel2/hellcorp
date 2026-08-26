#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: validate_manifest.py manifest.json")
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))

    required = ["format", "frame_count", "frame_size", "atlas", "gif", "frames"]
    for k in required:
        if k not in data:
            raise SystemExit(f"Missing manifest key: {k}")

    if data["format"] != "HellCorpVrm2SpriteV1":
        raise SystemExit("Invalid format")

    if data["frame_count"] != len(data["frames"]):
        raise SystemExit("frame_count mismatch")

    w, h = data["frame_size"]
    if w <= 0 or h <= 0:
        raise SystemExit("Invalid frame_size")

    print("VRM2SPRITE_VALIDATION_PASS")


if __name__ == "__main__":
    main()
