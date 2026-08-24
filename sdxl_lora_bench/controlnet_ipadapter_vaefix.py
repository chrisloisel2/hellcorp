import torch, time, os
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
from PIL import Image
import cv2
import numpy as np

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
SRC_IMAGE = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/perfect/fem_vroid/perfect/front/frames/frame_000035.png"
IDENTITY_REF = "/Users/christopher/HellCEO/sdxl_lora_bench/character/lucy_perfect.png"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out"
device = "mps"

src_rgba = Image.open(SRC_IMAGE).convert("RGBA")
bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
bg.paste(src_rgba, mask=src_rgba.split()[3])
src = bg.resize((768, 768))
arr = np.array(src)
edges = cv2.Canny(arr, 80, 160)
canny_image = Image.fromarray(np.stack([edges]*3, axis=-1))

t0 = time.time()
controlnet = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
# Known SDXL+fp16 fix: the stock SDXL VAE overflows in float16 and produces exactly this kind
# of banding/color-fringe corruption. This community VAE was built specifically to be fp16-safe.
fixed_vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_single_file(
    CHECKPOINT, controlnet=controlnet, vae=fixed_vae, torch_dtype=torch.float16
)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
print(f"pipeline ready in {time.time()-t0:.1f}s", flush=True)

t0 = time.time()
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.bin")
pipe.set_ip_adapter_scale(0.6)
print(f"ip-adapter loaded in {time.time()-t0:.1f}s", flush=True)

identity_image = Image.open(IDENTITY_REF).convert("RGB")
prompt = "pixel art, 2D game sprite, anime woman, walking pose, clean flat colors, game asset"
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, low quality, extra limbs, gray background, noise, artifacts"

g = torch.Generator(device=device).manual_seed(1234)
t0 = time.time()
out = pipe(
    prompt=prompt, negative_prompt=negative_prompt, image=canny_image,
    ip_adapter_image=identity_image,
    controlnet_conditioning_scale=0.8, guidance_scale=6.0, num_inference_steps=20, generator=g,
).images[0]
print(f"generated in {time.time()-t0:.1f}s", flush=True)
out.save(f"{OUT_DIR}/vaefix_lucy_test.png")
print("VAEFIX_TEST_OK", flush=True)
