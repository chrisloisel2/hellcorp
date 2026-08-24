#!/usr/bin/env python3
"""
Rig corps entier (5 pieces Polygon2D: head_torso rigide + 4 membres a 2 os
chacun avec bone weights, meme principe que rig_mesh_godot_export.py mais
generalise) + cycle de marche procedural (rotations sinusoidales par os).

Texture: clean_full_body.png (detourage SAM, cf rig_full_body_cutout.py).
Pivots: memes coordonnees que rig_manifest.json / rig_slice.py (RIG_POSE).

Usage:
    hellcorp_ai/runtime/sdxl-venv/bin/python hellcorp_ai/tools/rig_walkcycle_export.py
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parents[2]
GODOT_DIR = ROOT_DIR / "hellcorp_ai" / "godot_rig_test"
TEXTURE = GODOT_DIR / "clean_full_body.png"

# Pivots (RIG_POSE de rig_slice.py, canvas 768x1344)
P = {
    "head_top": (384.0, 161.3), "neck": (384.0, 228.5),
    "shoulder_R": (307.2, 255.4), "elbow_R": (184.3, 322.6), "wrist_R": (76.8, 376.3),
    "shoulder_L": (460.8, 255.4), "elbow_L": (583.7, 322.6), "wrist_L": (691.2, 376.3),
    "hip_R": (353.3, 645.1), "knee_R": (337.9, 913.9), "ankle_R": (322.6, 1182.7),
    "hip_L": (414.7, 645.1), "knee_L": (430.1, 913.9), "ankle_L": (445.4, 1182.7),
}
ROOT_PIVOT = ((P["hip_R"][0] + P["hip_L"][0]) / 2, P["hip_R"][1])  # (384.0, 645.1)

WEIGHT_FALLOFF_PX = 50


def two_bone_weight(vertex, proximal, distal, falloff=WEIGHT_FALLOFF_PX):
    """Poids du bone proximal (0..1); 1-poids = bone distal. Smoothstep
    centre sur `distal` (le joint), le long de l'axe proximal->distal."""
    ax, ay = proximal[0] - distal[0], proximal[1] - distal[1]
    bone_len = math.hypot(ax, ay)
    ux, uy = ax / bone_len, ay / bone_len
    vx, vy = vertex[0] - distal[0], vertex[1] - distal[1]
    signed_dist = vx * ux + vy * uy
    t = np.clip((signed_dist + falloff) / (2 * falloff), 0.0, 1.0)
    return float(t * t * (3 - 2 * t))


def build_grid_mesh(x0, y0, x1, y1, cols, rows, tex_w, tex_h):
    xs = np.linspace(x0, x1, cols)
    ys = np.linspace(y0, y1, rows)

    def rc(r, c):
        return r * cols + c

    verts, uvs = [], []
    for y in ys:
        for x in xs:
            verts.append([float(x), float(y)])
            uvs.append([float(x) / tex_w, float(y) / tex_h])

    triangles = []
    for r in range(rows - 1):
        for c in range(cols - 1):
            a, b, cc, d = rc(r, c), rc(r, c + 1), rc(r + 1, c + 1), rc(r + 1, c)
            triangles.append([a, b, cc])
            triangles.append([a, cc, d])
    return verts, uvs, triangles


def rigid_part(name, bone, bounds, cols, rows, tex_w, tex_h):
    x0, y0, x1, y1 = bounds
    verts, uvs, triangles = build_grid_mesh(x0, y0, x1, y1, cols, rows, tex_w, tex_h)
    return {
        "bones": [bone],
        "vertices": verts, "uv": uvs, "triangles": triangles,
        "weights": {bone: [1.0] * len(verts)},
    }


def two_bone_part(name, bone_prox, bone_dist, proximal, distal, bounds, cols, rows, tex_w, tex_h):
    x0, y0, x1, y1 = bounds
    verts, uvs, triangles = build_grid_mesh(x0, y0, x1, y1, cols, rows, tex_w, tex_h)
    w_prox = [two_bone_weight((v[0], v[1]), proximal, distal) for v in verts]
    w_dist = [1.0 - w for w in w_prox]
    return {
        "bones": [bone_prox, bone_dist],
        "vertices": verts, "uv": uvs, "triangles": triangles,
        "weights": {bone_prox: w_prox, bone_dist: w_dist},
    }


