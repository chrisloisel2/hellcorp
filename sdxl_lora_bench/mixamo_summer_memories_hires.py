import torch, time, os, glob, subprocess, shutil
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"

RUN_NAME = "walking_bitch_summer_memories_hires"
BASE = f"/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/{RUN_NAME}"
GUIDES_DIR = f"{BASE}/guides"
KEYFRAME_DIR = f"{BASE}/keyframes_styled"
FINAL_DIR = f"{BASE}/final"
for d in (GUIDES_DIR, KEYFRAME_DIR, FINAL_DIR):
    os.makedirs(d, exist_ok=True)

LORA_WEIGHT = 0.8
STRENGTH_PASS1 = 0.8
STRENGTH_PASS2 = 0.35   # hires-fix refine pass: adds detail without re-deciding the design
CANVAS = 1024
BG = (43, 35, 32)
KEYFRAME_IDX = [0, 9, 17, 26, 34]   # short chain radius (<=5) between neighbours -> bounds drift while fixing boiling

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))
n = len(frames)
print(f"{n} source frames, keyframes = {KEYFRAME_IDX}", flush=True)

# Step 1: guides = raw deterministic 3D composite for every frame, upscaled to the hires canvas
for path in frames:
    name = os.path.basename(path)
    src_rgba = Image.open(path).convert("RGBA")
    bg_img = Image.new("RGB", src_rgba.size, BG)
    bg_img.paste(src_rgba, mask=src_rgba.split()[3])
    bg_img = bg_img.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)
    bg_img.save(os.path.join(GUIDES_DIR, name))
print("guides done", flush=True)

# Step 2: stylize each keyframe independently, hires-fix 2-pass (verified best quality/detail)
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
    "short dark blue bob hair, game asset, detailed shading, high quality"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit"

for i in KEYFRAME_IDX:
    name = os.path.basename(frames[i])
    guide_img = Image.open(os.path.join(GUIDES_DIR, name))
    t0 = time.time()

    g1 = torch.Generator(device=device).manual_seed(1234)
    pass1 = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=guide_img.resize((768, 768)),
        strength=STRENGTH_PASS1, guidance_scale=6.0, num_inference_steps=22, generator=g1,
    ).images[0]

    g2 = torch.Generator(device=device).manual_seed(4321)
    pass2 = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=pass1.resize((CANVAS, CANVAS)),
        strength=STRENGTH_PASS2, guidance_scale=6.0, num_inference_steps=22, generator=g2,
    ).images[0]

    pass2.save(os.path.join(KEYFRAME_DIR, name))
    shutil.copy(os.path.join(KEYFRAME_DIR, name), os.path.join(FINAL_DIR, name))
    print(f"[keyframe {i}] {name} done in {time.time()-t0:.1f}s", flush=True)

print("keyframes styled", flush=True)


def ebsynth_step(style_path, prev_guide_name, cur_guide_name, out_path):
    subprocess.run([
        EBSYNTH,
        "-style", style_path,
        "-guide", os.path.join(GUIDES_DIR, prev_guide_name), os.path.join(GUIDES_DIR, cur_guide_name),
        "-output", out_path,
        "-patchsize", "5", "-pyramidlevels", "6", "-searchvoteiters", "12",
        "-patchmatchiters", "6", "-extrapass3x3",
    ], check=True)


# Step 3: chain outward from each keyframe to the midpoint with its neighbour, in both directions.
for a, b in zip(KEYFRAME_IDX[:-1], KEYFRAME_IDX[1:]):
    mid = (a + b) // 2
    prev_name = os.path.basename(frames[a])
    for i in range(a + 1, mid + 1):
        cur_name = os.path.basename(frames[i])
        t0 = time.time()
        ebsynth_step(os.path.join(FINAL_DIR, prev_name), prev_name, cur_name, os.path.join(FINAL_DIR, cur_name))
        print(f"[fwd] {cur_name} <- {prev_name} in {time.time()-t0:.1f}s", flush=True)
        prev_name = cur_name
    prev_name = os.path.basename(frames[b])
    for i in range(b - 1, mid, -1):
        cur_name = os.path.basename(frames[i])
        t0 = time.time()
        ebsynth_step(os.path.join(FINAL_DIR, prev_name), prev_name, cur_name, os.path.join(FINAL_DIR, cur_name))
        print(f"[bwd] {cur_name} <- {prev_name} in {time.time()-t0:.1f}s", flush=True)
        prev_name = cur_name

print("PROPAGATION_DONE", flush=True)

final_frames = [Image.open(os.path.join(FINAL_DIR, os.path.basename(p))) for p in frames]
gif_path = f"{BASE}/{RUN_NAME}_preview.gif"
final_frames[0].save(gif_path, save_all=True, append_images=final_frames[1:], duration=1000 // 30, loop=0)
print(f"preview gif -> {gif_path}", flush=True)
print("ALL_DONE", flush=True)
