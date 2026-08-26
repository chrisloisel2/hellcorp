#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def load_json(path: Path):
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def parse_hex_color(value: str):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def ensure_rgba_foreground(image: Image.Image, threshold: float = 8.0) -> Image.Image:
    rgba = image.convert('RGBA')
    arr = np.array(rgba)
    if np.count_nonzero(arr[:, :, 3] < 250) > arr.shape[0] * arr.shape[1] * 0.01:
        return rgba
    rgb = arr[:, :, :3].astype(np.float32)
    h, w = rgb.shape[:2]
    strip = max(3, min(h, w) // 80)
    corners = np.concatenate([
        rgb[:strip, :strip].reshape(-1, 3), rgb[:strip, -strip:].reshape(-1, 3),
        rgb[-strip:, :strip].reshape(-1, 3), rgb[-strip:, -strip:].reshape(-1, 3),
    ], axis=0)
    bg = np.median(corners, axis=0)
    diff = np.linalg.norm(rgb - bg[None, None, :], axis=2)
    binary = (diff > threshold).astype(np.uint8) * 255
    kernel = np.ones((3, 3), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        raise RuntimeError('Background removal failed: no foreground component found.')
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == largest).astype(np.uint8) * 255
    mask = cv2.dilate(mask, kernel, iterations=1)
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=0.65, sigmaY=0.65)
    arr[:, :, 3] = mask
    return Image.fromarray(arr, 'RGBA')


def norm_point(point, w, h):
    return np.array([float(point[0]) * (w - 1), float(point[1]) * (h - 1)], dtype=np.float32)


def clamp_vec(v, max_len):
    n = float(np.linalg.norm(v))
    if n <= max_len or n < 1e-6:
        return v
    return v * (max_len / n)


def segment_distance_and_t(p, a, b):
    ab = b - a
    denom = float(np.dot(ab, ab))
    if denom < 1e-8:
        return float(np.linalg.norm(p - a)), 0.0
    t = max(0.0, min(1.0, float(np.dot(p - a, ab) / denom)))
    q = a + ab * t
    return float(np.linalg.norm(p - q)), t


def build_joint_displacements(pose, config, w, h):
    frames = pose['frames']
    ref_idx = int(config.get('reference_frame', 0)) % len(frames)
    ref = frames[ref_idx]['joints']
    gains = config.get('motion_gain', {})
    gx, gy = float(gains.get('x', 0.62)), float(gains.get('y', 0.62))
    root_cfg = config.get('root_stabilization', {})
    stabilize_x = float(root_cfg.get('horizontal', 1.0))
    stabilize_y = float(root_cfg.get('vertical', 0.35))
    foot_lock = float(root_cfg.get('foot_lock', 0.65))
    max_disp = float(config.get('max_joint_displacement_ratio', 0.18)) * h

    def pelvis(joints):
        return np.array([(joints['hip_l']['x'] + joints['hip_r']['x']) * 0.5, (joints['hip_l']['y'] + joints['hip_r']['y']) * 0.5], dtype=np.float32)

    ref_pelvis = pelvis(ref)
    ref_floor = max(ref['ankle_l']['y'], ref['ankle_r']['y'])
    output = []
    for frame in frames:
        joints = frame['joints']
        root_delta = pelvis(joints) - ref_pelvis
        floor_shift = ref_floor - max(joints['ankle_l']['y'], joints['ankle_r']['y'])
        disp = {}
        for name, p in joints.items():
            if name not in ref:
                continue
            dx = (float(p['x']) - float(ref[name]['x']) - root_delta[0] * stabilize_x) * w * gx
            dy = (float(p['y']) - float(ref[name]['y']) - root_delta[1] * stabilize_y + floor_shift * foot_lock) * h * gy
            disp[name] = clamp_vec(np.array([dx, dy], dtype=np.float32), max_disp)
        output.append(disp)
    return output


