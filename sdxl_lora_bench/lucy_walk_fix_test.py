import torch, time, os, glob
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/lucy_walk_fix_test"
os.makedirs(OUT_DIR, exist_ok=True)

LORA_WEIGHT = 0.8
STRENGTH_PASS1 = 0.5
STRENGTH_PASS2 = 0.25
CANVAS = 1024
BG = (43, 35, 32)
TEST_FRAMES = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]

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

frames = sorted(glob.glob(f"{SRC_DIR}/frame_*.png"))

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="summer_memories")
pipe.set_adapters(["summer_memories"], adapter_weights=[LORA_WEIGHT])
print("pipeline + lora ready", flush=True)

for i in TEST_FRAMES:
    raw_path = frames[i]
    name = f"frame_{i:06d}.png"
    src = Image.open(raw_path).convert("RGBA")
    bg_img = Image.new("RGB", src.size, BG)
    bg_img.paste(src, mask=src.split()[3])
    guide = bg_img.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)

    t0 = time.time()
    g1 = torch.Generator(device=device).manual_seed(1234)
    pass1 = pipe(
        prompt=PROMPT, negative_prompt=NEGATIVE, image=guide.resize((768, 768)),
        strength=STRENGTH_PASS1, guidance_scale=6.0, num_inference_steps=22, generator=g1,
    ).images[0]
    g2 = torch.Generator(device=device).manual_seed(4321)
    pass2 = pipe(
        prompt=PROMPT, negative_prompt=NEGATIVE, image=pass1.resize((CANVAS, CANVAS)),
        strength=STRENGTH_PASS2, guidance_scale=6.0, num_inference_steps=22, generator=g2,
    ).images[0]
    pass2.save(os.path.join(OUT_DIR, name))
    print(f"[frame {i}] done in {time.time()-t0:.1f}s", flush=True)

print("FIX_TEST_DONE", flush=True)
