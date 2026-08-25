import torch, time, os, glob, subprocess, shutil
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/pixel_art_pony_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"

RUN_NAME = "walking_bitch_mixamo_ebsynth_v2"
BASE = f"/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/{RUN_NAME}"
GUIDES_DIR = f"{BASE}/guides"
KEYFRAMES_DIR = f"{BASE}/keyframes_styled"
FINAL_DIR = f"{BASE}/final"
for d in (GUIDES_DIR, KEYFRAMES_DIR, FINAL_DIR):
    os.makedirs(d, exist_ok=True)

STRENGTH = 0.2  # LoRA weight, validated in recap.md
BG = (43, 35, 32)
KEYFRAME_COUNT = 8

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))
n = len(frames)
print(f"{n} source frames", flush=True)

keyframe_idx = sorted(set(round(i * (n - 1) / (KEYFRAME_COUNT - 1)) for i in range(KEYFRAME_COUNT)))
print(f"keyframes: {keyframe_idx}", flush=True)

# Step 1: guides = raw deterministic 3D composite for every frame (no SDXL, no hallucination)
for path in frames:
    name = os.path.basename(path)
    src_rgba = Image.open(path).convert("RGBA")
    bg_img = Image.new("RGB", src_rgba.size, BG)
    bg_img.paste(src_rgba, mask=src_rgba.split()[3])
    bg_img.save(os.path.join(GUIDES_DIR, name))
print("guides done", flush=True)

# Step 2: stylize only the keyframes with SDXL + LoRA
device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="pixelart")
pipe.set_adapters(["pixelart"], adapter_weights=[STRENGTH])
print("pipeline + lora ready", flush=True)

prompt = (
    "pixel art, 2D game sprite, full body, walking pose, anime girl, "
    "white halter dress with thin neck tie, one white thigh band on left leg, white sneakers, "
    "short dark blue bob hair, clean flat colors, game asset, transparent background"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit, costume change"

for i in keyframe_idx:
    name = os.path.basename(frames[i])
    init_image = Image.open(os.path.join(GUIDES_DIR, name)).resize((768, 768))
    g = torch.Generator(device=device).manual_seed(1234)
    t0 = time.time()
    out = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=init_image,
        strength=0.35, guidance_scale=6.0, num_inference_steps=22, generator=g,
    ).images[0]
    out.save(os.path.join(KEYFRAMES_DIR, name))
    print(f"[keyframe {i}] {name} done in {time.time()-t0:.1f}s", flush=True)

print("keyframes styled", flush=True)

# Step 3: propagate remaining frames with EbSynth, guided by the raw 3D render (deterministic)
def nearest_keyframe(i):
    return min(keyframe_idx, key=lambda k: abs(k - i))

for i, path in enumerate(frames):
    name = os.path.basename(path)
    if i in keyframe_idx:
        shutil.copy(os.path.join(KEYFRAMES_DIR, name), os.path.join(FINAL_DIR, name))
        print(f"[kf] {name} copied", flush=True)
        continue
    kf = nearest_keyframe(i)
    kf_name = os.path.basename(frames[kf])
    t0 = time.time()
    subprocess.run([
        EBSYNTH,
        "-style", os.path.join(KEYFRAMES_DIR, kf_name),
        "-guide", os.path.join(GUIDES_DIR, kf_name), os.path.join(GUIDES_DIR, name),
        "-output", os.path.join(FINAL_DIR, name),
        "-patchsize", "5", "-pyramidlevels", "6", "-searchvoteiters", "12",
        "-patchmatchiters", "6", "-extrapass3x3",
    ], check=True)
    print(f"[gen] {name} from keyframe {kf_name} in {time.time()-t0:.1f}s", flush=True)

print("ALL_DONE", flush=True)

# Step 4: quick GIF for review
final_frames = [Image.open(os.path.join(FINAL_DIR, os.path.basename(p))) for p in frames]
gif_path = f"{BASE}/{RUN_NAME}_preview.gif"
final_frames[0].save(gif_path, save_all=True, append_images=final_frames[1:], duration=1000 // 30, loop=0)
print(f"preview gif -> {gif_path}", flush=True)
