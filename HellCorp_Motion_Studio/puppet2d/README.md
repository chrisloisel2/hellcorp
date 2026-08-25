# HellCorp Puppet2D

Deterministic 2D character animation pipeline for HellCorp.

## Why this exists

The current visual target is excellent as a still image, but diffusion-based frame generation is the wrong production primitive for animation. Even with fixed seeds, LoRA, dense keyframes and EbSynth, the character can change locally between frames: face, hair, clothing seams, highlights and silhouette details drift or smear.

Puppet2D changes the rule:

> AI may author canonical art once. AI never generates animation frames.

Every animation frame is rendered deterministically from the same character artwork plus a motion clip.

## Production architecture

```text
CANONICAL CHARACTER ART
(front / 3-4 / back)
        |
        v
LAYER CUTTER
(head, hair, torso, pelvis, arms, forearms, hands, thighs, calves, feet, accessories)
        |
        v
CHARACTER RIG JSON
(anchors, pivots, draw order, mesh masks)
        |
        +--------------------+
        |                    |
        v                    v
MOTION SOURCE             EXPRESSIONS
Mixamo FBX / VRM clip     authored face presets
        |                    |
        v                    |
3D -> 2D POSE PROJECTOR      |
        |                    |
        +---------+----------+
                  v
          DETERMINISTIC RENDERER
                  |
                  v
        PNG frames / atlas / Godot
```

## Non-negotiable rules

1. No SDXL/img2img inside an animation loop.
2. No EbSynth in the production path.
3. A character has one canonical texture set per camera direction.
4. Motion changes transforms and deformation only, never identity.
5. Pixel-art treatment is a final deterministic post-process.
6. Exported animation must be reproducible bit-for-bit from the same inputs.

## Camera directions

The minimum useful set for the game is:

- `front`
- `front_3q_left`
- `front_3q_right`
- `back`

For the first prototype only `front` is required.

## Character package

```text
puppet2d/characters/lucy/
  character.json
  art/
    front.png
  layers/
    front/
      head.png
      hair_back.png
      hair_front.png
      torso.png
      pelvis.png
      upper_arm_l.png
      forearm_l.png
      hand_l.png
      upper_arm_r.png
      forearm_r.png
      hand_r.png
      thigh_l.png
      calf_l.png
      foot_l.png
      thigh_r.png
      calf_r.png
      foot_r.png
      accessories.png
```

The first implementation does not require automatic cutting. Layers can be authored manually from the canonical image. Automatic segmentation can be added later.

## Rig model

The rig is a lightweight 2D skeleton. Each sprite layer has:

- a parent bone;
- a pivot in normalized image coordinates;
- an offset from the parent;
- a draw-order value;
- optional angle and scale limits.

Bones used by the first prototype:

```text
root
pelvis
spine
chest
neck
head
upper_arm_l
forearm_l
hand_l
upper_arm_r
forearm_r
hand_r
thigh_l
calf_l
foot_l
thigh_r
calf_r
foot_r
```

## Motion input

The preferred source remains Mixamo because the clean retarget branch already establishes a deterministic animation source.

Puppet2D does not render the VRM. It uses the animation only as motion data.

For every sampled frame we keep the projected 2D joint positions and a small amount of depth information used for draw ordering.

Example pose frame:

```json
{
  "time": 0.133333,
  "joints": {
    "pelvis": {"x": 0.51, "y": 0.61, "z": 0.02},
    "head": {"x": 0.50, "y": 0.16, "z": -0.01},
    "hand_l": {"x": 0.35, "y": 0.48, "z": 0.09}
  }
}
```

## Animation strategy

The renderer derives each bone angle from two projected joints. Limb sprite layers are then transformed around fixed pivots.

For torso/pelvis deformation, a simple affine transform is used first. Mesh warping can replace it later if the prototype proves the direction.

Hair, breasts, skirt hems, ties and accessories are secondary-motion layers. They are simulated deterministically using spring values stored in the character profile.

## Pixel-art output

Do not generate native pixel art per frame.

Render the puppet at 2x-4x target resolution, then apply one deterministic reduction pass:

1. nearest/bicubic controlled downsample;
2. palette reduction;
3. edge cleanup;
4. optional outline pass;
5. pixel snapping.

This preserves the exact same face, clothes and silhouette details across the full animation.

## Quality gates

A clip fails if any of these happen:

- a required joint is missing;
- a limb angle jumps by more than the configured maximum between adjacent frames;
- character bounding-box scale changes unexpectedly;
- feet drift above the configured floor while marked as planted;
- exported frame dimensions differ;
- any layer changes source texture during the clip.

## First milestone

Lucy front-facing walk only.

Input:

- canonical Lucy image;
- `Female Walk.fbx`;
- front orthographic projection.

Output:

- 12-16 frame seamless walk cycle;
- deterministic PNG sequence;
- atlas + JSON metadata for Godot;
- no diffusion and no EbSynth.

The target is not perfect deformation. The target is proving that Lucy remains exactly Lucy for every frame while the walk reads naturally.
