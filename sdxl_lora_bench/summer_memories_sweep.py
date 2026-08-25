import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image, ImageDraw

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
GUIDE = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_final/guides/frame_000000.png"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/summer_memories_sweep"
os.makedirs(OUT_DIR, exist_ok=True)

LORA_WEIGHTS = [0.6, 0.8, 1.0]
STRENGTHS = [0.5, 0.65, 0.8]

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
print("pipeline + lora ready", flush=True)

prompt = (
    "pixel art, 2D game sprite, full body, walking pose, anime girl, "
    "white halter dress with thin neck tie, one white thigh band on left leg, white sneakers, "
    "short dark blue bob hair, game asset"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit"

init_image = Image.open(GUIDE).resize((768, 768))
results = {}

for lw in LORA_WEIGHTS:
    pipe.set_adapters(["summer_memories"], adapter_weights=[lw])
    for st in STRENGTHS:
        g = torch.Generator(device=device).manual_seed(1234)
        t0 = time.time()
        out = pipe(
            prompt=prompt, negative_prompt=negative_prompt, image=init_image,
            strength=st, guidance_scale=6.0, num_inference_steps=22, generator=g,
        ).images[0]
        name = f"lora{lw}_str{st}.png"
        out.save(os.path.join(OUT_DIR, name))
        results[(lw, st)] = out
        print(f"[{name}] done in {time.time()-t0:.1f}s", flush=True)

# contact sheet
THUMB = 260
LABEL_H = 22
cols = len(STRENGTHS)
rows = len(LORA_WEIGHTS)
sheet = Image.new("RGB", (cols * THUMB, rows * (THUMB + LABEL_H)), (20, 20, 20))
draw = ImageDraw.Draw(sheet)
for r, lw in enumerate(LORA_WEIGHTS):
    for c, st in enumerate(STRENGTHS):
        im = results[(lw, st)].resize((THUMB, THUMB), Image.Resampling.LANCZOS)
        x, y = c * THUMB, r * (THUMB + LABEL_H)
        sheet.paste(im, (x, y + LABEL_H))
        draw.text((x + 6, y + 4), f"lora={lw} str={st}", fill=(255, 255, 255))
sheet.save(os.path.join(OUT_DIR, "comparison_sheet.png"))
print("SWEEP_DONE ->", os.path.join(OUT_DIR, "comparison_sheet.png"), flush=True)
