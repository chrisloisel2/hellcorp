import torch, time, os, glob, subprocess, shutil
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"

RUN_NAME = "walking_bitch_summer_memories_final"
BASE = f"/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/{RUN_NAME}"
GUIDES_DIR = f"{BASE}/guides"
KEYFRAME_DIR = f"{BASE}/keyframe_styled"
FINAL_DIR = f"{BASE}/final"      # single-keyframe + EbSynth propagation, no post-quantize
for d in (GUIDES_DIR, KEYFRAME_DIR, FINAL_DIR):
    os.makedirs(d, exist_ok=True)

LORA_WEIGHT = 0.8       # CivitAI-recommended weight, confirmed best in the sweep
STRENGTH = 0.8          # user-picked from the 3x3 sweep
BG = (43, 35, 32)
KF_INDEX = 0            # single generation event -> zero keyframe-to-keyframe divergence, by construction

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))
n = len(frames)
print(f"{n} source frames, single keyframe = index {KF_INDEX}", flush=True)

# Step 1: guides = raw deterministic 3D composite for every frame (no SDXL, no hallucination)
for path in frames:
    name = os.path.basename(path)
    src_rgba = Image.open(path).convert("RGBA")
    bg_img = Image.new("RGB", src_rgba.size, BG)
    bg_img.paste(src_rgba, mask=src_rgba.split()[3])
    bg_img.save(os.path.join(GUIDES_DIR, name))
print("guides done", flush=True)

# Step 2: stylize the ONE keyframe with SDXL + Summer Memories style LoRA
device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
pipe.set_adapters(["summer_memories"], adapter_weights=[LORA_WEIGHT])
print("pipeline + lora ready", flush=True)

prompt = (
    "pixel art, 2D game sprite, full body, walking pose, anime girl, "
    "white halter dress with thin neck tie, one white thigh band on left leg, white sneakers, "
    "short dark blue bob hair, game asset"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit"

kf_name = os.path.basename(frames[KF_INDEX])
init_image = Image.open(os.path.join(GUIDES_DIR, kf_name)).resize((768, 768))
g = torch.Generator(device=device).manual_seed(1234)
t0 = time.time()
kf_out = pipe(
    prompt=prompt, negative_prompt=negative_prompt, image=init_image,
    strength=STRENGTH, guidance_scale=6.0, num_inference_steps=22, generator=g,
).images[0]
kf_out.save(os.path.join(KEYFRAME_DIR, kf_name))
print(f"[keyframe] {kf_name} done in {time.time()-t0:.1f}s", flush=True)

# Step 3: propagate every other frame from that single keyframe with EbSynth (deterministic, no new hallucination)
shutil.copy(os.path.join(KEYFRAME_DIR, kf_name), os.path.join(FINAL_DIR, kf_name))
for i, path in enumerate(frames):
    name = os.path.basename(path)
    if i == KF_INDEX:
        continue
    t0 = time.time()
    subprocess.run([
        EBSYNTH,
        "-style", os.path.join(KEYFRAME_DIR, kf_name),
        "-guide", os.path.join(GUIDES_DIR, kf_name), os.path.join(GUIDES_DIR, name),
        "-output", os.path.join(FINAL_DIR, name),
        "-patchsize", "5", "-pyramidlevels", "6", "-searchvoteiters", "12",
        "-patchmatchiters", "6", "-extrapass3x3",
    ], check=True)
    print(f"[gen] {name} in {time.time()-t0:.1f}s", flush=True)

print("PROPAGATION_DONE", flush=True)

# Step 4: preview GIF
final_frames = [Image.open(os.path.join(FINAL_DIR, os.path.basename(p))) for p in frames]
gif_path = f"{BASE}/{RUN_NAME}_preview.gif"
final_frames[0].save(gif_path, save_all=True, append_images=final_frames[1:], duration=1000 // 30, loop=0)
print(f"preview gif -> {gif_path}", flush=True)
print("ALL_DONE", flush=True)