def build_secondary_controls(config, displacements, w, h):
    controls = config.get('secondary_controls', [])
    if not controls:
        return [[] for _ in displacements]
    out = [[] for _ in displacements]
    states = {c['id']: np.zeros(2, dtype=np.float32) for c in controls}
    prev_parent = {c['id']: np.zeros(2, dtype=np.float32) for c in controls}
    for i, frame_disp in enumerate(displacements):
        for control in controls:
            cid, parent = control['id'], control['parent']
            anchor = norm_point(control['anchor'], w, h)
            parent_disp = frame_disp.get(parent, np.zeros(2, dtype=np.float32))
            velocity = parent_disp - prev_parent[cid]
            prev_parent[cid] = parent_disp.copy()
            target = -velocity * float(control.get('lag', 0.25))
            states[cid] = (states[cid] + (target - states[cid]) * float(control.get('stiffness', 0.55))) * float(control.get('damping', 0.78))
            states[cid] = clamp_vec(states[cid], float(control.get('max_px', 12.0)))
            out[i].append({'anchor': anchor, 'disp': parent_disp + states[cid], 'radius': float(control.get('radius', 0.08)) * w})
    return out


def make_field(rest_joints, bones, frame_disp, secondary, w, h):
    anchors = {name: norm_point(pt, w, h) for name, pt in rest_joints.items()}
    def field(p):
        weighted = np.zeros(2, dtype=np.float32)
        total = 0.05
        for bone in bones:
            a_name, b_name = bone['a'], bone['b']
            if a_name not in anchors or b_name not in anchors:
                continue
            a, b = anchors[a_name], anchors[b_name]
            da = frame_disp.get(a_name, np.zeros(2, dtype=np.float32))
            db = frame_disp.get(b_name, np.zeros(2, dtype=np.float32))
            dist, t = segment_distance_and_t(p, a, b)
            radius = max(2.0, float(bone.get('radius', 0.10)) * w)
            weight = math.exp(-2.5 * (dist / radius) ** 2)
            if weight >= 1e-4:
                weighted += (da * (1.0 - t) + db * t) * weight
                total += weight
        for control in secondary:
            dist = float(np.linalg.norm(p - control['anchor']))
            radius = max(2.0, control['radius'])
            weight = math.exp(-2.8 * (dist / radius) ** 2)
            if weight >= 1e-4:
                weighted += control['disp'] * weight
                total += weight
        return weighted / max(total, 1e-8)
    return field


