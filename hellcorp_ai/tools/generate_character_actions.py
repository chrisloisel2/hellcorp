#!/usr/bin/env python3
"""Generate a set of game-ready action clips for one character with Wan2.2 I2V.

Takes ONE already-stylized reference image (a character keyframe, e.g. produced by
the SDXL pipeline in sdxl_lora_bench/) and animates it once per action listed in
config/actions.json. Each action is generated independently by the video model —
identity/outfit consistency comes from the model's own temporal attention over the
whole clip, not from re-describing the character every time, which is why prompts
in actions.json only describe the motion.

Two backends, same action manifest and same output layout:
  --backend mlx        Apple Silicon / MLX (this repo's validated path, macOS only)
  --backend diffusers  CUDA / Linux (or CPU) via the HuggingFace diffusers WanImageToVideoPipeline

Output per action, under <output-dir>/<action-name>/:
  frames/frame_000000.png ...   extracted PNG frames
  atlas.png, atlas.json         sprite atlas (same schema as the vrm2sprite pipeline)
  manifest.json                 provenance + frame hashes
  preview.gif                   quick-look animated preview
"""
import argparse
import hashlib
import json
import math
import platform
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ACTIONS_FILE = REPO_ROOT / "hellcorp_ai" / "config" / "actions.json"
DEFAULT_MLX_MODEL_DIR = REPO_ROOT / "hellcorp_ai" / "runtime" / "mlx-video" / "Wan2.2-TI2V-5B-MLX"
DEFAULT_MLX_PROJECT_DIR = REPO_ROOT / "hellcorp_ai" / "runtime" / "mlx-video"
DEFAULT_DIFFUSERS_MODEL_ID = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_backend() -> str:
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "mlx"
    return "diffusers"


