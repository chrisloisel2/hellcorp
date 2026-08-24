#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# HellCorp M3 Pipeline
# Local Apple Silicon pipeline for:
#   1) canonical character images with MFLUX + FLUX.2 Klein 4B
#   2) face/dialogue animation with FasterLivePortrait-MLX
#   3) short image-to-video clips with MLX-Video + Wan2.2 TI2V 5B Q4
#   4) frame extraction for reference and Godot rig production
#
# This script never regenerates gameplay animation frame by frame.
# Deterministic walk/idle/sit loops must be built from a 2D rig in Godot.

VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional local configuration. Shell syntax is expected.
[[ -f "${SCRIPT_DIR}/.hellcorp.env" ]] && source "${SCRIPT_DIR}/.hellcorp.env"
ROOT="${HELLCORP_AI_ROOT:-${SCRIPT_DIR}/hellcorp_ai}"
case "$ROOT" in
  /*) ;;
  *) ROOT="${SCRIPT_DIR}/${ROOT}" ;;
esac

MFLUX_VERSION="${HC_MFLUX_VERSION:-0.18.1}"
IMAGE_MODEL_REPO="${HC_IMAGE_MODEL_REPO:-black-forest-labs/FLUX.2-klein-4B}"
VIDEO_MODEL_REPO="${HC_VIDEO_MODEL_REPO:-Wan-AI/Wan2.2-TI2V-5B}"
FACE_WEIGHTS_REPO="${HC_FACE_WEIGHTS_REPO:-ivanfioravanti/FasterLivePortrait-MLX-weights}"

FACE_GIT_URL="${HC_FACE_GIT_URL:-https://github.com/ivanfioravanti/fasterliveportrait-mlx.git}"
VIDEO_GIT_URL="${HC_VIDEO_GIT_URL:-https://github.com/Blaizzy/mlx-video.git}"

RUNTIME_DIR="${ROOT}/runtime"
MODELS_DIR="${ROOT}/models"
CACHE_DIR="${ROOT}/cache"
ASSETS_DIR="${ROOT}/assets"
OUTPUTS_DIR="${ROOT}/outputs"
MOTIONS_DIR="${ROOT}/motions"
DATASETS_DIR="${ROOT}/datasets"

HF_HOME_DIR="${CACHE_DIR}/huggingface"
IMAGE_VENV="${RUNTIME_DIR}/mflux-venv"
IMAGE_PY="${IMAGE_VENV}/bin/python"
IMAGE_HF="${IMAGE_VENV}/bin/hf"
IMAGE_CLI="${IMAGE_VENV}/bin/mflux-generate-flux2"
IMAGE_EDIT_CLI="${IMAGE_VENV}/bin/mflux-generate-flux2-edit"

FACE_SRC="${RUNTIME_DIR}/fasterliveportrait-mlx"
FACE_PY="${FACE_SRC}/.venv/bin/python"
FACE_WEIGHTS_DIR="${MODELS_DIR}/fasterliveportrait-mlx"

VIDEO_SRC="${RUNTIME_DIR}/mlx-video"
VIDEO_PY="${VIDEO_SRC}/.venv/bin/python"
VIDEO_HF="${VIDEO_SRC}/.venv/bin/hf"
VIDEO_RAW_DIR="${MODELS_DIR}/Wan2.2-TI2V-5B-raw"
VIDEO_MLX_DIR="${MODELS_DIR}/Wan2.2-TI2V-5B-MLX-Q4"

IMAGE_MODEL_DIR="${MODELS_DIR}/FLUX.2-klein-4B"

mkdir -p "$ROOT" "$RUNTIME_DIR" "$MODELS_DIR" "$CACHE_DIR" \
  "$ASSETS_DIR" "$OUTPUTS_DIR" "$MOTIONS_DIR" "$DATASETS_DIR" "$HF_HOME_DIR"

export HF_HOME="$HF_HOME_DIR"
export TOKENIZERS_PARALLELISM=false

log()  { printf '\n[%s] %s\n' "$1" "$2"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\n[ATTENTION] %s\n' "$1" >&2; }
die()  { printf '\n[ERREUR] %s\n' "$1" >&2; exit 1; }

on_error() {
  local code=$?
  printf '\n[ERREUR] Echec ligne %s, code %s.\n' "${BASH_LINENO[0]:-?}" "$code" >&2
  exit "$code"
}
trap on_error ERR

usage() {
  cat <<'USAGE'
HellCorp M3 Pipeline

COMMANDES
  doctor
      Verifie macOS, Apple Silicon, memoire unifiee, disque et outils.

  setup
      Installe les outils Homebrew requis et trois environnements Python 3.12 isoles.

  auth
      Ouvre l'authentification Hugging Face dans l'environnement local.

  download-image
      Telecharge FLUX.2 Klein 4B.

  download-face
      Telecharge les poids FasterLivePortrait-MLX.

  download-video
      Telecharge Wan2.2 TI2V 5B puis le convertit en MLX 4 bits.

  download-all
      Telecharge et prepare les trois familles de modeles.

  master NOM [PROMPT_OU_@FICHIER] [SORTIE]
      Genere le master canonique d'un personnage adulte.

  promote NOM IMAGE
      Remplace le master par une image validee, avec archivage de l'ancien master.

  variant NOM TYPE PROMPT_OU_@FICHIER [SORTIE]
      Cree une reference depuis le master: portrait, profil, tenue, pose, etc.

  face SOURCE_IMAGE VIDEO_PILOTE SORTIE [PROFIL]
      Anime le visage. Profil par defaut: quality.

  face-ui
      Lance l'interface FasterLivePortrait sur http://127.0.0.1:9870

  video SOURCE_IMAGE PROMPT_OU_@FICHIER SORTIE
      Genere un court clip I2V avec Wan2.2 TI2V 5B Q4.

  frames VIDEO DOSSIER_SORTIE [FPS] [TAILLE]
      Extrait des frames PNG. Ce sont des references, pas des sprites deterministes.

  rig-scaffold NOM
      Cree l'arborescence de calques/animations pour un rig Godot Skeleton2D.

  status
      Affiche les versions, modeles et chemins installes.

  cleanup-video-raw
      Supprime les poids PyTorch Wan apres validation de la conversion MLX Q4.

VARIABLES UTILES
  HELLCORP_AI_ROOT=/Volumes/SSD/HellCorpAI
  HF_TOKEN=hf_xxx
  HC_FORCE=1
  HC_SEED=666031
  HC_QUANTIZE=4|8
  HC_IMAGE_WIDTH=896
  HC_IMAGE_HEIGHT=1344
  HC_LORA=/chemin/personnage.safetensors
  HC_LORA_SCALE=0.8
  HC_VIDEO_WIDTH=704
  HC_VIDEO_HEIGHT=1280
  HC_VIDEO_FRAMES=21
  HC_VIDEO_STEPS=20

EXEMPLES
  ./hellcorp_m3_pipeline.sh doctor
  ./hellcorp_m3_pipeline.sh setup
  ./hellcorp_m3_pipeline.sh download-all

  ./hellcorp_m3_pipeline.sh master morrigan

  ./hellcorp_m3_pipeline.sh variant morrigan portrait \
    "Close-up executive portrait, preserve the exact same face and hairstyle"

  ./hellcorp_m3_pipeline.sh face \
    hellcorp_ai/assets/characters/morrigan/references/morrigan_portrait.png \
    hellcorp_ai/motions/face_demo.mp4 \
    hellcorp_ai/outputs/morrigan_talk.mp4

  ./hellcorp_m3_pipeline.sh video \
    hellcorp_ai/assets/characters/morrigan/master/morrigan_master.png \
    "She slowly crosses her arms and looks toward camera; locked camera" \
    hellcorp_ai/outputs/morrigan_cross_arms.mp4
USAGE
}

require_macos_arm() {
  [[ "$(uname -s)" == "Darwin" ]] || die "Cette pipeline est reservee a macOS."
  [[ "$(uname -m)" == "arm64" ]] || die "Apple Silicon arm64 requis."
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

memory_gb() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local bytes
    bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    echo $((bytes / 1073741824))
  else
    echo 0
  fi
}

free_disk_gb() {
  local target="$ROOT"
  [[ -d "$target" ]] || target="$SCRIPT_DIR"
  df -Pk "$target" 2>/dev/null | awk 'NR==2 {printf "%d\n", $4 / 1048576}'
}

absolute_existing_path() {
  local value="$1"
  [[ -e "$value" ]] || return 1
  local directory base
  directory="$(cd "$(dirname "$value")" && pwd)"
  base="$(basename "$value")"
  printf '%s/%s' "$directory" "$base"
}

absolute_output_path() {
  local value="$1"
  local directory base
  directory="$(dirname "$value")"
  base="$(basename "$value")"
  mkdir -p "$directory"
  directory="$(cd "$directory" && pwd)"
  printf '%s/%s' "$directory" "$base"
}

chip_name() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    system_profiler SPHardwareDataType 2>/dev/null | awk -F: '/Chip/ {gsub(/^ +| +$/, "", $2); print $2; exit}'
  else
    uname -m
  fi
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

slug_ok() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]
}

read_prompt() {
  local value="${1:-}"
  if [[ "$value" == @* ]]; then
    local file="${value#@}"
    [[ -f "$file" ]] || die "Fichier de prompt introuvable: $file"
    cat "$file"
  else
    printf '%s' "$value"
  fi
}

archive_existing() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local stamp archive_dir
    stamp="$(date +%Y%m%d_%H%M%S)"
    archive_dir="$(dirname "$file")/archive"
    mkdir -p "$archive_dir"
    cp -p "$file" "$archive_dir/$(basename "${file%.*}")_${stamp}.${file##*.}"
  fi
}

write_json_manifest() {
  local manifest="$1"
  local kind="$2"
  local character="$3"
  local output="$4"
  local prompt="$5"
  local seed="$6"
  local source="${7:-}"
  local source_hash="${8:-}"

  MANIFEST="$manifest" KIND="$kind" CHARACTER="$character" OUTPUT="$output" \
  PROMPT_TEXT="$prompt" SEED_VALUE="$seed" SOURCE_FILE="$source" SOURCE_HASH="$source_hash" \
  MODEL_REPO_VALUE="$IMAGE_MODEL_REPO" MFLUX_VERSION_VALUE="$MFLUX_VERSION" \
  "$IMAGE_PY" - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

payload = {
    "kind": os.environ["KIND"],
    "character": os.environ["CHARACTER"],
    "output": os.environ["OUTPUT"],
    "prompt": os.environ["PROMPT_TEXT"],
    "seed": int(os.environ["SEED_VALUE"]),
    "model": os.environ["MODEL_REPO_VALUE"],
    "mflux_version": os.environ["MFLUX_VERSION_VALUE"],
    "source": os.environ.get("SOURCE_FILE") or None,
    "source_sha256": os.environ.get("SOURCE_HASH") or None,
    "created_at": datetime.now(timezone.utc).isoformat(),
}
path = Path(os.environ["MANIFEST"])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
PY
}

ensure_brew() {
  command_exists brew || die "Homebrew manque. Installe Homebrew depuis brew.sh, puis relance setup."
}

brew_install_if_missing() {
  local formula="$1"
  if brew list --formula "$formula" >/dev/null 2>&1; then
    info "$formula deja installe"
  else
    brew install "$formula"
  fi
}

sync_repo() {
  local url="$1"
  local dest="$2"
  local name="$3"

  if [[ -d "$dest/.git" ]]; then
    log GIT "Mise a jour de $name"
    git -C "$dest" fetch --depth 1 origin main
    git -C "$dest" checkout -q main
    git -C "$dest" reset --hard origin/main
  else
    log GIT "Clonage de $name"
    git clone --depth 1 "$url" "$dest"
  fi
}

setup_image_env() {
  log SETUP "Environnement image MFLUX"
  if [[ ! -x "$IMAGE_PY" ]]; then
    uv venv --python 3.12 "$IMAGE_VENV"
  fi
  uv pip install --python "$IMAGE_PY" --upgrade \
    "mflux==${MFLUX_VERSION}" \
    "huggingface_hub[hf_xet]>=0.34.0" \
    "Pillow>=10.0.0"
}

setup_face_env() {
  sync_repo "$FACE_GIT_URL" "$FACE_SRC" "FasterLivePortrait-MLX"
  log SETUP "Environnement animation faciale"
  (
    cd "$FACE_SRC"
    uv sync --python 3.12
  )
}

setup_video_env() {
  sync_repo "$VIDEO_GIT_URL" "$VIDEO_SRC" "MLX-Video"
  log SETUP "Environnement video MLX"
  (
    cd "$VIDEO_SRC"
    uv sync --python 3.12
  )
  uv pip install --python "$VIDEO_PY" --upgrade "huggingface_hub[hf_xet]>=0.34.0"
}

cmd_setup() {
  require_macos_arm
  ensure_brew

  log SETUP "Outils systeme"
  brew update
  brew_install_if_missing uv
  brew_install_if_missing ffmpeg
  brew_install_if_missing git

  log SETUP "Python 3.12 gere par uv"
  uv python install 3.12

  setup_image_env
  setup_face_env
  setup_video_env

  cat > "${SCRIPT_DIR}/.hellcorp.env.example" <<EOFENV
# Copie ce fichier en .hellcorp.env puis adapte les valeurs.
# export HELLCORP_AI_ROOT="/Volumes/SSD/HellCorpAI"
# export HF_TOKEN="hf_xxx"
# export HC_SEED=666031
# export HC_LORA="/chemin/vers/morrigan.safetensors"
# export HC_LORA_SCALE=0.8
EOFENV

  log OK "Installation terminee"
  info "Etape suivante: $0 download-all"
}

ensure_image_env() {
  [[ -x "$IMAGE_PY" && -x "$IMAGE_CLI" ]] || die "Environnement image absent. Lance: $0 setup"
}

ensure_face_env() {
  [[ -x "$FACE_PY" ]] || die "Environnement face absent. Lance: $0 setup"
}

ensure_video_env() {
  [[ -x "$VIDEO_PY" ]] || die "Environnement video absent. Lance: $0 setup"
}

cmd_auth() {
  ensure_image_env
  "$IMAGE_HF" auth login
}

hf_download() {
  local hf_cmd="$1"
  local repo="$2"
  local destination="$3"
  mkdir -p "$destination"
  HF_HOME="$HF_HOME_DIR" "$hf_cmd" download "$repo" --local-dir "$destination"
}

cmd_download_image() {
  ensure_image_env
  if [[ -f "$IMAGE_MODEL_DIR/.hellcorp_complete" && "${HC_FORCE:-0}" != "1" ]]; then
    info "Modele image deja present: $IMAGE_MODEL_DIR"
    return
  fi
  log DOWNLOAD "FLUX.2 Klein 4B"
  hf_download "$IMAGE_HF" "$IMAGE_MODEL_REPO" "$IMAGE_MODEL_DIR"
  touch "$IMAGE_MODEL_DIR/.hellcorp_complete"
}

cmd_download_face() {
  ensure_face_env
  log DOWNLOAD "Poids FasterLivePortrait-MLX"
  mkdir -p "$FACE_WEIGHTS_DIR"
  (
    cd "$FACE_SRC"
    HF_HOME="$HF_HOME_DIR" \
    FLIP_CHECKPOINT_DIR="$FACE_WEIGHTS_DIR" \
    uv run python scripts/download_mlx_weights.py \
      --repo-id "$FACE_WEIGHTS_REPO" \
      --checkpoints-dir "$FACE_WEIGHTS_DIR"
  )

  if [[ -f "$FACE_SRC/assets/examples/driving/d14.mp4" ]]; then
    cp -f "$FACE_SRC/assets/examples/driving/d14.mp4" "$MOTIONS_DIR/face_demo.mp4"
  fi
  touch "$FACE_WEIGHTS_DIR/.hellcorp_complete"
}

python_module_exists() {
  local python="$1"
  local module="$2"
  "$python" - "$module" <<'PY' >/dev/null 2>&1
import importlib.util
import sys
raise SystemExit(0 if importlib.util.find_spec(sys.argv[1]) else 1)
PY
}

detect_wan_convert_module() {
  local candidate
  for candidate in \
    mlx_video.wan2.convert \
    mlx_video.models.wan_2.convert \
    mlx_video.convert_wan
  do
    if python_module_exists "$VIDEO_PY" "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

detect_wan_generate_module() {
  local candidate
  for candidate in \
    mlx_video.wan2.generate \
    mlx_video.models.wan_2.generate \
    mlx_video.generate_wan
  do
    if python_module_exists "$VIDEO_PY" "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

cmd_download_video() {
  ensure_video_env
  local free
  free="$(free_disk_gb)"
  (( free >= 55 )) || die "Au moins 55 Go libres sont requis pour telecharger et convertir Wan. Libre: ${free} Go."

  if [[ -f "$VIDEO_MLX_DIR/.hellcorp_complete" && "${HC_FORCE:-0}" != "1" ]]; then
    info "Modele video MLX Q4 deja present: $VIDEO_MLX_DIR"
    return
  fi

  log DOWNLOAD "Wan2.2 TI2V 5B original"
  hf_download "$VIDEO_HF" "$VIDEO_MODEL_REPO" "$VIDEO_RAW_DIR"

  local module
  module="$(detect_wan_convert_module)" || die "Module de conversion Wan introuvable dans MLX-Video."

  log CONVERT "Wan2.2 TI2V 5B vers MLX 4 bits"
  rm -rf "$VIDEO_MLX_DIR"
  "$VIDEO_PY" -m "$module" \
    --checkpoint-dir "$VIDEO_RAW_DIR" \
    --output-dir "$VIDEO_MLX_DIR" \
    --quantize \
    --bits 4 \
    --group-size 64

  [[ -f "$VIDEO_MLX_DIR/config.json" ]] || die "Conversion Wan incomplete: config.json manque."
  touch "$VIDEO_MLX_DIR/.hellcorp_complete"
  log OK "Wan MLX Q4 pret"
  info "Apres un test video valide: $0 cleanup-video-raw"
}

cmd_download_all() {
  local free
  free="$(free_disk_gb)"
  (( free >= 90 )) || die "download-all exige au moins 90 Go libres. Libre: ${free} Go."
  cmd_download_image
  cmd_download_face
  cmd_download_video
}

image_profile() {
  local mem
  mem="$(memory_gb)"
  if (( mem < 16 )); then
    echo "4 640 960"
  elif (( mem < 24 )); then
    echo "4 768 1152"
  elif (( mem < 36 )); then
    echo "8 896 1344"
  else
    echo "8 1024 1536"
  fi
}

default_master_prompt() {
  local name="$1"
  local lower_name
  lower_name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  case "$lower_name" in
    morrigan)
      cat <<'PROMPT'
Full-body premium game character concept of Morrigan, a fictional adult woman age 31, tall voluptuous hourglass silhouette, long wavy jet-black hair, pale warm skin, amber eyes, confident intelligent expression, elegant black tailored executive suit, fitted blazer, burgundy silk blouse, pencil skirt, sheer black tights, refined gold jewelry, luxury finance executive, subtle infernal corporate details, dark corporate fantasy, neutral charcoal studio background, front three-quarter view, entire body visible from head to shoes, clean readable silhouette, polished high-end illustration, consistent anatomy, no text, no logo
PROMPT
      ;;
    *)
      printf 'Full-body premium game character concept of %s, fictional adult woman age 28, curvy professional silhouette, elegant fitted corporate suit, confident expression, dark corporate fantasy, neutral studio background, front three-quarter view, entire body visible, clean readable silhouette, polished high-end illustration, consistent anatomy, no text, no logo' "$name"
      ;;
  esac
}

LORA_ARGS=()
build_lora_args() {
  local cli="$1"
  local lora="${HC_LORA:-}"
  local scale="${HC_LORA_SCALE:-0.8}"
  LORA_ARGS=()

  [[ -n "$lora" ]] || return 0
  [[ -f "$lora" ]] || die "LoRA introuvable: $lora"

  local help_text
  help_text="$($cli --help 2>&1 || true)"
  if grep -q -- '--lora-paths' <<<"$help_text"; then
    LORA_ARGS=(--lora-paths "$lora" --lora-scales "$scale")
  elif grep -q -- '--lora' <<<"$help_text"; then
    LORA_ARGS=(--lora "$lora" "$scale")
  else
    die "Cette version de MFLUX n'expose pas de parametre LoRA reconnu."
  fi
}

cmd_master() {
  ensure_image_env
  [[ -f "$IMAGE_MODEL_DIR/.hellcorp_complete" ]] || die "Modele image absent. Lance: $0 download-image"

  local name="${1:-}"
  slug_ok "$name" || die "Nom invalide. Utilise lettres, chiffres, tiret ou underscore."

  local supplied="${2:-}"
  local prompt
  if [[ -n "$supplied" ]]; then
    prompt="$(read_prompt "$supplied")"
  else
    prompt="$(default_master_prompt "$name")"
  fi

  local safe_prompt
  safe_prompt="Fictional adult character, clearly age 25 or older. ${prompt}"

  local character_dir="$ASSETS_DIR/characters/$name"
  local master_dir="$character_dir/master"
  local output="${3:-$master_dir/${name}_master.png}"
  mkdir -p "$master_dir" "$character_dir/references" "$character_dir/rig" "$character_dir/manifests"

  if [[ -f "$output" && "${HC_FORCE:-0}" != "1" ]]; then
    die "Le master existe deja: $output. Utilise promote, ou HC_FORCE=1 pour regenerer avec archivage."
  fi
  [[ -f "$output" ]] && archive_existing "$output"

  local profile quant width height
  profile="$(image_profile)"
  IFS=' ' read -r quant width height <<<"$profile"
  quant="${HC_QUANTIZE:-$quant}"
  width="${HC_IMAGE_WIDTH:-$width}"
  height="${HC_IMAGE_HEIGHT:-$height}"
  local steps="${HC_IMAGE_STEPS:-4}"
  local seed="${HC_SEED:-666031}"

  local cmd=(
    "$IMAGE_CLI"
    --model "$IMAGE_MODEL_DIR"
    --prompt "$safe_prompt"
    --steps "$steps"
    --guidance 1.0
    --seed "$seed"
    --width "$width"
    --height "$height"
    --quantize "$quant"
    --output "$output"
  )

  local help_text
  help_text="$($IMAGE_CLI --help 2>&1 || true)"
  if (( $(memory_gb) < 24 )) && grep -q -- '--low-ram' <<<"$help_text"; then
    cmd+=(--low-ram)
  fi
  build_lora_args "$IMAGE_CLI"
  cmd+=("${LORA_ARGS[@]}")

  log GENERATE "Master canonique: $name"
  info "Resolution: ${width}x${height}; quantification: ${quant} bits; seed: $seed"
  "${cmd[@]}"

  [[ -f "$output" ]] || die "MFLUX n'a pas produit le fichier attendu: $output"
  local hash
  hash="$(sha256_file "$output")"
  printf '%s\n' "$hash" > "$master_dir/master.sha256"
  write_json_manifest \
    "$character_dir/manifests/master.json" \
    "master" "$name" "$output" "$safe_prompt" "$seed" "" ""

  log OK "Master cree"
  info "$output"
  info "SHA-256: $hash"
}

cmd_promote() {
  local name="${1:-}"
  local source="${2:-}"
  slug_ok "$name" || die "Nom invalide."
  [[ -f "$source" ]] || die "Image source introuvable: $source"

  local master_dir="$ASSETS_DIR/characters/$name/master"
  local target="$master_dir/${name}_master.png"
  mkdir -p "$master_dir"
  [[ -f "$target" ]] && archive_existing "$target"

  /usr/bin/sips -s format png "$source" --out "$target" >/dev/null
  sha256_file "$target" > "$master_dir/master.sha256"
  log OK "Master promu et verrouille"
  info "$target"
}

cmd_variant() {
  ensure_image_env
  [[ -f "$IMAGE_MODEL_DIR/.hellcorp_complete" ]] || die "Modele image absent. Lance: $0 download-image"

  local name="${1:-}"
  local kind="${2:-}"
  local supplied="${3:-}"
  slug_ok "$name" || die "Nom invalide."
  slug_ok "$kind" || die "Type invalide."
  [[ -n "$supplied" ]] || die "Prompt de variante requis."

  local master="$ASSETS_DIR/characters/$name/master/${name}_master.png"
  [[ -f "$master" ]] || die "Master introuvable: $master"

  local prompt
  prompt="$(read_prompt "$supplied")"
  local full_prompt
  full_prompt="Preserve the exact same fictional adult character from the reference image: identical facial geometry, eye color, hairstyle, hair length, body proportions, skin tone, costume identity and jewelry. Do not redesign the person. ${prompt}"

  local reference_dir="$ASSETS_DIR/characters/$name/references"
  local output="${4:-$reference_dir/${name}_${kind}.png}"
  mkdir -p "$reference_dir" "$ASSETS_DIR/characters/$name/manifests"
  if [[ -f "$output" && "${HC_FORCE:-0}" != "1" ]]; then
    die "La variante existe deja: $output. Utilise HC_FORCE=1 pour l'archiver et la remplacer."
  fi
  [[ -f "$output" ]] && archive_existing "$output"

  local profile quant width height
  profile="$(image_profile)"
  IFS=' ' read -r quant width height <<<"$profile"
  quant="${HC_QUANTIZE:-$quant}"
  width="${HC_IMAGE_WIDTH:-$width}"
  height="${HC_IMAGE_HEIGHT:-$height}"
  local steps="${HC_IMAGE_STEPS:-4}"
  local seed="${HC_SEED:-666031}"

  local cmd=(
    "$IMAGE_EDIT_CLI"
    --model "$IMAGE_MODEL_DIR"
    --image-paths "$master"
    --prompt "$full_prompt"
    --steps "$steps"
    --guidance 1.0
    --seed "$seed"
    --width "$width"
    --height "$height"
    --quantize "$quant"
    --output "$output"
  )
  build_lora_args "$IMAGE_EDIT_CLI"
  cmd+=("${LORA_ARGS[@]}")

  log GENERATE "Variante $kind depuis le master verrouille"
  "${cmd[@]}"
  [[ -f "$output" ]] || die "MFLUX n'a pas produit la variante attendue."

  local master_hash
  master_hash="$(sha256_file "$master")"
  write_json_manifest \
    "$ASSETS_DIR/characters/$name/manifests/${kind}.json" \
    "variant" "$name" "$output" "$full_prompt" "$seed" "$master" "$master_hash"

  log OK "Variante creee"
  info "$output"
}

find_newest_mp4_after() {
  local directory="$1"
  local marker="$2"
  "$FACE_PY" - "$directory" "$marker" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
marker = Path(sys.argv[2]).stat().st_mtime
files = [p for p in root.rglob("*.mp4") if p.stat().st_mtime >= marker]
if files:
    print(max(files, key=lambda p: p.stat().st_mtime))
PY
}

cmd_face() {
  ensure_face_env
  [[ -f "$FACE_WEIGHTS_DIR/.hellcorp_complete" ]] || die "Poids face absents. Lance: $0 download-face"

  local source="${1:-}"
  local driver="${2:-}"
  local output="${3:-}"
  local profile="${4:-quality}"

  [[ -f "$source" ]] || die "Image source introuvable: $source"
  [[ -f "$driver" ]] || die "Video pilote introuvable: $driver"
  [[ -n "$output" ]] || die "Chemin de sortie requis."
  source="$(absolute_existing_path "$source")"
  driver="$(absolute_existing_path "$driver")"
  output="$(absolute_output_path "$output")"

  local marker="$RUNTIME_DIR/.face_marker_$$"
  touch "$marker"

  log ANIMATE "Animation faciale MLX"
  (
    cd "$FACE_SRC"
    HF_HOME="$HF_HOME_DIR" \
    FLIP_CHECKPOINT_DIR="$FACE_WEIGHTS_DIR" \
    uv run python run.py \
      --cfg configs/mlx_infer.yaml \
      --src_image "$source" \
      --dri_video "$driver" \
      --paste-back \
      --relative-motion \
      --stitching \
      --crop-driving-video \
      --driving-option expression-friendly \
      --animation-region all \
      --mlx-profile "$profile"
  )

  local newest
  newest="$(find_newest_mp4_after "$FACE_SRC/results" "$marker")"
  rm -f "$marker"
  [[ -n "$newest" && -f "$newest" ]] || die "Aucun MP4 nouveau trouve dans FasterLivePortrait/results."
  cp -f "$newest" "$output"

  log OK "Animation faciale creee"
  info "$output"
}

cmd_face_ui() {
  ensure_face_env
  [[ -f "$FACE_WEIGHTS_DIR/.hellcorp_complete" ]] || die "Poids face absents. Lance: $0 download-face"
  log UI "FasterLivePortrait: http://127.0.0.1:9870"
  cd "$FACE_SRC"
  HF_HOME="$HF_HOME_DIR" \
  FLIP_CHECKPOINT_DIR="$FACE_WEIGHTS_DIR" \
  uv run python webui.py
}

video_profile() {
  local mem
  mem="$(memory_gb)"
  if (( mem < 24 )); then
    # Forced preview only. This is below the model's preferred 720p portrait size.
    echo "480 832 9 10"
  elif (( mem < 32 )); then
    # Preserve Wan's preferred portrait resolution; reduce temporal load instead.
    echo "704 1280 9 16"
  elif (( mem < 48 )); then
    echo "704 1280 21 24"
  else
    echo "704 1280 41 40"
  fi
}

validate_video_geometry() {
  local width="$1" height="$2" frames="$3"
  (( width % 32 == 0 )) || die "Largeur Wan invalide: elle doit etre divisible par 32."
  (( height % 32 == 0 )) || die "Hauteur Wan invalide: elle doit etre divisible par 32."
  (( (frames - 1) % 4 == 0 )) || die "Nombre de frames invalide: il doit respecter 4n+1."
}

cmd_video() {
  ensure_video_env
  [[ -f "$VIDEO_MLX_DIR/.hellcorp_complete" ]] || die "Modele video absent. Lance: $0 download-video"

  local image="${1:-}"
  local supplied="${2:-}"
  local output="${3:-}"
  [[ -f "$image" ]] || die "Image source introuvable: $image"
  [[ -n "$supplied" ]] || die "Prompt video requis."
  [[ -n "$output" ]] || die "Chemin de sortie requis."
  image="$(absolute_existing_path "$image")"
  output="$(absolute_output_path "$output")"

  local mem
  mem="$(memory_gb)"
  if (( mem < 24 )) && [[ "${HC_FORCE_VIDEO:-0}" != "1" ]]; then
    die "Wan2.2 TI2V 5B Q4 n'est pas recommande sous 24 Go. Pour un essai tres court: HC_FORCE_VIDEO=1."
  fi

  local prompt
  prompt="$(read_prompt "$supplied")"
  local full_prompt
  full_prompt="Preserve the exact identity, face, hair, body proportions, clothing and jewelry of the fictional adult character in the input image. ${prompt}. Stable anatomy, coherent hands, no identity change, no costume change, locked visual design."

  local profile width height frames steps
  profile="$(video_profile)"
  IFS=' ' read -r width height frames steps <<<"$profile"
  width="${HC_VIDEO_WIDTH:-$width}"
  height="${HC_VIDEO_HEIGHT:-$height}"
  frames="${HC_VIDEO_FRAMES:-$frames}"
  steps="${HC_VIDEO_STEPS:-$steps}"
  local seed="${HC_SEED:-666031}"
  local guide="${HC_VIDEO_GUIDE:-5.0}"

  validate_video_geometry "$width" "$height" "$frames"
  mkdir -p "$(dirname "$output")"

  local module
  module="$(detect_wan_generate_module)" || die "Module de generation Wan introuvable."

  log VIDEO "Wan2.2 TI2V 5B Q4"
  info "Resolution: ${width}x${height}; frames: $frames; steps: $steps; seed: $seed"
  warn "Ce clip est destine aux cinematiques courtes. Il ne remplace pas un rig Godot pour walk/idle/sit."

  "$VIDEO_PY" -m "$module" \
    --model-dir "$VIDEO_MLX_DIR" \
    --image "$image" \
    --prompt "$full_prompt" \
    --negative-prompt "identity change, different person, face drift, costume change, body deformation, extra limbs, missing fingers, malformed hands, unstable background, text, watermark, low quality, blurry" \
    --width "$width" \
    --height "$height" \
    --num-frames "$frames" \
    --steps "$steps" \
    --guide-scale "$guide" \
    --seed "$seed" \
    --scheduler unipc \
    --tiling auto \
    --output-path "$output"

  [[ -f "$output" ]] || die "Wan n'a pas produit le MP4 attendu."
  log OK "Clip cree"
  info "$output"
}

cmd_frames() {
  command_exists ffmpeg || die "ffmpeg manque. Lance: $0 setup"
  local video="${1:-}"
  local destination="${2:-}"
  local fps="${3:-8}"
  local size="${4:-512}"
  [[ -f "$video" ]] || die "Video introuvable: $video"
  [[ -n "$destination" ]] || die "Dossier de sortie requis."
  mkdir -p "$destination"

  ffmpeg -y -i "$video" \
    -vf "fps=${fps},scale=${size}:-2:flags=lanczos" \
    "$destination/frame_%04d.png"

  log OK "Frames extraites"
  info "$destination"
}

cmd_rig_scaffold() {
  local name="${1:-}"
  slug_ok "$name" || die "Nom invalide."
  local rig="$ASSETS_DIR/characters/$name/rig"
  mkdir -p \
    "$rig/parts/head" \
    "$rig/parts/hair" \
    "$rig/parts/torso" \
    "$rig/parts/arms" \
    "$rig/parts/hands" \
    "$rig/parts/hips" \
    "$rig/parts/legs" \
    "$rig/parts/feet" \
    "$rig/animations/idle" \
    "$rig/animations/walk" \
    "$rig/animations/sit" \
    "$rig/animations/talk" \
    "$rig/godot"

  cat > "$rig/rig_manifest.json" <<EOFJSON
{
  "character": "$name",
  "engine": "Godot 4",
  "rig": "Skeleton2D",
  "required_parts": [
    "head", "hair_back", "hair_front", "torso",
    "upper_arm_left", "lower_arm_left", "hand_left",
    "upper_arm_right", "lower_arm_right", "hand_right",
    "hips", "thigh_left", "calf_left", "foot_left",
    "thigh_right", "calf_right", "foot_right"
  ],
  "required_loops": ["idle", "walk", "sit", "talk"]
}
EOFJSON

  log OK "Arborescence de rig creee"
  info "$rig"
}

cmd_cleanup_video_raw() {
  [[ -f "$VIDEO_MLX_DIR/.hellcorp_complete" && -f "$VIDEO_MLX_DIR/config.json" ]] \
    || die "Conversion MLX non validee. Suppression refusee."
  [[ "$VIDEO_RAW_DIR" == "$ROOT"/* ]] || die "Chemin dangereux. Suppression refusee."
  rm -rf "$VIDEO_RAW_DIR"
  log OK "Poids Wan PyTorch bruts supprimes"
}

status_line() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    printf '  %-28s OK  %s\n' "$label" "$path"
  else
    printf '  %-28s --  %s\n' "$label" "$path"
  fi
}

cmd_status() {
  printf 'HellCorp M3 Pipeline %s\n' "$VERSION"
  printf 'Racine: %s\n' "$ROOT"
  printf 'Puce: %s\n' "$(chip_name)"
  printf 'Memoire unifiee: %s Go\n' "$(memory_gb)"
  printf 'Disque libre: %s Go\n\n' "$(free_disk_gb)"

  status_line "MFLUX Python" "$IMAGE_PY"
  status_line "FLUX.2 Klein 4B" "$IMAGE_MODEL_DIR/.hellcorp_complete"
  status_line "FasterLivePortrait code" "$FACE_PY"
  status_line "FasterLivePortrait poids" "$FACE_WEIGHTS_DIR/.hellcorp_complete"
  status_line "MLX-Video code" "$VIDEO_PY"
  status_line "Wan2.2 TI2V 5B Q4" "$VIDEO_MLX_DIR/.hellcorp_complete"

  if [[ -d "$FACE_SRC/.git" ]]; then
    printf '  %-28s %s\n' "Commit face" "$(git -C "$FACE_SRC" rev-parse --short HEAD)"
  fi
  if [[ -d "$VIDEO_SRC/.git" ]]; then
    printf '  %-28s %s\n' "Commit video" "$(git -C "$VIDEO_SRC" rev-parse --short HEAD)"
  fi
}

cmd_doctor() {
  printf 'HellCorp M3 Pipeline %s - Doctor\n' "$VERSION"
  printf '%s\n' '----------------------------------------'
  printf 'OS: %s\n' "$(uname -s)"
  printf 'Architecture: %s\n' "$(uname -m)"
  printf 'Puce: %s\n' "$(chip_name)"
  printf 'Memoire unifiee: %s Go\n' "$(memory_gb)"
  printf 'Disque libre: %s Go\n' "$(free_disk_gb)"
  printf 'Racine pipeline: %s\n\n' "$ROOT"

  local tool
  for tool in brew uv git ffmpeg; do
    if command_exists "$tool"; then
      printf '  %-10s OK  %s\n' "$tool" "$(command -v "$tool")"
    else
      printf '  %-10s --  absent\n' "$tool"
    fi
  done

  printf '\nEvaluation:\n'
  if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    printf '  Incompatible: macOS Apple Silicon requis.\n'
  elif (( $(memory_gb) < 16 )); then
    printf '  Image Q4 et animation faciale possibles avec fortes limites.\n'
    printf '  Wan2.2 TI2V 5B non recommande.\n'
  elif (( $(memory_gb) < 24 )); then
    printf '  Image Q4 et animation faciale adaptees.\n'
    printf '  Wan2.2 TI2V 5B non recommande sans HC_FORCE_VIDEO=1.\n'
  elif (( $(memory_gb) < 48 )); then
    printf '  Pipeline complete utilisable; clips Wan courts.\n'
  else
    printf '  Pipeline complete adaptee, y compris Wan 720p court.\n'
  fi
}

main() {
  local command="${1:-help}"
  shift || true

  case "$command" in
    help|-h|--help) usage ;;
    doctor) cmd_doctor "$@" ;;
    setup) cmd_setup "$@" ;;
    auth) cmd_auth "$@" ;;
    download-image) cmd_download_image "$@" ;;
    download-face) cmd_download_face "$@" ;;
    download-video) cmd_download_video "$@" ;;
    download-all) cmd_download_all "$@" ;;
    master) cmd_master "$@" ;;
    promote) cmd_promote "$@" ;;
    variant) cmd_variant "$@" ;;
    face) cmd_face "$@" ;;
    face-ui) cmd_face_ui "$@" ;;
    video) cmd_video "$@" ;;
    frames) cmd_frames "$@" ;;
    rig-scaffold) cmd_rig_scaffold "$@" ;;
    status) cmd_status "$@" ;;
    cleanup-video-raw) cmd_cleanup_video_raw "$@" ;;
    *) die "Commande inconnue: $command. Lance: $0 help" ;;
  esac
}

main "$@"
