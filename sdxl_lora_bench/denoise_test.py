import torch, time, os, json
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
from PIL import Image
import cv2
import numpy as np

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
SRC_IMAGE = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/perfect/fem_vroid/perfect/front/frames/frame_000035.png"
IDENTITY_REF = "/Users/christopher/HellCEO/sdxl_lora_bench/character/lucy_perfect.png"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out"
device = "mps"

with open("/Users/christopher/HellCEO/hellcorp_ai/config/characters.json") as f:
    desc = json.load(f)["lucy"]["description"]

# Native SDXL resolution this time (1024x1024).
src_rgba = Image.open(SRC_IMAGE).convert("RGBA")
bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
bg.paste(src_rgba, mask=src_rgba.split()[3])
src = bg.resize((1024, 1024))
arr = np.array(src)
edges = cv2.Canny(arr, 80, 160)
canny_image = Image.fromarray(np.stack([edges]*3, axis=-1))

controlnet = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
fixed_vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_single_file(
    CHECKPOINT, controlnet=controlnet, vae=fixed_vae, torch_dtype=torch.float16
)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
pipe.vae.disable_tiling()
pipe.vae.disable_slicing()
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.bin")
pipe.set_ip_adapter_scale(0.8)
print("pipeline ready", flush=True)

identity_image = Image.open(IDENTITY_REF).convert("RGB")
# Short prompt this time — the long description was being truncated at 77 tokens anyway,
# dropping the style keywords. Trim to the visual essentials + style, under the token limit.
prompt = "pixel art, 2D game sprite, anime woman, honey-blonde hair bun, glasses, white blouse, black skirt, walking, flat colors, clean lines"
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, low quality, noise, grain, moire, artifacts"

configs = [
    {"name": "cfg4.5_cn0.55", "guidance_scale": 4.5, "controlnet_conditioning_scale": 0.55},
    {"name": "cfg5.5_cn0.6",  "guidance_scale": 5.5, "controlnet_conditioning_scale": 0.6},
]

for cfg in configs:
    g = torch.Generator(device=device).manual_seed(1234)
    t0 = time.time()
    out = pipe(
        prompt=prompt, negative_prompt=negative_prompt, image=canny_image,
        ip_adapter_image=identity_image,
        controlnet_conditioning_scale=cfg["controlnet_conditioning_scale"],
        guidance_scale=cfg["guidance_scale"],
        num_inference_steps=28, generator=g,
        width=1024, height=1024,
    ).images[0]
    out.save(f"{OUT_DIR}/denoise_{cfg['name']}.png")
    print(f"{cfg['name']} done in {time.time()-t0:.1f}s", flush=True)

print("DENOISE_TEST_DONE", flush=True)