def run_mlx_action(action, image_path, width, height, seed, negative_prompt, model_dir, project_dir, out_video):
    cmd = [
        "uv", "run", "python3", "-m", "mlx_video.models.wan_2.generate",
        "--model-dir", str(model_dir),
        "--image", str(image_path),
        "--prompt", action["prompt"],
        "--negative-prompt", negative_prompt,
        "--width", str(width),
        "--height", str(height),
        "--num-frames", str(action["num_frames"]),
        "--seed", str(seed),
        "--output-path", str(out_video),
    ]
    print(f"[{action['name']}] running (mlx): {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=str(project_dir), check=True)


def run_diffusers_action(action, image_path, width, height, seed, negative_prompt, model_id, out_video):
    # Imported lazily: only needed on the diffusers backend, so the mlx-only
    # path never has to have torch/diffusers/CUDA installed.
    import torch
    from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
    from diffusers.utils import export_to_video, load_image

    global _DIFFUSERS_PIPE
    if "_DIFFUSERS_PIPE" not in globals() or _DIFFUSERS_PIPE is None:
        print(f"Loading {model_id} (diffusers)...", flush=True)
        vae = AutoencoderKLWan.from_pretrained(model_id, subfolder="vae", torch_dtype=torch.float32)
        pipe = WanImageToVideoPipeline.from_pretrained(model_id, vae=vae, torch_dtype=torch.bfloat16)
        if torch.cuda.is_available():
            pipe.to("cuda")
        else:
            # No CUDA: keep it runnable (slowly) on CPU rather than failing outright.
            pipe.enable_model_cpu_offload()
        _DIFFUSERS_PIPE = pipe
    pipe = _DIFFUSERS_PIPE

    image = load_image(str(image_path)).resize((width, height))
    generator = torch.Generator(device="cpu").manual_seed(seed)
    print(f"[{action['name']}] running (diffusers): {model_id}", flush=True)
    output = pipe(
        image=image,
        prompt=action["prompt"],
        negative_prompt=negative_prompt,
        num_frames=action["num_frames"],
        generator=generator,
    ).frames[0]
    export_to_video(output, str(out_video), fps=16)


def extract_frames_and_package(video_path: Path, out_dir: Path, action_name: str, fps_hint: int = 16):
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path), str(frames_dir / "frame_%06d.png")],
        check=True, capture_output=True,
    )
    frame_paths = sorted(frames_dir.glob("frame_*.png"))
    if not frame_paths:
        raise RuntimeError(f"No frames extracted for action '{action_name}'")

    from PIL import Image
    images = [Image.open(p).convert("RGBA") for p in frame_paths]
    w, h = images[0].size
    cols = max(1, math.ceil(math.sqrt(len(images))))
    rows = math.ceil(len(images) / cols)
    atlas = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, im in enumerate(images):
        atlas.alpha_composite(im, ((i % cols) * w, (i // cols) * h))
    atlas_path = out_dir / "atlas.png"
    atlas.save(atlas_path)

    atlas_json = {
        "frame_width": w, "frame_height": h, "cols": cols, "count": len(images),
        "atlas": "atlas.png",
        "frames": [
            {"index": i, "x": (i % cols) * w, "y": (i // cols) * h, "w": w, "h": h}
            for i in range(len(images))
        ],
    }
    with open(out_dir / "atlas.json", "w") as f:
        json.dump(atlas_json, f, indent=2)

    gif_path = out_dir / "preview.gif"
    images[0].convert("RGB").save(
        gif_path, save_all=True,
        append_images=[im.convert("RGB") for im in images[1:]] + [im.convert("RGB") for im in images[::-1]],
        duration=round(1000 / fps_hint), loop=0,
    )

    manifest = {
        "format": "HellCorpActionClipV1",
        "action": action_name,
        "frame_count": len(images),
        "frame_size": [w, h],
        "atlas": {"path": "atlas.png", "sha256": sha256_file(atlas_path)},
        "gif": {"path": "preview.gif", "sha256": sha256_file(gif_path)},
        "frames": [
            {"index": i, "path": f"frames/{p.name}", "sha256": sha256_file(p)}
            for i, p in enumerate(frame_paths)
        ],
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Generate game action clips from a reference character image (Wan2.2 I2V).")
    parser.add_argument("--image", required=True, help="Path to the reference character image")
    parser.add_argument("--output-dir", required=True, help="Directory to write one subfolder per action into")
    parser.add_argument("--actions-file", default=str(DEFAULT_ACTIONS_FILE), help="Path to actions.json")
    parser.add_argument("--actions", default=None, help="Comma-separated subset of action names to run (default: all)")
    parser.add_argument("--backend", choices=["mlx", "diffusers", "auto"], default="auto")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=960)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--mlx-model-dir", default=str(DEFAULT_MLX_MODEL_DIR))
    parser.add_argument("--mlx-project-dir", default=str(DEFAULT_MLX_PROJECT_DIR))
    parser.add_argument("--diffusers-model-id", default=DEFAULT_DIFFUSERS_MODEL_ID)
    args = parser.parse_args()

    backend = detect_backend() if args.backend == "auto" else args.backend
    print(f"Backend: {backend}", flush=True)

    with open(args.actions_file) as f:
        manifest = json.load(f)
    shared_negative = manifest["shared_negative_prompt"]
    actions = manifest["actions"]
    if args.actions:
        wanted = set(args.actions.split(","))
        actions = [a for a in actions if a["name"] in wanted]
        missing = wanted - {a["name"] for a in actions}
        if missing:
            raise SystemExit(f"Unknown action name(s): {', '.join(sorted(missing))}")

    image_path = Path(args.image).resolve()
    output_root = Path(args.output_dir).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    for action in actions:
        action_dir = output_root / action["name"]
        action_dir.mkdir(parents=True, exist_ok=True)
        video_path = action_dir / "raw.mp4"

        if backend == "mlx":
            run_mlx_action(
                action, image_path, args.width, args.height, args.seed, shared_negative,
                Path(args.mlx_model_dir), Path(args.mlx_project_dir), video_path,
            )
        elif backend == "diffusers":
            run_diffusers_action(
                action, image_path, args.width, args.height, args.seed, shared_negative,
                args.diffusers_model_id, video_path,
            )
        else:
            raise SystemExit(f"Unknown backend: {backend}")

        extract_frames_and_package(video_path, action_dir, action["name"])
        print(f"[{action['name']}] done -> {action_dir}", flush=True)

    print("ALL_ACTIONS_DONE", flush=True)


if __name__ == "__main__":
    main()
