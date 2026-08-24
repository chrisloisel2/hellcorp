#!/usr/bin/env python3
from __future__ import annotations

import argparse
import colorsys
import hashlib
import json
import math
import os
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

DEFAULT_CHARACTERS = {
    "morrigan": {
        "display_name": "Morrigan",
        "age": 31,
        "role": "VP Finance",
        "seed": 666031,
        "description": (
            "fictional adult woman age 31, tall voluptuous hourglass figure, "
            "long voluminous wavy jet-black hair, warm pale skin, amber eyes, "
            "mature angular face, controlled intimidating expression, "
            "black tailored executive blazer, ivory silk blouse, fitted knee-length pencil skirt, "
            "black tights, black pumps, restrained gold jewelry, HellCorp executive badge"
        ),
        "palette": ["#0D0D0F", "#242127", "#4B3434", "#8A2026", "#C38B34", "#E0B99E", "#F2D7C4"],
    },
    "lucy": {
        "display_name": "Lucy",
        "age": 28,
        "role": "Executive Assistant",
        "seed": 666028,
        "description": (
            "fictional adult woman age 28, curvy feminine figure, medium height, "
            "honey-blonde hair in a polished high bun with two loose strands, green eyes, black glasses, "
            "mature intelligent friendly face, fitted white corporate blouse with rolled sleeves, "
            "black knee-length pencil skirt, black tights, black pumps, slim gold watch, "
            "HellCorp assistant badge and black tablet"
        ),
        "palette": ["#171619", "#2F2927", "#6D4A2E", "#B88653", "#E4C29E", "#F1E8DE", "#496252"],
    },
    "malphas": {
        "display_name": "Malphas",
        "age": 34,
        "role": "Head of Occult Affairs",
        "seed": 666034,
        "description": (
            "fictional adult demon woman age 34, tall voluptuous athletic hourglass figure, "
            "very long silver-white hair, violet eyes, pointed ears, symmetrical elegant black horns, "
            "mature calm dangerous face, burgundy tailored blazer over a black blouse, "
            "high-waisted fitted black trousers, black pumps, restrained occult gold jewelry, "
            "HellCorp occult badge and one closed black grimoire"
        ),
        "palette": ["#111116", "#29232C", "#571E29", "#8C3341", "#C08D3F", "#8B7B9D", "#E5D9D6"],
    },
}

