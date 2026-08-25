# HellCorp Motion Studio V5 - Mixamo production pipeline

V5 pauses the custom procedural gait and pixel-art pipeline.

The production assumption is now:

```text
professionally-authored Mixamo animation
        ->
rest-pose calibrated retarget
        ->
target VRM
        ->
native VRM clean render
        ->
supersampled PNG frames
        ->
MP4 preview
```

No MediaPipe motion reconstruction is used for V5 animation.
No Kalidokit animation is used.
No procedural V3/V4 gait is added.
No SDXL, LoRA, EbSynth or pixel conversion is used.
The existing V1-V4 work remains in the branch as experiments/reference.

## Why this path

The expensive problem was not "how to smooth an animation". It was "how to author a convincing human performance".
Mixamo already supplies authored or captured humanoid animation. V5 treats motion as an asset instead of rebuilding animation from landmarks.

The remaining engineering problem is narrower and scalable:

1. retarget Mixamo skeleton motion to any VRM humanoid,
2. preserve root-motion policy,
3. render deterministic frames,
4. batch an animation library.

## Retargeting model

V5 does not copy Euler angles.

For every mapped bone:

```text
Mixamo rest world orientation
Mixamo animated world orientation
        ->
source world-space rotation delta
        ->
per-bone rest-basis conjugation
        ->
target VRM world-space rotation delta
        ->
target local quaternion
```

This matters because Mixamo and VRM bones do not necessarily share local axes.

The retargeter also:

- maps torso, arms, legs, toes and fingers;
- detects `mixamorig:` namespaces automatically;
- estimates source->target translation scale from leg-chain lengths;
- supports in-place, full, horizontal-only and locked root modes;
- reports missing optional target bones instead of silently failing;
- accepts FBX files containing one or multiple animation clips.

## Render policy

V5 deliberately bypasses the old screen-space style stack during production tests:

- no OutlineAO pass;
- no luminance posterization;
- no grade pass;
- no sharpen pass;
- no pixel-art quantization.

It renders the VRM's native materials with spatial supersampling.

The goal is to validate animation continuity first. Art-direction can be rebuilt later on top of a motion source that already works.

## One animation

From `HellCorp_Motion_Studio`:

```bash
bash tools/run_mixamo_cli.sh \
  --fbx "/absolute/path/Talking On Phone.fbx"
```

Outputs:

```text
v5_mixamo_output/
  fem_vroid_Talking_On_Phone_front/
    frames/
      frame_000000.png
      frame_000001.png
      ...
    manifest.json
    fem_vroid_Talking_On_Phone_front.mp4
```

## Four views

```bash
bash tools/run_mixamo_cli.sh \
  --fbx "/absolute/path/Talking On Phone.fbx" \
  --views front,threequarter,side,back
```

## Batch a Mixamo library

Put FBX files in any local directory, then:

```bash
bash tools/run_mixamo_cli.sh \
  --fbx-dir "/absolute/path/mixamo_animations" \
  --views front \
  --size 768 \
  --fps 30
```

Every FBX is retargeted to the same VRM automatically.

## Root motion modes

`--root-mode inplace`

Keeps vertical movement but removes X/Z travel. Good default for reusable world sprites.

`--root-mode full`

Preserves Mixamo translation. Good for cinematics or sequences where the actor really travels.

`--root-mode horizontal`

Preserves X/Z and removes vertical root translation.

`--root-mode locked`

Removes all root translation.

## Clip selection

Most Mixamo downloads contain one clip, so `--clip 0` is the default.

For multi-clip FBX:

```bash
bash tools/run_mixamo_cli.sh \
  --fbx animation.fbx \
  --clip 1
```

or:

```bash
bash tools/run_mixamo_cli.sh \
  --fbx animation.fbx \
  --clip "Talking"
```

The CLI prints the clip list before rendering.

## Trimming

```bash
bash tools/run_mixamo_cli.sh \
  --fbx animation.fbx \
  --start 0.4 \
  --end 2.2
```

## Work plan

### Gate A - prove retarget quality

Use 5 qualitatively different Mixamo animations:

- idle;
- walk/catwalk;
- talking on phone;
- bending/picking something up;
- dance.

Do not touch pixel art until all five look mechanically correct on the same VRM.

### Gate B - build the reusable animation library

Create folders by gameplay intent rather than by character:

```text
idle/
walk/
work/
dance/
sleep/
interaction/
phone/
```

Characters share the same motion library unless a major character needs a bespoke animation.

### Gate C - test multiple VRMs

Run the same five animations on Lucy plus two very different VRM body proportions.
If motion remains acceptable, character production scales.

### Gate D - art direction

Only after animation is solved:

- choose native 3D runtime or pre-rendered frames;
- design a continuity-safe stylization strategy;
- then revisit 2D/pixel treatment if still desired.

## Known limits

Mixamo does not solve facial animation.

Some Mixamo clips have weak or generic finger motion.

Extreme differences in target proportions can create contact errors even when rotations retarget correctly.

Feet interacting with exact world geometry may eventually need a small target-side IK pass, but unlike V4 this would be a correction on top of a professional animation, not a replacement animation system.
