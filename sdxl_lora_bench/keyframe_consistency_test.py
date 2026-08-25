import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/pixel_art_pony_unet_only.safetensors"
GUIDES_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth/guides"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/keyframe_consistency_test"
os.makedirs(OUT_DIR, exist_ok=True)

TEST_FRAMES = ["frame_000000.png", "frame_000010.png", "frame_000015.png"]

device = "mps"
pipe = StableDiffusionXLImg2ImgPipeline.from_single_file(CHECKPOINT, torch_dtype=torch.float16)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_lora_weights(LORA, adapter_name="pixelart")
pipe.set_adapters(["pixelart"], adapter_weights=[0.2])
print("pipeline + lora ready", flush=True)

# locked garment description matching the actual VRM outfit, to stop SDXL from re-inventing it
prompt = (
    "pixel art, 2D game sprite, full body, walking pose, anime girl, "
    "white halter dress with thin neck tie, one white thigh band on left leg, white sneakers, "
    "short dark blue bob hair, clean flat colors, game asset, transparent background"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit, costume change"

for strength in [0.35, 0.45]:
    for name in TEST_FRAMES:
        init_image = Image.open(os.path.join(GUIDES_DIR, name)).resize((768, 768))
        g = torch.Generator(device=device).manual_seed(1234)
        t0 = time.time()
        out = pipe(
            prompt=prompt, negative_prompt=negative_prompt, image=init_image,
            strength=strength, guidance_scale=6.0, num_inference_steps=22, generator=g,
        ).images[0]
        out_name = f"s{strength}_{name}"
        out.save(os.path.join(OUT_DIR, out_name))
        print(f"[{out_name}] done in {time.time()-t0:.1f}s", flush=True)

print("TEST_DONE", flush=True)
