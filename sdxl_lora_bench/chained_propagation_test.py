import os, subprocess, shutil

GUIDES_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_summer_memories_final/guides"
KF_PATH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/walking_bitch_summer_memories_final/keyframe_styled/frame_000000.png"
EBSYNTH = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/ebsynth_src/bin/ebsynth"
OUT_DIR = "/Users/christopher/HellCEO/hellcorp/sdxl_lora_bench/out/chained_test"
os.makedirs(OUT_DIR, exist_ok=True)

N = 13  # test frames 0..12: enough to see drift trend, cheap enough to redo if it fails

shutil.copy(KF_PATH, os.path.join(OUT_DIR, "frame_000000.png"))

for i in range(1, N):
    prev_name = f"frame_{i-1:06d}.png"
    cur_name = f"frame_{i:06d}.png"
    subprocess.run([
        EBSYNTH,
        "-style", os.path.join(OUT_DIR, prev_name),          # chain: previous OUTPUT frame, not the keyframe
        "-guide", os.path.join(GUIDES_DIR, prev_name), os.path.join(GUIDES_DIR, cur_name),
        "-output", os.path.join(OUT_DIR, cur_name),
        "-patchsize", "5", "-pyramidlevels", "6", "-searchvoteiters", "12",
        "-patchmatchiters", "6", "-extrapass3x3",
    ], check=True)
    print(f"[chain] {cur_name} <- {prev_name}", flush=True)

print("CHAIN_TEST_DONE", flush=True)
