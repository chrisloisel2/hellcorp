import torch, time, os
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel
from diffusers.utils import load_image
from PIL import Image
import cv2
import numpy as np

CHECKPOINT = "/Users/christopher/HellCEO/models/waiIllustriousSDXL_v170.safetensors"
SRC_IMAGE = "/Users/christopher/HellCEO/HellCorp_Motion_Studio/cli_output/lucy/perfect/fem_vroid/perfect/front/frames/frame_000020.png"
OUT_DIR = "/Users/christopher/HellCEO/sdxl_lora_bench/out"
os.makedirs(OUT_DIR, exist_ok=True)
device = "mps"

# Canny edge map from our own already-stable mocap render, as the structural control signal.
src_rgba = Image.open(SRC_IMAGE).convert("RGBA")
bg = Image.new("RGB", src_rgba.size, (43, 35, 32))
bg.paste(src_rgba, mask=src_rgba.split()[3])
src = bg.resize((768, 768))
arr = np.array(src)
edges = cv2.Canny(arr, 80, 160)
edges_rgb = np.stack([edges]*3, axis=-1)
canny_image = Image.fromarray(edges_rgb)
canny_image.save(f"{OUT_DIR}/_canny_control.png")
print("canny map saved", flush=True)

t0 = time.time()
print("downloading/loading SDXL ControlNet (canny)...", flush=True)
controlnet = ControlNetModel.from_pretrained(
    "diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16
)
print(f"controlnet loaded in {time.time()-t0:.1f}s", flush=True)

t0 = time.time()
pipe = StableDiffusionXLControlNetPipeline.from_single_file(
    CHECKPOINT, controlnet=controlnet, torch_dtype=torch.float16
)
pipe.to(device)
pipe.set_progress_bar_config(disable=True)
print(f"pipeline assembled in {time.time()-t0:.1f}s", flush=True)

prompt = "pixel art, 2D game sprite, anime girl, walking pose, clean flat colors, game asset"
negative_prompt = "blurry, photo, 3d render, realistic, watermark, text, low quality, extra limbs"

g = torch.Generator(device=device).manual_seed(1234)
t0 = time.time()
out = pipe(
    prompt=prompt, negative_prompt=negative_prompt, image=canny_image,
    controlnet_conditioning_scale=0.8, guidance_scale=6.0, num_inference_steps=20, generator=g,
).images[0]
print(f"generated in {time.time()-t0:.1f}s", flush=True)
out.save(f"{OUT_DIR}/controlnet_smoke.png")
print("CONTROLNET_SMOKE_OK", flush=True)
