# HellCorp Mixamo Clean Retarget

This directory is a clean restart from `main`.

It does **not** depend on V2/V3/V4/V5, MediaPipe, Kalidokit, procedural gait, hand-authored curves, IK, LoRA, EbSynth, pixel-art conversion, outline post-processing, toon banding, or frame-to-frame AI generation.

## Why the previous V5 was wrong

The previous implementation sampled each Mixamo bone in world space, computed a world-space delta from rest, then applied those deltas sequentially to the VRM hierarchy. That causes parent motion to be counted again when child world rotations are evaluated/applied. On large arm/torso motion the error compounds through the hierarchy, so the target visibly stops matching the original Mixamo animation.

## New rule

The clean implementation follows the conversion model used by the official `pixiv/three-vrm` Mixamo example:

1. load the Mixamo FBX with `FBXLoader`;
2. read the original animation **tracks**, not sampled world transforms;
3. for each quaternion track, convert the Mixamo local animation through the source rest-world basis;
4. write the result directly to the VRM **normalized humanoid bone** track;
5. transfer only the hips position track, scaled by normalized hips height;
6. let `THREE.AnimationMixer` evaluate the converted VRM clip;
7. call `vrm.update(0)` to propagate the normalized pose without adding spring/secondary simulation during validation.

No custom body solver exists in this path.

## Quality gates

The renderer refuses to continue when:

- the FBX is missing the standard Mixamo core rig;
- the FBX contains no animation;
- the VRM is missing required humanoid bones;
- hips cannot be retargeted;
- fewer than 90% of the animated core body bones are converted;
- any converted keyframe contains a non-finite value.

Every render writes `manifest.json` with the mapped bone list, ignored tracks, hips scale, VRM version, core coverage and PASS/FAIL status.

## Root motion modes

`preserve` is the validation mode and default. It transfers Mixamo hips position as-is after scale/orientation conversion. Use this first because it makes the fewest changes to the source animation.

`detrend` removes only the linear X/Z travel between the first and last hips key while preserving lateral/forward oscillation. This is suitable for turning locomotion into an in-place cycle without freezing hip motion.

`lock-horizontal` fixes hips X/Z to their initial values. This is intentionally destructive and should not be used to judge retarget quality.

## First test

```bash
bash tools/run_mixamo_clean_cli.sh \
  --fbx "mixamo/animations/Talking On Phone.fbx" \
  --vrm test_assets/vrm/fem_vroid.vrm \
  --view front \
  --size 768 \
  --fps 30 \
  --root-mode preserve \
  --name talking_phone_clean
```

Then inspect:

```text
mixamo_clean_output/talking_phone_clean/talking_phone_clean.mp4
mixamo_clean_output/talking_phone_clean/manifest.json
```

Do not evaluate pixel-art or toon quality at this stage. Gate 1 is only: **does the VRM perform the same body animation as Mixamo?**

## Production progression

1. Validate `Talking On Phone` with `preserve`.
2. Validate one walk, one idle, one dance, one work animation and one seated animation.
3. Run the same five FBXs on three VRMs with different proportions.
4. Only after all of those pass, build batch/atlas tooling around this clean retarget path.
5. Pixel-art rendering remains paused until animation fidelity is solved.
