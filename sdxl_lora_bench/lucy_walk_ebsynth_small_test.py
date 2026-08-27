import torch, time, os, glob, subprocess
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/lucy_walk_ebsynth_small_test"
GUIDES_DIR = os.path.join(OUT_DIR, "guides")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(GUIDES_DIR, exist_ok=True)

LORA_WEIGHT = 0.8
STRENGTH_PASS1 = 0.6
STRENGTH_PASS2 = 0.3
CANVAS = 1024
BG = (43, 35, 32)
KEYFRAME_IDX = [0, 2, 4, 6, 8, 10]

PROMPT = (
    "pixel art, 2D game sprite, full body, walking pose, anime woman, "
    "platinum blonde hair in high bun with side-swept bangs, thin gold glasses, "
    "white dress shirt with long sleeves reaching the wrist, unbuttoned at the collar, plain collar with no necklace, "
    "black pencil skirt, dark stockings, white sneakers, "
    "small pale horns, office demon, game asset, detailed shading, high quality"
)
NEGATIVE = (
    "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, "
    "extra limbs, different outfit, costume change, "
    "brooch, pin, badge, lanyard, id card, extra accessory, choker, necklace, jewelry, name tag clip, "
    "wristwatch, colorful pattern, patterned fabric, "
    "black heels, high heels, sandals, boots, mismatched shoes, deformed feet, deformed shoes"
)

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))[:KEYFRAME_IDX[-1] + 1]
print(f"{len(frames)} frames, keyframes = {KEYFRAME_IDX}", flush=True)

for path in frames:
    name = os.path.basename(path)
    guide_path = os.path.join(GUIDES_DIR, name)
    if not os.path.exists(guide_path):
        src_rgba = Image.open(path).convert("RGBA")
        bg_img = Image.new("RGB", src_rgba.size, BG)
        bg_img.paste(src_rgba, mask=src_rgba.split()[3])
        bg_img.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS).save(guide_path)
print("guides ready", flush=True)

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
pipe.set_adapters(["summer_memories"], adapter_weights=[LORA_WEIGHT])
print("pipeline + lora ready", flush=True)

for i in KEYFRAME_IDX:
    name = os.path.basename(frames[i])
    guide_img = Image.open(os.path.join(GUIDES_DIR, name))
    t0 = time.time()
    g1 = torch.Generator(device=device).manual_seed(1234)
    pass1 = pipe(
        prompt=PROMPT, negative_prompt=NEGATIVE, image=guide_img.resize((768, 768)),
        strength=STRENGTH_PASS1, guidance_scale=6.0, num_inference_steps=22, generator=g1,
    ).images[0]
    g2 = torch.Generator(device=device).manual_seed(4321)
    pass2 = pipe(
        prompt=PROMPT, negative_prompt=NEGATIVE, image=pass1.resize((CANVAS, CANVAS)),
        strength=STRENGTH_PASS2, guidance_scale=6.0, num_inference_steps=22, generator=g2,
    ).images[0]
    pass2.save(os.path.join(OUT_DIR, name))
    print(f"[keyframe {i}] done in {time.time()-t0:.1f}s", flush=True)

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


for a, b in zip(KEYFRAME_IDX[:-1], KEYFRAME_IDX[1:]):
    mid = (a + b) // 2
    prev_name = os.path.basename(frames[a])
    for i in range(a + 1, mid + 1):
        cur_name = os.path.basename(frames[i])
        t0 = time.time()
        ebsynth_step(os.path.join(OUT_DIR, prev_name), prev_name, cur_name, os.path.join(OUT_DIR, cur_name))
        print(f"[fwd] {cur_name} <- {prev_name} in {time.time()-t0:.1f}s", flush=True)
        prev_name = cur_name
    prev_name = os.path.basename(frames[b])
    for i in range(b - 1, mid, -1):
        cur_name = os.path.basename(frames[i])
        t0 = time.time()
        ebsynth_step(os.path.join(OUT_DIR, prev_name), prev_name, cur_name, os.path.join(OUT_DIR, cur_name))
        print(f"[bwd] {cur_name} <- {prev_name} in {time.time()-t0:.1f}s", flush=True)
        prev_name = cur_name

print("SMALL_EBSYNTH_TEST_DONE", flush=True)
