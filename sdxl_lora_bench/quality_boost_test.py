import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image, ImageDraw

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
GUIDE = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_summer_memories_chained/guides/frame_000000.png"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/quality_boost_test"
os.makedirs(OUT_DIR, exist_ok=True)

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
pipe.set_adapters(["summer_memories"], adapter_weights=[0.8])
print("pipeline + lora ready", flush=True)

prompt = (
    "pixel art, 2D game sprite, full body, walking pose, anime girl, "
    "white halter dress with thin neck tie, one white thigh band on left leg, white sneakers, "
    "short dark blue bob hair, game asset, detailed shading, high quality"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit"

raw_guide = Image.open(GUIDE)


def gen(init_image, strength, steps, seed=1234):
    g = torch.Generator(device=device).manual_seed(seed)
    return pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=init_image,
        strength=strength, guidance_scale=6.0, num_inference_steps=steps, generator=g,
    ).images[0]


results = {}

t0 = time.time()
results["A_baseline_768_22_0.8"] = gen(raw_guide.resize((768, 768)), 0.8, 22)
print("A done", time.time() - t0, flush=True)

t0 = time.time()
results["B_res1024_steps35"] = gen(raw_guide.resize((1024, 1024)), 0.8, 35)
print("B done", time.time() - t0, flush=True)

t0 = time.time()
results["C_str0.9"] = gen(raw_guide.resize((768, 768)), 0.9, 22)
print("C done", time.time() - t0, flush=True)

t0 = time.time()
first_pass = gen(raw_guide.resize((768, 768)), 0.8, 22)
results["D_hires_2pass"] = gen(first_pass.resize((1024, 1024)), 0.35, 22, seed=4321)
print("D done", time.time() - t0, flush=True)

for name, im in results.items():
    im.save(os.path.join(OUT_DIR, f"{name}.png"))

THUMB = 340
LABEL_H = 24
sheet = Image.new("RGB", (2 * THUMB, 2 * (THUMB + LABEL_H)), (20, 20, 20))
draw = ImageDraw.Draw(sheet)
for idx, (name, im) in enumerate(results.items()):
    r, c = idx // 2, idx % 2
    thumb = im.resize((THUMB, THUMB), Image.Resampling.LANCZOS)
    x, y = c * THUMB, r * (THUMB + LABEL_H)
    sheet.paste(thumb, (x, y + LABEL_H))
    draw.text((x + 6, y + 4), name, fill=(255, 255, 255))
sheet.save(os.path.join(OUT_DIR, "comparison_sheet.png"))
print("DONE ->", os.path.join(OUT_DIR, "comparison_sheet.png"), flush=True)
