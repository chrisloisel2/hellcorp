import torch, time, os, subprocess
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/pixel_art_pony_unet_only.safetensors"
GUIDES_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_v2/guides"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/single_keyframe_test"
os.makedirs(OUT_DIR, exist_ok=True)

STRENGTH = 0.45
KF_NAME = "frame_000000.png"
TEST_TARGETS = ["frame_000005.png", "frame_000010.png", "frame_000017.png", "frame_000025.png", "frame_000030.png"]

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="pixelart")
pipe.set_adapters(["pixelart"], adapter_weights=[0.2])
print("pipeline + lora ready", flush=True)

prompt = (
    "pixel art, 2D game sprite, full body, walking pose, anime girl, "
    "white halter dress with thin neck tie, one white thigh band on left leg, white sneakers, "
    "short dark blue bob hair, clean flat colors, game asset, transparent background"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit, costume change"

init_image = Image.open(os.path.join(GUIDES_DIR, KF_NAME)).resize((768, 768))
g = torch.Generator(device=device).manual_seed(1234)
t0 = time.time()
kf_out = pipe(
    prompt=prompt, negative_prompt=negative_prompt, image=init_image,
    strength=STRENGTH, guidance_scale=6.0, num_inference_steps=22, generator=g,
).images[0]
kf_out.save(os.path.join(OUT_DIR, KF_NAME))
print(f"[keyframe] {KF_NAME} done in {time.time()-t0:.1f}s", flush=True)

for name in TEST_TARGETS:
    t0 = time.time()
    subprocess.run([
        EBSYNTH,
        "-style", os.path.join(OUT_DIR, KF_NAME),
        "-guide", os.path.join(GUIDES_DIR, KF_NAME), os.path.join(GUIDES_DIR, name),
        "-output", os.path.join(OUT_DIR, name),
        "-patchsize", "5", "-pyramidlevels", "6", "-searchvoteiters", "12",
        "-patchmatchiters", "6", "-extrapass3x3",
    ], check=True)
    print(f"[gen] {name} in {time.time()-t0:.1f}s", flush=True)

print("TEST_DONE", flush=True)
