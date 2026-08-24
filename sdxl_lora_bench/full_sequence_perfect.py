import torch, time, os, glob
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/sdxl_lora_bench/pixel_art_pony_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/perfect/fem_vroid/perfect/front/frames"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out/full_walk_perfect_0.2"
os.makedirs(OUT_DIR, exist_ok=True)
STRENGTH = 0.2

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="pixelart")
pipe.set_adapters(["pixelart"], adapter_weights=[STRENGTH])
print("pipeline + lora ready", flush=True)

prompt = "pixel art, 2D game sprite, full body, walking pose, anime girl, clean flat colors, game asset, transparent background"
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs"

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))
print(f"{len(frames)} source frames", flush=True)

for i, path in enumerate(frames):
    name = os.path.basename(path)
    src_rgba = Image.open(path).convert("RGBA")
    bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
    bg.paste(src_rgba, mask=src_rgba.split()[3])
    init_image = bg.resize((768, 768))

    g = torch.Generator(device=device).manual_seed(1234)
    t0 = time.time()
    out = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=init_image,
        strength=0.55, guidance_scale=6.0, num_inference_steps=22, generator=g,
    ).images[0]
    out.save(os.path.join(OUT_DIR, name))
    print(f"[{i+1}/{len(frames)}] {name} done in {time.time()-t0:.1f}s", flush=True)

print("FULL_SEQUENCE_DONE", flush=True)
