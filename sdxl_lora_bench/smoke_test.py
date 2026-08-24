import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/sdxl_lora_bench/pixel_art_pony_unet_only.safetensors"
SRC_IMAGE = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/style_tests/0_baseline_raw/frames/frame_000012.png"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out"

device = "mps"
t0 = time.time()
print("loading pipeline from local checkpoint...", flush=True)
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
print(f"pipeline loaded in {time.time()-t0:.1f}s", flush=True)

t0 = time.time()
pipe.load_lora_weights(LORA, adapter_name="pixelart")
print(f"lora loaded in {time.time()-t0:.1f}s", flush=True)

src_rgba = Image.open(SRC_IMAGE).convert("RGBA")
bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
bg.paste(src_rgba, mask=src_rgba.split()[3])
init_image = bg.resize((768, 768))
init_image.save(f"{OUT_DIR}/_src_composited.png")

prompt = "pixel art, 2D game sprite, full body, walking pose, anime girl, clean flat colors, game asset, transparent background"
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs"

pipe.set_adapters(["pixelart"], adapter_weights=[0.7])
g = torch.Generator(device=device).manual_seed(1234)
t0 = time.time()
out = pipe(
    prompt=prompt, negative_prompt=negative_prompt, image=init_image,
    strength=0.55, guidance_scale=6.0, num_inference_steps=20, generator=g,
).images[0]
print(f"ONE image generated in {time.time()-t0:.1f}s", flush=True)
out.save(f"{OUT_DIR}/smoke_lora0.7.png")
print("SMOKE_TEST_OK", flush=True)
