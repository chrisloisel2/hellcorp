# HellCorp Motion Studio V3 - Authored Animation

V3 is a separate animation path designed for character presentation quality rather than mocap fidelity.

It does **not** use MediaPipe or Kalidokit to generate the movement. The existing Three.js/VRM deterministic renderer is reused only as the final renderer.

## Pipeline

```text
character VRM
  + authored character profile
  + authored animation clip
        |
        v
cyclic cubic motion curves
        |
        +-- pelvis figure-eight
        +-- step compression / body weight accent
        +-- breathing
        +-- shoulder/chest counter-motion
        +-- head stabilization
        +-- delayed arm/hand follow-through
        +-- asymmetric micro-motion
        +-- blink timing
        +-- eye saccades / gaze holds
        +-- VRM spring-bone simulation with deterministic preroll
        |
        v
deterministic cel renderer
        |
        +-- raw 512px PNG sequence
        +-- GIF preview on HellCorp background
        +-- H.264 MP4 preview
        +-- optional deterministic pixel conversion
```

## Included authored assets

- `characters/lucy.json`: Lucy-specific neutral pose, asymmetry, breathing, micro-motion and facial defaults.
- `clips/lucy_catwalk_front.json`: 30 FPS, 1.4 s seamless front catwalk cycle with authored gait phases.
- `clips/lucy_idle_ani.json`: 30 FPS, 2.8 s character-presentation idle with weight shifts, breathing, eye motion and blink clusters.

## One-command CLI

From `HellCorp_Motion_Studio`:

```bash
bash tools/run_authored_ani_cli.sh
```

This defaults to Lucy + the authored catwalk and writes:

```text
v3_authored_output/
  lucy_lucy_catwalk_front_front/
    frames/
      frame_000000.png
      ...
    manifest.json
    lucy_lucy_catwalk_front_front.gif
    lucy_lucy_catwalk_front_front.mp4
```

The MP4 is the preferred quality reference because GIF is restricted to a 256-color palette.

## ANI-like idle test

```bash
bash tools/run_authored_ani_cli.sh \
  --clip v3/clips/lucy_idle_ani.json \
  --name lucy_idle_ani
```

## Optional pixel preview

Pixel conversion is no longer part of the authored animation itself. It is an optional deterministic post-process:

```bash
bash tools/run_authored_ani_cli.sh --pixel
```

## Custom render

```bash
bash tools/run_authored_ani_cli.sh \
  --vrm test_assets/vrm/fem_vroid.vrm \
  --profile v3/characters/lucy.json \
  --clip v3/clips/lucy_catwalk_front.json \
  --view front \
  --size 768 \
  --cycles 2 \
  --name lucy_catwalk_quality
```

## Why this should look less mechanical

The old pipeline asked a pose tracker to reproduce every source frame and then tried to repair the result. V3 instead defines the animation in animation language: contacts, passing poses, body compression, pelvis roll/yaw, torso counter-motion, delayed extremities and deliberately non-synchronous micro-motion.

The motion is also asymmetric. Perfect mathematical mirroring is avoided because it reads as robotic even when the joint positions are technically correct.

## Editing a clip

Tracks use normalized cycle time (`0.0` to `<1.0`) and radians:

```json
"hips.rotation.z": {
  "curve": "catmull",
  "tension": 0.45,
  "keys": [
    { "t": 0.00, "v": -0.10 },
    { "t": 0.25, "v": -0.02 },
    { "t": 0.50, "v": 0.10 },
    { "t": 0.75, "v": 0.02 }
  ]
}
```

Supported paths include any normalized VRM humanoid bone such as:

```text
hips.rotation.x/y/z
spine.rotation.x/y/z
chest.rotation.x/y/z
upperChest.rotation.x/y/z
neck.rotation.x/y/z
head.rotation.x/y/z
left/rightShoulder.rotation.x/y/z
left/rightUpperArm.rotation.x/y/z
left/rightLowerArm.rotation.x/y/z
left/rightHand.rotation.x/y/z
left/rightUpperLeg.rotation.x/y/z
left/rightLowerLeg.rotation.x/y/z
left/rightFoot.rotation.x/y/z
root.position.x/y/z
```

## Determinism

For the same VRM, profile, clip, FPS and renderer version, the authored pose sequence is deterministic. Random-looking micro-motion is generated from a fixed integer seed and periodic functions, so it does not flicker between frames or between runs.

## Current limitation

A renderer cannot invent a better character model. V3 improves animation quality, timing and presence, but final visual similarity to the intended Lucy design still depends on the VRM mesh, materials, hair and clothing. The architecture is intentionally compatible with replacing `fem_vroid.vrm` later without rewriting animation clips.
