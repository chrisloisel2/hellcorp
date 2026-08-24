#!/usr/bin/env python3
"""Build an opt-in V2 app from the current Motion Studio without touching app.js.

The generated app_v2.js stores raw MediaPipe world landmarks per frame, runs the
biomechanical pass after temporal smoothing, and keeps the original renderer.
This makes the branch reversible: V1 remains untouched and index_v2.html points
at the generated V2 entrypoint.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "app.js"
DST = ROOT / "app_v2.js"
INDEX = ROOT / "index.html"
INDEX_V2 = ROOT / "index_v2.html"

IMPORT = "import { processBiomechanicalFrames, biomechanicsSummary } from './v2/biomechanics.js';\n"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Patch {label}: expected one match, got {count}")
    return text.replace(old, new, 1)


def main() -> None:
    src = SRC.read_text(encoding="utf-8")
    if "processBiomechanicalFrames" not in src:
        src = IMPORT + src

    old_push = "frames.push({ time: t, rig: clonePlain(rig) });"
    new_push = "frames.push({\n      time: t,\n      rig: clonePlain(rig),\n      // V2 keeps the raw anatomical evidence. The biomechanical pass must run\n      // from landmarks, not from already-retargeted Euler rotations.\n      landmarks: clonePlain(result.worldLandmarks?.[0] || null),\n    });"
    src = replace_once(src, old_push, new_push, "store-world-landmarks")

    old_smooth = "smoothFrameSeries(body.frames, (f) => f.rig);\n  if (face) smoothFrameSeries(face.frames, (f) => f.rig);\n  currentMotion = { body, face, bodyFile, faceFile };"
    new_smooth = "smoothFrameSeries(body.frames, (f) => f.rig);\n  if (face) smoothFrameSeries(face.frames, (f) => f.rig);\n\n  // V2: rebuild body balance after jitter removal. This pass derives support\n  // feet, root compensation, pelvis sway and shoulder counter-rotation from\n  // the original MediaPipe world landmarks. It never generates pixels.\n  body.frames = processBiomechanicalFrames(body.frames, body.fps);\n  const biomechStats = biomechanicsSummary(body.frames);\n  log(`BIOMECH V2: ${biomechStats.leftContactFrames || 0} left-contact, ${biomechStats.rightContactFrames || 0} right-contact, ${biomechStats.doubleSupportFrames || 0} double-support frames.`);\n\n  currentMotion = { body, face, bodyFile, faceFile };"
    src = replace_once(src, old_smooth, new_smooth, "biomechanical-pass")

    # V2 root positions are metric-ish relative corrections from landmarks. The
    # old hard-coded Kalidokit scaling would attenuate them again. When biomech
    # data is present use it directly; preserve V1 behavior as fallback.
    old_root = "root.position.x = modelFrame.center.x + Number(p.x || 0) * 0.35;\n    root.position.y = Number(p.y || 0) * 0.15;\n    root.position.z = Number(p.z || 0) * 0.15;"
    new_root = "if (frame?.biomech?.root) {\n      root.position.x = Number(p.x || 0);\n      root.position.y = Number(p.y || 0);\n      root.position.z = Number(p.z || 0);\n    } else {\n      root.position.x = modelFrame.center.x + Number(p.x || 0) * 0.35;\n      root.position.y = Number(p.y || 0) * 0.15;\n      root.position.z = Number(p.z || 0) * 0.15;\n    }"
    src = replace_once(src, old_root, new_root, "root-motion")

    # Export format marker makes it obvious which captures carry landmarks and
    # contact diagnostics.
    src = src.replace("format: 'HellCorpBodyMotionV1'", "format: 'HellCorpBodyMotionV2'", 1)
    src = src.replace("format: 'HellCorpSpriteSetV1'", "format: 'HellCorpSpriteSetV2'", 1)

    DST.write_text(src, encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    html = replace_once(html, '<script type="module" src="app.js"></script>', '<script type="module" src="app_v2.js"></script>', "v2-entrypoint")
    html = html.replace('<title>HellCorp Motion Studio</title>', '<title>HellCorp Motion Studio V2</title>', 1)
    html = html.replace('<h1>HellCorp Motion Studio</h1>', '<h1>HellCorp Motion Studio V2 - Biomechanical</h1>', 1)
    INDEX_V2.write_text(html, encoding="utf-8")

    print(f"Generated {DST.relative_to(ROOT)}")
    print(f"Generated {INDEX_V2.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
