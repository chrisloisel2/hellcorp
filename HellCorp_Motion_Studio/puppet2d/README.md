# HellCorp Puppet2D

Deterministic 2D character animation pipeline for HellCorp.

## Rule

AI may author canonical art once. AI never generates animation frames.

The production path is now:

```text
Mixamo FBX
  -> clean Mixamo-to-VRM retarget
  -> normalized 2D joint clip (HellCorpPuppetPoseV1)
  -> fixed canonical character art
  -> deterministic piecewise-affine mesh deformation
  -> shared palette reduction
  -> PNG sequence + atlas + Godot metadata + preview GIF
```

No SDXL, img2img, LoRA or EbSynth runs inside the animation path.

## Implemented V1

The first executable milestone is Lucy/front.

Files:

```text
puppet2d/pose_export.html
puppet2d/pose_export_app.js
puppet2d/render_mesh.py
puppet2d/validate_manifest.py
puppet2d/requirements.txt
puppet2d/characters/lucy/character.json

tools/export_puppet_pose_cli.mjs
tools/setup_puppet2d.sh
tools/run_puppet2d_first_test.sh
```

`export_puppet_pose_cli.mjs` loads the existing clean Mixamo retarget implementation and samples the normalized VRM skeleton. It exports projected joints instead of rendered VRM frames.

`render_mesh.py` uses the same canonical Lucy texture for every frame. A piecewise-affine mesh deforms that image from the joint motion. Hair, lanyard and skirt receive small deterministic inertia controls. The final frames share one palette.

`validate_manifest.py` verifies frame hashes, dimensions and output files and asserts that diffusion/EbSynth/source texture changes are disabled.

## First setup

From `HellCorp_Motion_Studio`:

```bash
bash tools/setup_puppet2d.sh
```

This creates `puppet2d/.venv`, installs Pillow/OpenCV/numpy, installs the Node dependencies and Playwright Chromium.

## First walk test

```bash
bash tools/run_puppet2d_first_test.sh walk
```

Default inputs:

```text
test_assets/vrm/fem_vroid.vrm
mixamo/animations/Female Walk.fbx
../sdxl_lora_bench/out/characters_summer_memories/lucy_pixel_art.png
puppet2d/characters/lucy/character.json
```

Default output:

```text
puppet2d/output/lucy_walk_front/
  pose.json
  frames/
  atlas.png
  atlas.json
  preview.gif
  manifest.json
```

## Other immediate tests

```bash
bash tools/run_puppet2d_first_test.sh greeting
bash tools/run_puppet2d_first_test.sh phone
```

## Override inputs/settings

The test runner accepts environment overrides:

```bash
SAMPLES=12 SIZE=512 FPS=12 bash tools/run_puppet2d_first_test.sh walk
```

Use another canonical image:

```bash
ART=/absolute/path/to/lucy.png bash tools/run_puppet2d_first_test.sh walk
```

Use another VRM:

```bash
VRM=/absolute/path/to/character.vrm bash tools/run_puppet2d_first_test.sh walk
```

Choose another output folder:

```bash
OUT=/tmp/lucy_test bash tools/run_puppet2d_first_test.sh walk
```

## Run stages manually

Export a 16-pose walk cycle:

```bash
node tools/export_puppet_pose_cli.mjs \
  --vrm test_assets/vrm/fem_vroid.vrm \
  --fbx "mixamo/animations/Female Walk.fbx" \
  --out puppet2d/output/manual_walk/pose.json \
  --view front \
  --samples 16 \
  --root-mode detrend
```

Render it:

```bash
puppet2d/.venv/bin/python puppet2d/render_mesh.py \
  --character puppet2d/characters/lucy/character.json \
  --pose puppet2d/output/manual_walk/pose.json \
  --art ../sdxl_lora_bench/out/characters_summer_memories/lucy_pixel_art.png \
  --out puppet2d/output/manual_walk \
  --size 384 \
  --fps 16 \
  --cols 4 \
  --palette-colors 96
```

Validate:

```bash
puppet2d/.venv/bin/python puppet2d/validate_manifest.py \
  puppet2d/output/manual_walk/manifest.json
```

Expected final messages:

```text
PUPPET_RENDER_PASS
PUPPET_VALIDATION_PASS
```

## Current V1 limitation

The existing Lucy still is visually excellent but is not a neutral rigging drawing: one arm is bent around the folder and several objects are baked into the image. The V1 mesh renderer is therefore useful to validate the core proposition — stable identity and deterministic motion — but it cannot turn that exact still into production-quality extreme poses.

The production step after this prototype is to create canonical neutral front/3-quarter/back art and split it into explicit layered limbs. The pose exporter and output/validation architecture remain reusable for that version.