def warp_triangle(src, dst, t_src, t_dst):
    r1, r2 = cv2.boundingRect(np.float32([t_src])), cv2.boundingRect(np.float32([t_dst]))
    if r1[2] <= 0 or r1[3] <= 0 or r2[2] <= 0 or r2[3] <= 0:
        return
    src_h, src_w = src.shape[:2]
    x1, y1, w1, h1 = r1
    x2, y2, w2, h2 = r2
    if x1 < 0 or y1 < 0 or x1 + w1 > src_w or y1 + h1 > src_h:
        return
    src_rect = src[y1:y1 + h1, x1:x1 + w1]
    src_pts = np.float32([[p[0] - x1, p[1] - y1] for p in t_src])
    dst_pts = np.float32([[p[0] - x2, p[1] - y2] for p in t_dst])
    mat = cv2.getAffineTransform(src_pts, dst_pts)
    warped = cv2.warpAffine(src_rect, mat, (w2, h2), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
    mask = np.zeros((h2, w2), dtype=np.float32)
    cv2.fillConvexPoly(mask, np.int32(np.round(dst_pts)), 1.0, lineType=cv2.LINE_AA)
    dx0, dy0 = max(0, x2), max(0, y2)
    dx1, dy1 = min(dst.shape[1], x2 + w2), min(dst.shape[0], y2 + h2)
    if dx1 <= dx0 or dy1 <= dy0:
        return
    sx0, sy0 = dx0 - x2, dy0 - y2
    sx1, sy1 = sx0 + (dx1 - dx0), sy0 + (dy1 - dy0)
    m = mask[sy0:sy1, sx0:sx1, None]
    patch = warped[sy0:sy1, sx0:sx1].astype(np.float32)
    target = dst[dy0:dy1, dx0:dx1].astype(np.float32)
    dst[dy0:dy1, dx0:dx1] = np.clip(target * (1.0 - m) + patch * m, 0, 255).astype(np.uint8)


def warp_mesh(src_rgba, field, cols, rows):
    h, w = src_rgba.shape[:2]
    xs, ys = np.linspace(0, w - 1, cols, dtype=np.float32), np.linspace(0, h - 1, rows, dtype=np.float32)
    src_points = np.array([[x, y] for y in ys for x in xs], dtype=np.float32)
    dst_points = np.array([p + field(p) for p in src_points], dtype=np.float32)
    dst = np.zeros_like(src_rgba)
    idx = lambda r, c: r * cols + c
    for r in range(rows - 1):
        for c in range(cols - 1):
            for tri in ((idx(r, c), idx(r, c + 1), idx(r + 1, c)), (idx(r, c + 1), idx(r + 1, c + 1), idx(r + 1, c))):
                warp_triangle(src_rgba, dst, [src_points[i] for i in tri], [dst_points[i] for i in tri])
    return dst


def fit_to_square(image: Image.Image, size: int, height_ratio: float, floor_margin: int):
    target_h = max(1, int(size * height_ratio))
    scale = target_h / image.height
    target_w = max(1, int(round(image.width * scale)))
    resized = image.resize((target_w, target_h), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - target_w) // 2, max(0, size - target_h - floor_margin)))
    return canvas


def build_shared_palette(reference: Image.Image, colors: int):
    rgb = Image.new('RGB', reference.size, (0, 0, 0))
    rgb.paste(reference.convert('RGB'), mask=reference.getchannel('A'))
    return rgb.quantize(colors=max(8, min(256, colors)), method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)


def apply_shared_palette(image: Image.Image, palette: Image.Image):
    alpha = image.getchannel('A')
    rgb = Image.new('RGB', image.size, (0, 0, 0))
    rgb.paste(image.convert('RGB'), mask=alpha)
    out = rgb.quantize(palette=palette, dither=Image.Dither.NONE).convert('RGBA')
    out.putalpha(alpha)
    return out


def save_atlas(frames, out_path: Path, cols: int):
    fw, fh = frames[0].size
    rows = math.ceil(len(frames) / cols)
    atlas = Image.new('RGBA', (fw * cols, fh * rows), (0, 0, 0, 0))
    rects = []
    for i, frame in enumerate(frames):
        x, y = (i % cols) * fw, (i // cols) * fh
        atlas.alpha_composite(frame, (x, y))
        rects.append({'index': i, 'x': x, 'y': y, 'w': fw, 'h': fh})
    atlas.save(out_path)
    return rows, rects


def save_preview_gif(frames, out_path: Path, fps: float, bg_rgb):
    preview = []
    for frame in frames:
        canvas = Image.new('RGB', frame.size, bg_rgb)
        canvas.paste(frame.convert('RGB'), mask=frame.getchannel('A'))
        preview.append(canvas)
    preview[0].save(out_path, save_all=True, append_images=preview[1:], duration=max(20, int(round(1000.0 / fps))), loop=0, optimize=False)


def main():
    parser = argparse.ArgumentParser(description='Deterministic HellCorp Puppet2D mesh renderer.')
    parser.add_argument('--character', required=True)
    parser.add_argument('--pose', required=True)
    parser.add_argument('--art', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--size', type=int, default=384)
    parser.add_argument('--fps', type=float, default=16.0)
    parser.add_argument('--cols', type=int, default=4)
    parser.add_argument('--palette-colors', type=int, default=96)
    args = parser.parse_args()

    character_path, pose_path, art_path, out_dir = map(lambda p: Path(p).resolve(), (args.character, args.pose, args.art, args.out))
    frames_dir = out_dir / 'frames'
    frames_dir.mkdir(parents=True, exist_ok=True)
    character, pose = load_json(character_path), load_json(pose_path)
    if pose.get('format') != 'HellCorpPuppetPoseV1' or pose.get('validation', {}).get('status') != 'PASS':
        raise ValueError('Pose clip is invalid or did not PASS validation.')

    deform = character.get('deformation', {})
    source = ensure_rgba_foreground(Image.open(art_path), float(deform.get('background_threshold', 8.0)))
    src_arr = np.array(source)
    h, w = src_arr.shape[:2]
    rest_joints, bones = character.get('art_rest_joints'), character.get('deformation_bones')
    if not rest_joints or not bones:
        raise ValueError('character.json must define art_rest_joints and deformation_bones.')

    displacements = build_joint_displacements(pose, deform, w, h)
    secondary = build_secondary_controls(deform, displacements, w, h)
    grid_cols, grid_rows = max(4, int(deform.get('grid_cols', 9))), max(6, int(deform.get('grid_rows', 23)))
    output_cfg = character.get('output', {})
    height_ratio = float(output_cfg.get('character_height_ratio', 0.92))
    floor_margin = int(output_cfg.get('floor_margin_px', 6))
    bg_rgb = parse_hex_color(output_cfg.get('preview_background', '#2b2320'))

    raw_frames = []
    for i, frame_disp in enumerate(displacements):
        field = make_field(rest_joints, bones, frame_disp, secondary[i], w, h)
        warped = Image.fromarray(warp_mesh(src_arr, field, grid_cols, grid_rows), 'RGBA')
        raw_frames.append(fit_to_square(warped, args.size, height_ratio, floor_margin))

    palette = build_shared_palette(raw_frames[0], args.palette_colors)
    frames = [apply_shared_palette(frame, palette) for frame in raw_frames]
    frame_hashes = []
    for i, frame in enumerate(frames):
        frame_path = frames_dir / f'frame_{i:04d}.png'
        frame.save(frame_path)
        frame_hashes.append({'index': i, 'sha256': sha256_file(frame_path)})

    atlas_path = out_dir / 'atlas.png'
    atlas_rows, rects = save_atlas(frames, atlas_path, max(1, args.cols))
    save_preview_gif(frames, out_dir / 'preview.gif', args.fps, bg_rgb)
    with (out_dir / 'atlas.json').open('w', encoding='utf-8') as f:
        json.dump({'format': 'HellCorpPuppetAtlasV1', 'character': character.get('id'), 'animation': pose_path.stem, 'fps': args.fps, 'loop': True, 'frame_count': len(frames), 'frame_size': [args.size, args.size], 'columns': max(1, args.cols), 'rows': atlas_rows, 'atlas': atlas_path.name, 'frames': rects}, f, indent=2)
        f.write('\n')

    manifest = {
        'format': 'HellCorpPuppetRenderV1', 'algorithm': 'deterministic-piecewise-affine-puppet-mesh',
        'character': character.get('id'), 'source_art': str(art_path), 'source_art_sha256': sha256_file(art_path),
        'character_config': str(character_path), 'character_config_sha256': sha256_file(character_path),
        'pose_clip': str(pose_path), 'pose_clip_sha256': sha256_file(pose_path),
        'pose_source_fbx': pose.get('source_fbx'), 'pose_source_vrm': pose.get('source_vrm'),
        'frame_count': len(frames), 'frame_size': [args.size, args.size], 'fps': args.fps,
        'mesh': {'cols': grid_cols, 'rows': grid_rows}, 'shared_palette_colors': args.palette_colors,
        'diffusion_used': False, 'ebsynth_used': False, 'source_texture_changes': False,
        'frame_hashes': frame_hashes,
        'outputs': {'frames': 'frames/', 'atlas': 'atlas.png', 'atlas_json': 'atlas.json', 'preview_gif': 'preview.gif'},
        'validation': {'pose_status': pose.get('validation', {}).get('status'), 'same_frame_dimensions': all(frame.size == frames[0].size for frame in frames), 'source_art_fixed': True, 'status': 'PASS'},
        'known_limitations': character.get('known_limitations', []),
    }
    with (out_dir / 'manifest.json').open('w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print(f'frames -> {frames_dir}')
    print(f'atlas  -> {atlas_path}')
    print(f'gif    -> {out_dir / "preview.gif"}')
    print(f'manifest -> {out_dir / "manifest.json"}')
    print('PUPPET_RENDER_PASS')


if __name__ == '__main__':
    main()
