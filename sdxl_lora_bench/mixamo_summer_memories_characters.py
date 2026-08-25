import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
CHAR_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/character"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/characters_summer_memories"
os.makedirs(OUT_DIR, exist_ok=True)

LORA_WEIGHT = 0.8
STRENGTH_PASS1 = 0.5
STRENGTH_PASS2 = 0.3
CANVAS = 1024

NEGATIVE = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit"

CHARACTERS = {
    "lucy": (
        "lucy_perfect.png",
        "pixel art, 2D game character portrait, full body, standing pose, anime woman, "
        "platinum blonde hair in high bun with side-swept bangs, thin gold glasses, "
        "white dress shirt unbuttoned at the collar, black pencil skirt with side slit, "
        "black stockings, black heels, black lanyard with ID badge, small pale horns, "
        "office demon, game asset, detailed shading, high quality"
    ),
    "malphas": (
        "malphas_perfect.png",
        "pixel art, 2D game character portrait, full body, standing pose, anime woman, "
        "long white silver hair, dark red curved horns, pointed elf ears, red eyes, "
        "dark maroon shirt open collar, black high-waist skirt with garter straps, "
        "black thigh-high stockings, black heels, demon, game asset, detailed shading, high quality"
    ),
    "morrigan": (
        "morrigan_perfect.png",
        "pixel art, 2D game character portrait, full body, standing pose, anime woman, "
        "long wavy black hair, black business blazer dress with deep neckline, "
        "black belt with gold chain, garter straps, black thigh-high stockings, black heels, "
        "gold jewelry, ID badge, demon office executive, game asset, detailed shading, high quality"
    ),
}

def aspect_size(w, h, target_long_side):
    scale = target_long_side / max(w, h)
    nw, nh = round(w * scale / 8) * 8, round(h * scale / 8) * 8
    return max(nw, 8), max(nh, 8)


device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
pipe.set_adapters(["summer_memories"], adapter_weights=[LORA_WEIGHT])
print("pipeline + lora ready", flush=True)

for key, (filename, prompt) in CHARACTERS.items():
    src = Image.open(os.path.join(CHAR_DIR, filename)).convert("RGB")
    w, h = src.size
    size1 = aspect_size(w, h, 1024)     # keep the real aspect ratio, do not squash to square
    size2 = aspect_size(w, h, 1536)     # hires-fix refine pass, upscaled
    t0 = time.time()

    g1 = torch.Generator(device=device).manual_seed(1234)
    pass1 = pipe(
        prompt=prompt, negative_prompt=NEGATIVE, image=src.resize(size1),
        strength=STRENGTH_PASS1, guidance_scale=6.0, num_inference_steps=22, generator=g1,
    ).images[0]

    g2 = torch.Generator(device=device).manual_seed(4321)
    pass2 = pipe(
        prompt=prompt, negative_prompt=NEGATIVE, image=pass1.resize(size2),
        strength=STRENGTH_PASS2, guidance_scale=6.0, num_inference_steps=22, generator=g2,
    ).images[0]

    pass2.save(os.path.join(OUT_DIR, f"{key}_pixel_art.png"))
    print(f"[{key}] done in {time.time()-t0:.1f}s", flush=True)

print("ALL_DONE", flush=True)
