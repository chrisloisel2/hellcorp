import torch, time, os
from diffusers import StableDiffusionXLImg2ImgPipeline
from PIL import Image

CHECKPOINT = "/Users/christopher/HellCEO/hellcorp/models/waiIllustriousSDXL_v170.safetensors"
LORA = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"
GUIDES_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_summer_memories_final/guides"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/summer_memories_kf_consistency"
os.makedirs(OUT_DIR, exist_ok=True)

TEST_FRAMES = ["frame_000012.png", "frame_000024.png"]

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
    "short dark blue bob hair, game asset"
)
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, signature, low quality, extra limbs, different outfit"

for name in TEST_FRAMES:
    init_image = Image.open(os.path.join(GUIDES_DIR, name)).resize((768, 768))
    g = torch.Generator(device=device).manual_seed(1234)
    t0 = time.time()
    out = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=init_image,
        strength=0.8, guidance_scale=6.0, num_inference_steps=22, generator=g,
    ).images[0]
    out.save(os.path.join(OUT_DIR, name))
    print(f"[{name}] done in {time.time()-t0:.1f}s", flush=True)

print("DONE", flush=True)
