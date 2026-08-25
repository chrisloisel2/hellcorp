import os
from PIL import Image, ImageDraw, ImageFont

RAW_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_final/raw"
KF_PATH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_final/keyframe_styled/frame_000000.png"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/pixelation_sweep"
os.makedirs(OUT_DIR, exist_ok=True)

CANVAS = 768
TEST_FRAMES = ["frame_000000.png", "frame_000017.png"]

# (label, pixel_grid or None for "no quantization", colors)
CONFIGS = [
    ("A_raw_no_quantize", None, None),
    ("B_grid384_col128", 384, 128),
    ("C_grid256_col64", 256, 64),
    ("D_grid192_col48", 192, 48),
    ("E_grid128_col32_previous", 128, 32),
    ("F_grid96_col24", 96, 24),
]


def quantize(im, pixel_grid, colors, palette_img):
    if pixel_grid is None:
        return im
    small = im.resize((pixel_grid, pixel_grid), Image.Resampling.BOX)
    q = small.quantize(palette=palette_img[pixel_grid], dither=Image.Dither.NONE)
    return q.convert("RGB").resize((CANVAS, CANVAS), Image.Resampling.NEAREST)


# build one shared palette per grid size from the keyframe, reused across configs/frames for consistency
palette_cache = {}
kf_im = Image.open(KF_PATH).convert("RGB")
for _, grid, colors in CONFIGS:
    if grid is None:
        continue
    key = grid
    if key not in palette_cache:
        src = kf_im.resize((grid, grid), Image.Resampling.BOX)
        palette_cache[key] = src.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)

THUMB = 300
LABEL_H = 28
cols = len(CONFIGS)
rows = len(TEST_FRAMES)
sheet = Image.new("RGB", (cols * THUMB, rows * (THUMB + LABEL_H)), (20, 20, 20))
draw = ImageDraw.Draw(sheet)

for r, fname in enumerate(TEST_FRAMES):
    im = Image.open(os.path.join(RAW_DIR, fname)).convert("RGB")
    for c, (label, grid, colors) in enumerate(CONFIGS):
        out = quantize(im, grid, colors, palette_cache)
        thumb = out.resize((THUMB, THUMB), Image.Resampling.NEAREST if grid else Image.Resampling.LANCZOS)
        x, y = c * THUMB, r * (THUMB + LABEL_H)
        sheet.paste(thumb, (x, y + LABEL_H))
        draw.text((x + 6, y + 6), f"{label}", fill=(255, 255, 255))
        # also save individual full-res files for closer inspection
        out.save(os.path.join(OUT_DIR, f"{label}_{fname}"))

sheet.save(os.path.join(OUT_DIR, "comparison_sheet.png"))
print("done ->", os.path.join(OUT_DIR, "comparison_sheet.png"))