def build_walk_keyframes(n_frames=8):
    """Cycle sinusoidal simplifie, vue de face (l'art source est en T-pose
    face camera, pas de profil): les jambes font le vrai travail de
    marche (swing + genou), les bras (partis du T-pose bras ecartes, pas
    bras-le-long-du-corps) ne font qu'un leger balancement secondaire pour
    ne pas exiger une rotation de ~90 deg depuis le repos (deformerait mal
    un skinning lineaire simple sans dessins correctifs)."""
    thigh_amp, shin_amp, arm_amp, forearm_amp = 24.0, 30.0, 10.0, 8.0
    bob_amp = 7.0
    frames = []
    for i in range(n_frames):
        phase = 2 * math.pi * i / n_frames
        thigh_R = thigh_amp * math.sin(phase)
        thigh_L = thigh_amp * math.sin(phase + math.pi)
        shin_R = shin_amp * max(0.0, math.sin(phase + math.pi / 2 + 0.3))
        shin_L = shin_amp * max(0.0, math.sin(phase + math.pi + math.pi / 2 + 0.3))
        arm_R = -thigh_L * (arm_amp / thigh_amp)
        arm_L = -thigh_R * (arm_amp / thigh_amp)
        forearm_R = forearm_amp * max(0.0, math.sin(phase + math.pi + 0.3))
        forearm_L = forearm_amp * max(0.0, math.sin(phase + 0.3))
        bob = -abs(bob_amp * math.sin(phase)) - bob_amp * 0.3
        frames.append({
            "root_offset": [0.0, bob],
            "rotations_deg": {
                "ThighR": thigh_R, "ShinR": shin_R,
                "ThighL": thigh_L, "ShinL": shin_L,
                "UpperArmR": arm_R, "ForearmR": forearm_R,
                "UpperArmL": arm_L, "ForearmL": forearm_L,
            },
        })
    return frames


def main():
    tex_w, tex_h = Image.open(TEXTURE).size

    parts = {
        "head_torso": rigid_part(
            "head_torso", "Root", (130, 20, 640, 665), 16, 20, tex_w, tex_h),
        "arm_R": two_bone_part(
            "arm_R", "UpperArmR", "ForearmR", P["shoulder_R"], P["elbow_R"],
            (40, 210, 355, 425), 22, 12, tex_w, tex_h),
        "arm_L": two_bone_part(
            "arm_L", "UpperArmL", "ForearmL", P["shoulder_L"], P["elbow_L"],
            (412, 210, 730, 425), 22, 12, tex_w, tex_h),
        "leg_R": two_bone_part(
            "leg_R", "ThighR", "ShinR", P["hip_R"], P["knee_R"],
            (268, 600, 420, 1235), 12, 22, tex_w, tex_h),
        "leg_L": two_bone_part(
            "leg_L", "ThighL", "ShinL", P["hip_L"], P["knee_L"],
            (362, 600, 502, 1235), 12, 22, tex_w, tex_h),
    }

    def local(child_pt, parent_pt):
        return [child_pt[0] - parent_pt[0], child_pt[1] - parent_pt[1]]

    bone_hierarchy = [
        {"name": "Root", "parent": None, "rest_local": list(ROOT_PIVOT)},
        {"name": "UpperArmR", "parent": "Root", "rest_local": local(P["shoulder_R"], ROOT_PIVOT)},
        {"name": "ForearmR", "parent": "UpperArmR", "rest_local": local(P["elbow_R"], P["shoulder_R"])},
        {"name": "UpperArmL", "parent": "Root", "rest_local": local(P["shoulder_L"], ROOT_PIVOT)},
        {"name": "ForearmL", "parent": "UpperArmL", "rest_local": local(P["elbow_L"], P["shoulder_L"])},
        {"name": "ThighR", "parent": "Root", "rest_local": local(P["hip_R"], ROOT_PIVOT)},
        {"name": "ShinR", "parent": "ThighR", "rest_local": local(P["knee_R"], P["hip_R"])},
        {"name": "ThighL", "parent": "Root", "rest_local": local(P["hip_L"], ROOT_PIVOT)},
        {"name": "ShinL", "parent": "ThighL", "rest_local": local(P["knee_L"], P["hip_L"])},
    ]

    data = {
        "texture_size": [tex_w, tex_h],
        "pivots": {k: list(v) for k, v in P.items()},
        "root_pivot": list(ROOT_PIVOT),
        "bone_hierarchy": bone_hierarchy,
        "parts": parts,
        "keyframes": build_walk_keyframes(8),
    }
    out = GODOT_DIR / "walk_data.json"
    out.write_text(json.dumps(data))
    n_verts = sum(len(p["vertices"]) for p in parts.values())
    print(f"-> {out} ({n_verts} vertices across {len(parts)} parts)")


if __name__ == "__main__":
    main()
