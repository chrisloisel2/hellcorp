import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/sdxl_lora_bench/pixel_art_pony_unet_only.safetensors"
SRC_IMAGE = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/style_tests/0_baseline_raw/frames/frame_000012.png"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out"
os.makedirs(OUT_DIR, exist_ok=True)

device = "mps"
t0 = time.time()
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
print(f"pipeline loaded in {time.time()-t0:.1f}s", flush=True)

pipe.load_lora_weights(LORA, adapter_name="pixelart")
print("lora loaded", flush=True)

src_rgba = Image.open(SRC_IMAGE).convert("RGBA")
bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
bg.paste(src_rgba, mask=src_rgba.split()[3])
init_image = bg.resize((768, 768))

prompt = "pixel art, 2D game sprite, full body, walking pose, anime girl, clean flat colors, game asset, transparent background"
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs"

strengths = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

for s in strengths:
    pipe.set_adapters(["pixelart"], adapter_weights=[s])
    g = torch.Generator(device=device).manual_seed(1234)
    t0 = time.time()
    out = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=init_image,
        strength=0.55, guidance_scale=6.0, num_inference_steps=25, generator=g,
    ).images[0]
    out.save(f"{OUT_DIR}/lora_strength_{s:.1f}.png")
    print(f"strength {s:.1f} done in {time.time()-t0:.1f}s", flush=True)

print("SWEEP_DONE", flush=True)
