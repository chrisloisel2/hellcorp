import torch, time, os, glob, subprocess, shutil
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"
GUIDES_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_summer_memories_hires/guides"  # reused, already at 1024px

OUT_ROOT = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out"

LORA_WEIGHT = 0.8
STRENGTH_PASS1 = 0.8
STRENGTH_PASS2 = 0.35
CANVAS = 1024
KEYFRAME_IDX = [0, 9, 17, 26, 34]

NEGATIVE = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit, costume change"

CHARACTERS = {
    "lucy": (
        "pixel art, 2D game sprite, full body, walking pose, anime woman, "
        "platinum blonde hair in high bun with side-swept bangs, thin gold glasses, "
        "white dress shirt unbuttoned at the collar, black pencil skirt, "
        "dark stockings, black heels, black lanyard with ID badge, small pale horns, "
        "office demon, game asset, detailed shading, high quality"
    ),
    "malphas": (
        "pixel art, 2D game sprite, full body, walking pose, anime woman, "
        "long white silver hair, dark red curved horns, pointed elf ears, red eyes, "
        "dark maroon shirt open collar, black high-waist skirt with garter straps, "
        "black thigh-high stockings, black heels, demon, game asset, detailed shading, high quality"
    ),
    "morrigan": (
        "pixel art, 2D game sprite, full body, walking pose, anime woman, "
        "long wavy black hair, black business blazer dress with deep neckline, "
        "black belt with gold chain, garter straps, black thigh-high stockings, black heels, "
        "gold jewelry, ID badge, demon office executive, game asset, detailed shading, high quality"
    ),
}

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))
n = len(frames)
print(f"{n} source frames, keyframes = {KEYFRAME_IDX}, characters = {list(CHARACTERS)}", flush=True)

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
pipe.set_adapters(["summer_memories"], adapter_weights=[LORA_WEIGHT])
print("pipeline + lora ready", flush=True)


def ebsynth_step(style_path, prev_guide_name, cur_guide_name, out_path):
    subprocess.run([
        EBSYNTH,
        "-style", style_path,
        "-guide", os.path.join(GUIDES_DIR, prev_guide_name), os.path.join(GUIDES_DIR, cur_guide_name),
        "-output", out_path,
        "-patchsize", "5", "-pyramidlevels", "6", "-searchvoteiters", "12",
        "-patchmatchiters", "6", "-extrapass3x3",
    ], check=True)


for char_name, prompt in CHARACTERS.items():
    print(f"=== {char_name} ===", flush=True)
    run_name = f"walking_bitch_{char_name}_summer_memories"
    base = f"{OUT_ROOT}/{run_name}"
    keyframe_dir = f"{base}/keyframes_styled"
    final_dir = f"{base}/final"
    os.makedirs(keyframe_dir, exist_ok=True)
    os.makedirs(final_dir, exist_ok=True)

    for i in KEYFRAME_IDX:
        name = os.path.basename(frames[i])
        guide_img = Image.open(os.path.join(GUIDES_DIR, name))
        t0 = time.time()

        g1 = torch.Generator(device=device).manual_seed(1234)
        pass1 = pipe(
            prompt=prompt, negative_prompt=NEGATIVE, image=guide_img.resize((768, 768)),
            strength=STRENGTH_PASS1, guidance_scale=6.0, num_inference_steps=22, generator=g1,
        ).images[0]

        g2 = torch.Generator(device=device).manual_seed(4321)
        pass2 = pipe(
            prompt=prompt, negative_prompt=NEGATIVE, image=pass1.resize((CANVAS, CANVAS)),
            strength=STRENGTH_PASS2, guidance_scale=6.0, num_inference_steps=22, generator=g2,
        ).images[0]

        pass2.save(os.path.join(keyframe_dir, name))
        shutil.copy(os.path.join(keyframe_dir, name), os.path.join(final_dir, name))
        print(f"[{char_name}][keyframe {i}] done in {time.time()-t0:.1f}s", flush=True)

    for a, b in zip(KEYFRAME_IDX[:-1], KEYFRAME_IDX[1:]):
        mid = (a + b) // 2
        prev_name = os.path.basename(frames[a])
        for i in range(a + 1, mid + 1):
            cur_name = os.path.basename(frames[i])
            t0 = time.time()
            ebsynth_step(os.path.join(final_dir, prev_name), prev_name, cur_name, os.path.join(final_dir, cur_name))
            print(f"[{char_name}][fwd] {cur_name} <- {prev_name} in {time.time()-t0:.1f}s", flush=True)
            prev_name = cur_name
        prev_name = os.path.basename(frames[b])
        for i in range(b - 1, mid, -1):
            cur_name = os.path.basename(frames[i])
            t0 = time.time()
            ebsynth_step(os.path.join(final_dir, prev_name), prev_name, cur_name, os.path.join(final_dir, cur_name))
            print(f"[{char_name}][bwd] {cur_name} <- {prev_name} in {time.time()-t0:.1f}s", flush=True)
            prev_name = cur_name

    final_frames = [Image.open(os.path.join(final_dir, os.path.basename(p))) for p in frames]
    gif_path = f"{base}/{run_name}_preview.gif"
    final_frames[0].save(gif_path, save_all=True, append_images=final_frames[1:], duration=1000 // 30, loop=0)
    print(f"[{char_name}] DONE -> {gif_path}", flush=True)

print("ALL_CHARACTERS_DONE", flush=True)
