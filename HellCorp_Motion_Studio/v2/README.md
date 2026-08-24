# Motion Studio V2 — biomechanical + deterministic

This branch keeps V1 intact and adds an opt-in V2 pipeline.

## Why V2 exists

The previous pipeline solved jitter but still produced mannequin-like motion. Pixel LoRA/SDXL improved isolated frames while introducing temporal inconsistency. V2 removes stochastic image generation from animation entirely.

## Architecture

```text
human video
  -> MediaPipe pose landmarks
  -> existing Kalidokit/IK retargeting
  -> temporal smoothing
  -> biomechanical pass
       - support-foot detection
       - planted-foot drift compensation
       - root reconstruction
       - pelvis sway
       - shoulder/pelvis counter-rotation
       - stance/knee diagnostics
  -> deterministic VRM cel renderer
  -> optional deterministic pixel post-process
  -> Godot atlas
```

## Running V2

macOS/Linux:

```bash
cd HellCorp_Motion_Studio
./start_v2.sh
```

Windows:

```bat
cd HellCorp_Motion_Studio
start_v2.bat
```

The launcher generates `app_v2.js` and `index_v2.html` from the current V1 source, then starts the same local server. Open:

```text
http://127.0.0.1:8765/index_v2.html
```

The generated files are intentionally build artifacts. V1 `app.js` remains unchanged.

## What changes in motion data

V2 stores MediaPipe `worldLandmarks` in every body frame before retargeting information is discarded. After the existing One Euro smoothing pass, `processBiomechanicalFrames()` reconstructs a root trajectory and records contact diagnostics.

The exported `body_motion.json` is marked `HellCorpBodyMotionV2`. Each frame can contain:

```json
{
  "time": 0.4,
  "rig": {},
  "landmarks": [],
  "biomech": {
    "root": {"x": 0, "y": 0, "z": 0},
    "contactLeft": true,
    "contactRight": false,
    "kneeAngleLeft": 2.8,
    "kneeAngleRight": 2.3,
    "stanceWidth": 0.19
  }
}
```

## Foot locking model

This is not a hard IK pin yet. The pass detects low-velocity feet near the inferred ground plane and compensates root drift while contact is active. This is deliberately conservative: it reduces skating without snapping the avatar violently when MediaPipe produces a bad foot frame.

A future hard-lock pass should operate directly on the VRM leg chain after root reconstruction, with a two-bone IK solver and per-character leg-length calibration.

## Deterministic pixel post-processing

After rendering frames, run:

```bash
python3 tools/deterministic_pixel.py \
  --in OUTPUT/character/clip/front/frames \
  --out OUTPUT/character/clip/front/pixel_frames \
  --logical-size 128 \
  --output-size 512 \
  --colors 32
```

Important behavior:

- one palette is learned from the entire sequence, not independently per frame;
- dithering is disabled;
- alpha fringes are hardened consistently;
- isolated one-frame-looking color pixels are conservatively cleaned;
- upscale uses nearest-neighbor;
- no SDXL, LoRA, EbSynth or generative frame synthesis is involved.

## Current limits

The existing renderer still uses the VRM itself as the character source. If the VRM does not visually resemble Lucy, deterministic rendering cannot invent Lucy. Multi-character quality therefore depends on producing character-specific VRMs/materials or a shared rig with deterministic material/hair/clothing variants.

The current biomechanical pass improves root/body balance using MediaPipe landmarks but does not yet implement full center-of-mass physics, two-bone foot IK, toe roll, or spring-bone authoring.
