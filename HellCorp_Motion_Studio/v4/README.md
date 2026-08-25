# HellCorp Motion Studio V4 - Organic Gait

V4 is a new animation path built after reviewing the V3 grounded catwalk output.
The V3 problem was structural: the pelvis had life, but the feet were kept in
place by translating the entire avatar root. That made the character look hung
from a wire.

V4 changes both the gait generator and the grounding system.

## Pipeline

```text
VRM
 + organic character profile
 + organic gait preset
        |
        v
procedural stride model
  - asymmetric stance/swing timing
  - weight transfer tied to support leg
  - double-support vertical compression
  - pelvis roll/yaw coupled to stance
  - torso/shoulder counter-rotation
  - delayed arm pendulum
  - elbow/hand follow-through
  - head vestibular stabilization
  - breathing + eye holds + saccades + blinks
        |
        v
authored VRM pose
        |
        v
two-bone support-leg IK
  - NO global root translation for foot locking
  - support ankle gets a world-space anchor
  - upper/lower leg solve toward the anchor
  - knee plane follows the authored knee direction
  - swing leg stays completely free
  - foot world orientation is preserved
        |
        v
deterministic cel render
        |
        +-- PNG frames
        +-- MP4 motion reference
        +-- GIF preview
```

## Why this differs from V3

V3 foot locking did this:

```text
foot drifts -> move whole VRM opposite the drift
```

V4 does this:

```text
support foot target stays fixed
pelvis/root keeps its authored motion
hip + knee solve to reach the support target
```

The center of mass therefore no longer jumps sideways to compensate for a foot.

## One-command test

From `HellCorp_Motion_Studio`:

```bash
bash tools/run_organic_walk_cli.sh
```

Defaults:

- VRM: `test_assets/vrm/fem_vroid.vrm`
- profile: `v4/characters/lucy.json`
- preset: `v4/presets/lucy_catwalk_organic.json`
- view: front
- size: 512
- cycles: 2

Output:

```text
v4_organic_output/
  lucy_catwalk_organic_v4/
    frames/
    manifest.json
    lucy_catwalk_organic_v4.mp4
    lucy_catwalk_organic_v4.gif
```

Judge the MP4 first. GIF is only a convenience preview.

## Tuning priorities

The V4 preset exposes separate controls for:

- pelvis lateral COM shift;
- vertical COM excursion;
- pelvis roll/yaw/pitch;
- torso counter-yaw/roll;
- hip/knee/ankle stride amplitudes;
- arm swing and lag;
- head stabilization;
- support-leg IK horizontal/vertical strength.

Do not increase pelvis motion to make the walk feel more alive. Organic motion
comes mainly from phase relationships, weight transfer, delayed upper-body
response and the difference between support and swing legs.

## Current limit

This is still procedural animation on a VRM. The final silhouette, hair physics,
clothing deformation and facial quality are bounded by the source VRM. V4 is
intended to solve the puppet-like body mechanics before any later 2D or higher
quality character-rendering stage.
