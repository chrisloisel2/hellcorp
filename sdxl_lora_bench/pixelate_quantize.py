import glob, os
from PIL import Image

FRAMES_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_v2/final"
PALETTE_SOURCE = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_v2/keyframes_styled/frame_000000.png"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_v2/quantized"
os.makedirs(OUT_DIR, exist_ok=True)

CANVAS = 768
PIXEL_GRID = 128  # true pixel-art resolution before upscaling back to canvas size
COLORS = 32

palette_src = Image.open(PALETTE_SOURCE).convert("RGB").resize((PIXEL_GRID, PIXEL_GRID), Image.Resampling.BOX)
palette_img = palette_src.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)

frames = sorted(glob.glob(f"{FRAMES_DIR}/frame_*.png"))
print(f"{len(frames)} frames, shared palette built from {PALETTE_SOURCE}", flush=True)

for path in frames:
    name = os.path.basename(path)
    im = Image.open(path).convert("RGB")
    small = im.resize((PIXEL_GRID, PIXEL_GRID), Image.Resampling.BOX)
    quantized = small.quantize(palette=palette_img, dither=Image.Dither.NONE)
    hard_pixels = quantized.convert("RGB").resize((CANVAS, CANVAS), Image.Resampling.NEAREST)
    hard_pixels.save(os.path.join(OUT_DIR, name))

print("QUANTIZE_DONE", flush=True)