POSES = {
    "idle_front": {"view": "front view", "pose": "neutral upright idle stance, arms relaxed at sides"},
    "idle_back": {"view": "back view", "pose": "neutral upright idle stance, arms relaxed at sides"},
    "idle_left": {"view": "left side profile", "pose": "neutral upright idle stance"},
    "idle_right": {"view": "right side profile", "pose": "neutral upright idle stance"},
    "walk_front_a": {"view": "front view", "pose": "walking keyframe, left foot forward, opposite arm swing"},
    "walk_front_b": {"view": "front view", "pose": "walking passing keyframe, feet close, torso centered"},
    "walk_front_c": {"view": "front view", "pose": "walking keyframe, right foot forward, opposite arm swing"},
    "walk_back_a": {"view": "back view", "pose": "walking keyframe, left foot forward, opposite arm swing"},
    "walk_back_b": {"view": "back view", "pose": "walking passing keyframe, feet close, torso centered"},
    "walk_back_c": {"view": "back view", "pose": "walking keyframe, right foot forward, opposite arm swing"},
    "walk_left_a": {"view": "left side profile", "pose": "walking contact keyframe, front leg extended"},
    "walk_left_b": {"view": "left side profile", "pose": "walking passing keyframe, rear foot lifted"},
    "walk_left_c": {"view": "left side profile", "pose": "walking opposite contact keyframe"},
    "walk_right_a": {"view": "right side profile", "pose": "walking contact keyframe, front leg extended"},
    "walk_right_b": {"view": "right side profile", "pose": "walking passing keyframe, rear foot lifted"},
    "walk_right_c": {"view": "right side profile", "pose": "walking opposite contact keyframe"},
    "talk": {"view": "front three-quarter view", "pose": "speaking with one hand making a small professional gesture"},
    "present": {"view": "front three-quarter view", "pose": "presenting information with one open palm"},
    "sit": {"view": "left three-quarter view", "pose": "seated upright on a simple office chair, feet grounded"},
    "use_pc": {"view": "left three-quarter view", "pose": "seated at a minimal office desk using a computer keyboard"},
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def font(size: int, bold: bool = False):
    candidates = []
    if os.uname().sysname == "Darwin":
        candidates.extend([
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        ])
    candidates.extend([
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ])
    for path in candidates:
        try:
            if Path(path).exists():
                return ImageFont.truetype(path, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def init_root(root: Path):
    for rel in ["config", "cache/huggingface", "cache/mflux", "characters", "guides", "inspiration", "tools"]:
        (root / rel).mkdir(parents=True, exist_ok=True)
    cfg = root / "config" / "characters.json"
    if not cfg.exists():
        cfg.write_text(json.dumps(DEFAULT_CHARACTERS, ensure_ascii=False, indent=2), encoding="utf-8")
    create_guides(root / "guides")
    readme = root / "README_FIRST.txt"
    if not readme.exists():
        readme.write_text(
            "HellCorp AI assets\n\n"
            "1. Valider un master unique par personnage.\n"
            "2. Ne jamais regenerer les animations finales directement frame par frame.\n"
            "3. Utiliser les sorties world comme references, puis finaliser les cycles dans Godot/Aseprite.\n"
            "4. Verifier la licence de toute LoRA tierce avant usage commercial.\n",
            encoding="utf-8",
        )


def load_cfg(root: Path):
    cfg = root / "config" / "characters.json"
    if not cfg.exists():
        init_root(root)
    data = json.loads(cfg.read_text(encoding="utf-8"))
    for key, value in data.items():
        if int(value.get("age", 0)) < 21:
            raise SystemExit(f"{key}: age invalide. Tous les personnages doivent etre explicitement adultes.")
    return data


def draw_mannequin(draw: ImageDraw.ImageDraw, pose: str, w: int, h: int):
    spec = POSES.get(pose, POSES["idle_front"])
    cx = w // 2
    top = int(h * 0.12)
    head_r = int(w * 0.055)
    neck_y = top + head_r * 2 + 12
    shoulder_y = neck_y + 25
    hip_y = int(h * 0.54)
    knee_y = int(h * 0.73)
    foot_y = int(h * 0.91)
    color = (38, 46, 58)
    joint = (166, 62, 70)
    width = max(8, w // 70)

    # Pose offsets.
    left_foot_x = cx - int(w * 0.07)
    right_foot_x = cx + int(w * 0.07)
    left_hand = (cx - int(w * 0.16), int(h * 0.47))
    right_hand = (cx + int(w * 0.16), int(h * 0.47))

    if "walk" in pose:
        phase = pose[-1]
        if phase == "a":
            left_foot_x -= int(w * 0.10)
            right_foot_x += int(w * 0.04)
            left_hand = (cx + int(w * 0.13), int(h * 0.42))
            right_hand = (cx - int(w * 0.13), int(h * 0.49))
        elif phase == "c":
            left_foot_x += int(w * 0.04)
            right_foot_x += int(w * 0.10)
            left_hand = (cx - int(w * 0.13), int(h * 0.49))
            right_hand = (cx + int(w * 0.13), int(h * 0.42))
    elif pose == "talk":
        right_hand = (cx + int(w * 0.20), int(h * 0.33))
    elif pose == "present":
        right_hand = (cx + int(w * 0.25), int(h * 0.43))
    elif pose in {"sit", "use_pc"}:
        hip_y = int(h * 0.56)
        knee_y = int(h * 0.66)
        foot_y = int(h * 0.82)
        left_foot_x = cx - int(w * 0.12)
        right_foot_x = cx + int(w * 0.12)
        left_hand = (cx - int(w * 0.08), int(h * 0.57))
        right_hand = (cx + int(w * 0.10), int(h * 0.57))

    head = (cx, top + head_r)
    neck = (cx, neck_y)
    l_sh = (cx - int(w * 0.09), shoulder_y)
    r_sh = (cx + int(w * 0.09), shoulder_y)
    l_el = ((l_sh[0] + left_hand[0]) // 2, (l_sh[1] + left_hand[1]) // 2)
    r_el = ((r_sh[0] + right_hand[0]) // 2, (r_sh[1] + right_hand[1]) // 2)
    hip = (cx, hip_y)
    l_hip = (cx - int(w * 0.055), hip_y)
    r_hip = (cx + int(w * 0.055), hip_y)
    l_knee = ((l_hip[0] + left_foot_x) // 2, knee_y)
    r_knee = ((r_hip[0] + right_foot_x) // 2, knee_y)
    l_foot = (left_foot_x, foot_y)
    r_foot = (right_foot_x, foot_y)

    draw.ellipse([head[0]-head_r, head[1]-head_r, head[0]+head_r, head[1]+head_r], outline=color, width=width)
    for a, b in [
        (neck, hip), (l_sh, r_sh), (l_sh, l_el), (l_el, left_hand),
        (r_sh, r_el), (r_el, right_hand), (l_hip, r_hip),
        (l_hip, l_knee), (l_knee, l_foot), (r_hip, r_knee), (r_knee, r_foot),
    ]:
        draw.line([a, b], fill=color, width=width)
    for p in [neck, l_sh, r_sh, l_el, r_el, left_hand, right_hand, l_hip, r_hip, l_knee, r_knee, l_foot, r_foot]:
        r = max(4, width // 2)
        draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r], fill=joint)

    label_font = font(28, bold=True)
    draw.text((24, 20), pose.upper(), fill=(88, 32, 38), font=label_font)
    draw.text((24, h - 58), f"POSE GUIDE ONLY - {spec['view']}", fill=(70, 70, 74), font=font(20))


def create_guides(folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    for pose in POSES:
        path = folder / f"{pose}.png"
        if path.exists():
            continue
        im = Image.new("RGB", (768, 1024), (244, 241, 235))
        d = ImageDraw.Draw(im)
        draw_mannequin(d, pose, 768, 1024)
        im.save(path)


def remove_flat_background(im: Image.Image, threshold: int = 42) -> Image.Image:
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    samples = [px[0, 0][:3], px[w-1, 0][:3], px[0, h-1][:3], px[w-1, h-1][:3]]
    bg = tuple(sorted(s[i] for s in samples)[len(samples)//2] for i in range(3))

    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            dist = math.sqrt((r-bg[0])**2 + (g-bg[1])**2 + (b-bg[2])**2)
            # White/gray studio backgrounds are removed. Dark character areas remain.
            if dist < threshold or (r > 238 and g > 235 and b > 230):
                ap[x, y] = 0
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.65))
    rgba.putalpha(alpha)
    return rgba


def add_outline(im: Image.Image, radius: int = 1) -> Image.Image:
    if radius <= 0:
        return im
    alpha = im.getchannel("A")
    expanded = alpha.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    outline_alpha = ImageChops.subtract(expanded, alpha)
    outline = Image.new("RGBA", im.size, (19, 18, 22, 0))
    outline.putalpha(outline_alpha)
    return Image.alpha_composite(outline, im)


def quantize_rgba(im: Image.Image, colors: int) -> Image.Image:
    colors = max(8, min(256, int(colors)))
    alpha = im.getchannel("A")
    base = Image.new("RGB", im.size, (244, 241, 235))
    base.paste(im.convert("RGB"), mask=alpha)
    q = base.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).convert("RGBA")
    q.putalpha(alpha)
    return q


def normalize_sprite(input_path: Path, output_path: Path, target_h: int, cell_w: int, cell_h: int, colors: int, outline: int):
    im = Image.open(input_path).convert("RGBA")
    im = remove_flat_background(im)
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        raise SystemExit(f"Fond non retire ou image vide: {input_path}")
    im = im.crop(bbox)
    scale = min(target_h / im.height, (cell_w - 16) / im.width)
    nw = max(1, round(im.width * scale))
    nh = max(1, round(im.height * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    im = quantize_rgba(im, colors)
    im = add_outline(im, outline)

    canvas = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
    baseline = cell_h - 10
    x = (cell_w - im.width) // 2
    y = baseline - im.height
    if y < 2:
        y = 2
    canvas.alpha_composite(im, (x, y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)


def fit(im: Image.Image, box, bg=(25, 26, 29, 255), pad=10):
    x, y, w, h = box
    tile = Image.new("RGBA", (w, h), bg)
    content = ImageOps.contain(im.convert("RGBA"), (max(1, w-pad*2), max(1, h-pad*2)), Image.Resampling.LANCZOS)
    tile.alpha_composite(content, ((w-content.width)//2, (h-content.height)//2))
    return tile


def draw_label(draw, xy, text, size=24, fill=(226, 226, 229), bold=False):
    draw.text(xy, text, font=font(size, bold=bold), fill=fill)


def top_palette(images, n=16):
    counter = Counter()
    for im in images:
        rgba = im.convert("RGBA").resize((64, 64), Image.Resampling.NEAREST)
        for r, g, b, a in rgba.getdata():
            if a > 100:
                key = (r//24*24, g//24*24, b//24*24)
                counter[key] += 1
    return [c for c, _ in counter.most_common(n)]


def sheet(root: Path, character: str):
    cfg = load_cfg(root)
    if character not in cfg:
        raise SystemExit(f"Personnage inconnu: {character}")
    c = cfg[character]
    base = root / "characters" / character
    master = base / "master" / "master.png"
    portrait = base / "portrait" / "portrait.png"
    expr_dir = base / "expressions"
    sprite_dir = base / "world" / "sprites"

    if not master.exists():
        raise SystemExit(f"Master absent: {master}")

    W, H = 2048, 1536
    bg = (17, 19, 22, 255)
    panel = (28, 30, 34, 255)
    line = (86, 54, 49, 255)
    gold = (210, 151, 63, 255)
    white = (233, 231, 229, 255)
    muted = (169, 169, 174, 255)

    canvas = Image.new("RGBA", (W, H), bg)
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, W-1, H-1], outline=(89, 90, 94), width=2)
    d.rectangle([0, 0, W, 92], fill=(12, 14, 17))
    draw_label(d, (36, 20), "HELLCORP", 46, (180, 49, 55), True)
    draw_label(d, (325, 30), f"{c['display_name'].upper()} — {c['role'].upper()}", 32, white, True)
    draw_label(d, (36, 105), "SPLASH / MASTER", 24, gold, True)
    draw_label(d, (590, 105), "PORTRAIT ANIME", 24, gold, True)
    draw_label(d, (1030, 105), "EXPRESSIONS", 24, gold, True)
    draw_label(d, (590, 700), "SPRITES MONDE — GODOT", 24, gold, True)

    # Panels
    d.rounded_rectangle([26, 140, 555, 1478], radius=12, fill=panel, outline=line, width=2)
    d.rounded_rectangle([580, 140, 1005, 670], radius=12, fill=panel, outline=line, width=2)
    d.rounded_rectangle([1020, 140, 2020, 670], radius=12, fill=panel, outline=line, width=2)
    d.rounded_rectangle([580, 735, 2020, 1478], radius=12, fill=panel, outline=line, width=2)

    master_im = Image.open(master).convert("RGBA")
    canvas.alpha_composite(fit(master_im, (44, 160, 493, 1110), panel), (44, 160))
    draw_label(d, (52, 1292), f"AGE: {c['age']}   ROLE: {c['role']}", 22, muted)
    desc = c["description"]
    words = desc.split()
    lines, current = [], []
    for word in words:
        trial = " ".join(current + [word])
        if len(trial) > 46:
            lines.append(" ".join(current)); current = [word]
        else:
            current.append(word)
    if current: lines.append(" ".join(current))
    yy = 1330
    for line_text in lines[:6]:
        draw_label(d, (52, yy), line_text, 18, muted); yy += 25

    if portrait.exists():
        portrait_im = Image.open(portrait).convert("RGBA")
    else:
        portrait_im = master_im
    canvas.alpha_composite(fit(portrait_im, (598, 158, 389, 492), panel), (598, 158))

    exprs = []
    for p in sorted(expr_dir.glob("*.png")) if expr_dir.exists() else []:
        exprs.append((p.stem, Image.open(p).convert("RGBA")))
    if not exprs:
        exprs = [("reference", portrait_im)]
    cols = 3
    cell_w, cell_h = 310, 225
    for idx, (name, im) in enumerate(exprs[:6]):
        col, row = idx % cols, idx // cols
        x, y = 1040 + col * 320, 160 + row * 245
        canvas.alpha_composite(fit(im, (x, y, cell_w, 190), panel, 5), (x, y))
        draw_label(d, (x+8, y+194), name.replace("_", " ").upper(), 18, muted, True)

    sprites = []
    for p in sorted(sprite_dir.glob("*.png")) if sprite_dir.exists() else []:
        sprites.append((p.stem, Image.open(p).convert("RGBA")))
    sprite_cols = 7
    scw, sch = 190, 260
    for idx, (name, im) in enumerate(sprites[:21]):
        col, row = idx % sprite_cols, idx // sprite_cols
        x, y = 604 + col * 198, 770 + row * 224
        checker = Image.new("RGBA", (scw, 190), (22, 23, 27, 255))
        cd = ImageDraw.Draw(checker)
        for cy in range(0, 190, 16):
            for cx in range(0, scw, 16):
                if (cx//16 + cy//16) % 2 == 0:
                    cd.rectangle([cx, cy, cx+15, cy+15], fill=(31, 32, 37, 255))
        content = ImageOps.contain(im, (scw-8, 186), Image.Resampling.NEAREST)
        checker.alpha_composite(content, ((scw-content.width)//2, 190-content.height))
        canvas.alpha_composite(checker, (x, y))
        draw_label(d, (x+4, y+194), name.replace("_", " ").upper(), 14, muted, True)

    palette_images = [im for _, im in sprites] or [portrait_im]
    palette = top_palette(palette_images, 18)
    draw_label(d, (604, 1435), "PALETTE", 17, gold, True)
    for idx, color in enumerate(palette):
        x = 720 + idx * 60
        d.rectangle([x, 1428, x+48, 1462], fill=(*color, 255), outline=(90, 90, 95))

    out = root / "inspiration" / f"{character}_inspiration_sheet.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out, quality=96)
    print(out)


def catalog(root: Path, characters):
    sheets = []
    for char in characters:
        p = root / "inspiration" / f"{char}_inspiration_sheet.png"
        if p.exists():
            sheets.append((char, Image.open(p).convert("RGB")))
    if not sheets:
        raise SystemExit("Aucune planche disponible.")
    width = 1600
    resized = []
    for char, im in sheets:
        h = round(im.height * width / im.width)
        resized.append((char, im.resize((width, h), Image.Resampling.LANCZOS)))
    total_h = sum(im.height for _, im in resized) + 34 * (len(resized) - 1)
    canvas = Image.new("RGB", (width, total_h), (12, 14, 17))
    y = 0
    for _, im in resized:
        canvas.paste(im, (0, y)); y += im.height + 34
    out = root / "inspiration" / "hellcorp_three_characters.png"
    canvas.save(out, quality=95)
    print(out)


def record(root: Path, character: str, kind: str, output: Path, prompt: str, seed: int, model: str, quantize: int, reference: str = ""):
    manifest_path = root / "characters" / character / "manifest.json"
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        data = {"character": character, "created_at": now_iso(), "assets": []}
    item = {
        "kind": kind,
        "file": str(output.relative_to(root)) if output.is_relative_to(root) else str(output),
        "sha256": sha256(output) if output.exists() else None,
        "prompt": prompt,
        "seed": seed,
        "model": model,
        "quantize": quantize,
        "reference": reference,
        "generated_at": now_iso(),
    }
    data["assets"] = [x for x in data.get("assets", []) if x.get("file") != item["file"]]
    data["assets"].append(item)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("init"); a.add_argument("--root", required=True)
    a = sub.add_parser("field"); a.add_argument("--root", required=True); a.add_argument("--character", required=True); a.add_argument("--field", required=True)
    a = sub.add_parser("pose"); a.add_argument("--pose", required=True); a.add_argument("--field", required=True)
    a = sub.add_parser("normalize"); a.add_argument("--input", required=True); a.add_argument("--output", required=True); a.add_argument("--height", type=int, required=True); a.add_argument("--cell", type=int, required=True); a.add_argument("--colors", type=int, required=True); a.add_argument("--outline", type=int, default=1)
    a = sub.add_parser("sheet"); a.add_argument("--root", required=True); a.add_argument("--character", required=True)
    a = sub.add_parser("catalog"); a.add_argument("--root", required=True); a.add_argument("--characters", nargs="+", required=True)
    a = sub.add_parser("record"); a.add_argument("--root", required=True); a.add_argument("--character", required=True); a.add_argument("--kind", required=True); a.add_argument("--output", required=True); a.add_argument("--prompt", required=True); a.add_argument("--seed", type=int, required=True); a.add_argument("--model", required=True); a.add_argument("--quantize", type=int, required=True); a.add_argument("--reference", default="")

    args = p.parse_args()
    if args.cmd == "init":
        init_root(Path(args.root)); print(Path(args.root))
    elif args.cmd == "field":
        cfg = load_cfg(Path(args.root));
        if args.character not in cfg: raise SystemExit(f"Personnage inconnu: {args.character}")
        value = cfg[args.character].get(args.field)
        if isinstance(value, (dict, list)): print(json.dumps(value, ensure_ascii=False))
        else: print(value)
    elif args.cmd == "pose":
        if args.pose not in POSES: raise SystemExit(f"Pose inconnue: {args.pose}")
        print(POSES[args.pose].get(args.field, ""))
    elif args.cmd == "normalize":
        normalize_sprite(Path(args.input), Path(args.output), args.height, args.cell, args.cell, args.colors, args.outline)
    elif args.cmd == "sheet":
        sheet(Path(args.root), args.character)
    elif args.cmd == "catalog":
        catalog(Path(args.root), args.characters)
    elif args.cmd == "record":
        record(Path(args.root), args.character, args.kind, Path(args.output), args.prompt, args.seed, args.model, args.quantize, args.reference)

if __name__ == "__main__":
    main()
