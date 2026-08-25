import os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageOps

RAW_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_mixamo_ebsynth_final/raw"
SRC_DIR = "/Users/christopher/HellCEO/hellcorp/HellCorp_Motion_Studio/mixamo_clean_output/walking_bitch/frames"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/outline_sweep"
os.makedirs(OUT_DIR, exist_ok=True)

CANVAS = 768
TEST_FRAMES = ["frame_000000.png", "frame_000017.png"]
LINE_COLOR = (20, 16, 14)


def alpha_mask(name):
    src = Image.open(os.path.join(SRC_DIR, name)).convert("RGBA")
    return np.array(src.split()[3])


def outline_pass(rgb_im, alpha, thickness, internal_edges, canny_lo=60, canny_hi=160):
    arr = np.array(rgb_im.convert("RGB"))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    gray_blur = cv2.GaussianBlur(gray, (3, 3), 0)

    # outer silhouette contour from the clean 3D alpha mask
    silhouette_edge = cv2.Canny((alpha > 10).astype(np.uint8) * 255, 50, 150)

    line_mask = silhouette_edge
    if internal_edges:
        inner = cv2.Canny(gray_blur, canny_lo, canny_hi)
        inner = cv2.bitwise_and(inner, inner, mask=(alpha > 10).astype(np.uint8) * 255)
        # drop tiny noisy edge fragments (hands/fingers) that would otherwise fill in solid
        n, labels, stats, _ = cv2.connectedComponentsWithStats(inner, connectivity=8)
        clean = np.zeros_like(inner)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= 6:
                clean[labels == i] = 255
        inner = clean
        line_mask = cv2.bitwise_or(line_mask, inner)

    kernel = np.ones((thickness, thickness), np.uint8)
    line_mask = cv2.dilate(line_mask, kernel, iterations=1)

    out = arr.copy()
    out[line_mask > 0] = LINE_COLOR
    return Image.fromarray(out)


CONFIGS = [
    ("I2_outline2_with_internal", 2, True, None, 60, 160),
    ("J2_outline3_with_internal", 3, True, None, 60, 160),
    ("L_outline3_internal_stricter", 3, True, None, 90, 220),
]

THUMB = 320
LABEL_H = 28
cols = len(CONFIGS)
rows = len(TEST_FRAMES)
sheet = Image.new("RGB", (cols * THUMB, rows * (THUMB + LABEL_H)), (20, 20, 20))
draw = ImageDraw.Draw(sheet)

for r, fname in enumerate(TEST_FRAMES):
    im = Image.open(os.path.join(RAW_DIR, fname)).convert("RGB")
    alpha = alpha_mask(fname)
    for c, (label, thickness, internal, posterize_bits, clo, chi) in enumerate(CONFIGS):
        base = im
        if posterize_bits:
            base = ImageOps.posterize(base, posterize_bits)
        out = outline_pass(base, alpha, thickness, internal, canny_lo=clo, canny_hi=chi)
        out.save(os.path.join(OUT_DIR, f"{label}_{fname}"))
        thumb = out.resize((THUMB, THUMB), Image.Resampling.LANCZOS)
        x, y = c * THUMB, r * (THUMB + LABEL_H)
        sheet.paste(thumb, (x, y + LABEL_H))
        draw.text((x + 6, y + 6), label, fill=(255, 255, 255))

sheet.save(os.path.join(OUT_DIR, "outline_comparison_sheet.png"))
print("done ->", os.path.join(OUT_DIR, "outline_comparison_sheet.png"))
