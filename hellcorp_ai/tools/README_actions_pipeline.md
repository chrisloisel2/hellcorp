# Character action pipeline (Wan2.2 I2V)

Turns ONE stylized reference image of a character into a set of game-ready
action clips (idle, walk, wave_hello, talk_phone, laugh — see
`../config/actions.json`). Each action is generated independently by the video
model; the model's own temporal attention keeps identity/outfit consistent
across the whole clip, which is why prompts only describe the motion, not the
character.

Output per action, under `<output-dir>/<action-name>/`:
- `raw.mp4` — the generated clip
- `frames/frame_000000.png ...` — extracted PNG frames
- `atlas.png` + `atlas.json` — sprite atlas
- `manifest.json` — provenance + per-frame hashes
- `preview.gif` — quick-look animation

## macOS (Apple Silicon) — validated on this machine

Uses `mlx-video`'s native MLX port of Wan2.2-TI2V-5B — no CUDA needed, this is
what produced the walk/wave/idle tests already shown.

**One-time setup** (already done on this machine, kept here for a fresh clone):
```bash
cd hellcorp_ai/runtime/mlx-video
uv add torch   # only needed to read the original .pth weights during conversion
export HF_HOME="$(pwd)/../../cache/huggingface"
huggingface-cli download Wan-AI/Wan2.2-TI2V-5B --local-dir ./Wan2.2-TI2V-5B
uv run python3 -m mlx_video.models.wan_2.convert \
  --checkpoint-dir ./Wan2.2-TI2V-5B --output-dir ./Wan2.2-TI2V-5B-MLX \
  --dtype float16 --quantize --bits 4 --group-size 64
rm -rf ./Wan2.2-TI2V-5B   # frees ~13GB; only the MLX output is needed after this
```

**Run the pipeline:**
```bash
python3 hellcorp_ai/tools/generate_character_actions.py \
  --image path/to/your_character_keyframe.png \
  --output-dir hellcorp_ai/outputs/<character>_actions \
  --backend mlx
```
Add `--actions walk,wave_hello` to run a subset instead of all 5 actions.

## Linux / CUDA — NOT tested on this machine, please verify

MLX is Apple-Silicon-only, so Linux goes through `diffusers`' own
`WanImageToVideoPipeline` instead of the MLX port. This path has **not been run
end-to-end here** (no CUDA machine available) — there is also an open,
unresolved diffusers issue specifically about image-to-video on the 5B TI2V
model (huggingface/diffusers#13258). Test on a couple of actions before
trusting a full batch.

**One-time setup:**
```bash
pip install git+https://github.com/huggingface/diffusers   # Wan2.2 support isn't in the PyPI release yet
pip install torch --index-url https://download.pytorch.org/whl/cu121   # match your CUDA version
pip install accelerate pillow imageio imageio-ffmpeg
# apt install ffmpeg   (or your distro's package manager)
```
No manual model download/conversion needed — `WanImageToVideoPipeline.from_pretrained`
pulls `Wan-AI/Wan2.2-TI2V-5B-Diffusers` from the Hub on first run and caches it
(~20GB).

**Run the pipeline:**
```bash
python3 hellcorp_ai/tools/generate_character_actions.py \
  --image path/to/your_character_keyframe.png \
  --output-dir hellcorp_ai/outputs/<character>_actions \
  --backend diffusers
```
If you hit the `WanPipeline`/image-input bug above, or run out of VRAM, that's
the point where `run_diffusers_action()` in `generate_character_actions.py`
needs a fix or a fallback (e.g. quantized weights, `enable_sequential_cpu_offload`) —
it's isolated to that one function, the rest of the pipeline (actions.json,
frame extraction, atlas/manifest packaging) is backend-agnostic and doesn't
need to change.

## Editing the action set

Edit `hellcorp_ai/config/actions.json` — each entry is
`{"name", "prompt", "num_frames"}`. `num_frames` must be `4n+1` (Wan's
temporal compression). `shared_negative_prompt` applies to every action.
