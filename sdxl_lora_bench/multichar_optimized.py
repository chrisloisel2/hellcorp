import torch, time, os, json
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
from PIL import Image
import cv2
import numpy as np

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
SRC_IMAGE = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/perfect/fem_vroid/perfect/front/frames/frame_000035.png"
CHAR_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/character"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out"
device = "mps"

with open("/Users/christopher/HellCEO/hellcorp_ai/config/characters.json") as f:
    CHAR_DESC = json.load(f)

CHARACTERS = {
    "lucy": f"{CHAR_DIR}/lucy_perfect.png",
    "morrigan": f"{CHAR_DIR}/morrigan_perfect.png",
    "malphas": f"{CHAR_DIR}/malphas_perfect.png",
}

# Same pose for every character, as requested.
src_rgba = Image.open(SRC_IMAGE).convert("RGBA")
bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
bg.paste(src_rgba, mask=src_rgba.split()[3])
src = bg.resize((768, 768))
arr = np.array(src)
edges = cv2.Canny(arr, 80, 160)
canny_image = Image.fromarray(np.stack([edges]*3, axis=-1))

t0 = time.time()
controlnet = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
fixed_vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_single_file(
    CHECKPOINT, controlnet=controlnet, vae=fixed_vae, torch_dtype=torch.float16
)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.bin")
print(f"pipeline ready in {time.time()-t0:.1f}s", flush=True)

negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, low quality, extra limbs, gray background, noise, artifacts, plain background"

for name, ref_path in CHARACTERS.items():
    desc = CHAR_DESC[name]["description"]
    prompt = f"pixel art, 2D game sprite, {desc}, walking pose, clean flat colors, game asset, transparent background"
    identity_image = Image.open(ref_path).convert("RGB")

    for scale in [0.8, 1.0]:
        pipe.set_ip_adapter_scale(scale)
        g = torch.Generator(device=device).manual_seed(1234)
        t0 = time.time()
        out = pipe(
            prompt=prompt, negative_prompt=negative_prompt, image=canny_image,
            ip_adapter_image=identity_image,
            controlnet_conditioning_scale=0.8, guidance_scale=7.0, num_inference_steps=25, generator=g,
        ).images[0]
        out.save(f"{OUT_DIR}/multichar_{name}_scale{scale}.png")
        print(f"{name} scale {scale} done in {time.time()-t0:.1f}s", flush=True)

print("MULTICHAR_DONE", flush=True)
