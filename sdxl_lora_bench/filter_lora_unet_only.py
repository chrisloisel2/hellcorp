import sys
from safetensors import safe_open
from safetensors.torch import save_file

SRC = "/Users/christopher/HellCEO/hellcorp/models/ill_summer_memories_styleV3_r1.safetensors"
DST = "/Users/christopher/HellCEO/hellcorp/models/summer_memories_style_unet_only.safetensors"

tensors = {}
with safe_open(SRC, framework="pt") as f:
    for k in f.keys():
        if k.startswith("lora_unet_"):
            tensors[k] = f.get_tensor(k)

print(f"kept {len(tensors)} unet keys", flush=True)
save_file(tensors, DST)
print("saved ->", DST, flush=True)
