import torch, time, os, glob, json, hashlib
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image, ImageFilter
import numpy as np
import imageio.v2 as imageio

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/lucy_walk_final"
FRAMES_OUT = os.path.join(OUT_DIR, "frames")
os.makedirs(FRAMES_OUT, exist_ok=True)

LORA_WEIGHT = 0.8
STRENGTH_PASS1 = 0.8
STRENGTH_PASS2 = 0.35
CANVAS = 1024
BG = (43, 35, 32)
COLS = 6
FPS = 16

PROMPT = (
    "pixel art, 2D game sprite, full body, walking pose, anime woman, "
    "platinum blonde hair in high bun with side-swept bangs, thin gold glasses, "
    "white dress shirt unbuttoned at the collar, black pencil skirt, "
    "dark stockings, black heels, black lanyard with ID badge, small pale horns, "
    "office demon, game asset, detailed shading, high quality"
)
NEGATIVE = (
    "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, "
    "extra limbs, different outfit, costume change"
)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def make_guide_and_alpha(raw_path, canvas):
    src = Image.open(raw_path).convert("RGBA")
    bg_img = Image.new("RGB", src.size, BG)
    bg_img.paste(src, mask=src.split()[3])
    guide = bg_img.resize((canvas, canvas), Image.Resampling.LANCZOS)

    alpha = src.split()[3].resize((canvas, canvas), Image.Resampling.LANCZOS)
    alpha = alpha.filter(ImageFilter.MaxFilter(9))
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.5))
    return guide, alpha


def make_atlas(images, cols):
    import math
    w, h = images[0].size
    rows = math.ceil(len(images) / cols)
    atlas = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, im in enumerate(images):
        x = (i % cols) * w
        y = (i // cols) * h
        atlas.alpha_composite(im, (x, y))
    return atlas


def main():
    frame_paths = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))
    print(f"{len(frame_paths)} source frames", flush=True)

    device = "mps"
    pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
    pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    pipe.load_lora_weights(LORA, adapter_name="summer_memories")
    pipe.set_adapters(["summer_memories"], adapter_weights=[LORA_WEIGHT])
    print("pipeline + lora ready", flush=True)

    processed = []
    manifest_frames = []
    for i, raw_path in enumerate(frame_paths):
        name = f"frame_{i:06d}.png"
        dst = os.path.join(FRAMES_OUT, name)
        t0 = time.time()

        guide, alpha = make_guide_and_alpha(raw_path, CANVAS)

        g1 = torch.Generator(device=device).manual_seed(1234)
        pass1 = pipe(
            prompt=PROMPT, negative_prompt=NEGATIVE, image=guide.resize((768, 768)),
            strength=STRENGTH_PASS1, guidance_scale=6.0, num_inference_steps=22, generator=g1,
        ).images[0]

        g2 = torch.Generator(device=device).manual_seed(4321)
        pass2 = pipe(
            prompt=PROMPT, negative_prompt=NEGATIVE, image=pass1.resize((CANVAS, CANVAS)),
            strength=STRENGTH_PASS2, guidance_scale=6.0, num_inference_steps=22, generator=g2,
        ).images[0]

        rgba = pass2.convert("RGBA")
        rgba.putalpha(alpha)
        rgba.save(dst)
        processed.append(rgba)
        manifest_frames.append({
            "index": i,
            "path": f"frames/{name}",
            "sha256": sha256_file(dst),
            "size": [rgba.width, rgba.height],
        })
        print(f"[frame {i}] done in {time.time()-t0:.1f}s", flush=True)

    atlas = make_atlas(processed, COLS)
    atlas_path = os.path.join(OUT_DIR, "atlas.png")
    atlas.save(atlas_path)

    atlas_json = {
        "frame_width": CANVAS,
        "frame_height": CANVAS,
        "cols": COLS,
        "count": len(processed),
        "atlas": "atlas.png",
        "frames": [
            {"index": i, "x": (i % COLS) * CANVAS, "y": (i // COLS) * CANVAS, "w": CANVAS, "h": CANVAS}
            for i in range(len(processed))
        ],
    }
    with open(os.path.join(OUT_DIR, "atlas.json"), "w", encoding="utf-8") as f:
        json.dump(atlas_json, f, indent=2)

    gif_path = os.path.join(OUT_DIR, "preview.gif")
    gif_frames = [np.array(im) for im in processed]
    imageio.mimsave(gif_path, gif_frames, duration=1.0 / FPS, loop=0, disposal=2)

    manifest = {
        "format": "HellCorpVrm2SpriteV1",
        "reference": "characters_summer_memories/lucy_pixel_art.png",
        "input_frames_dir": SRC_DIR,
        "output_dir": OUT_DIR,
        "frame_count": len(processed),
        "frame_size": [CANVAS, CANVAS],
        "fps": FPS,
        "lora": {"path": LORA, "weight": LORA_WEIGHT},
        "strength": [STRENGTH_PASS1, STRENGTH_PASS2],
        "atlas": {"path": "atlas.png", "sha256": sha256_file(atlas_path), "cols": COLS},
        "gif": {"path": "preview.gif", "sha256": sha256_file(gif_path)},
        "frames": manifest_frames,
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("LUCY_WALK_FINAL_DONE", flush=True)


if __name__ == "__main__":
    main()
