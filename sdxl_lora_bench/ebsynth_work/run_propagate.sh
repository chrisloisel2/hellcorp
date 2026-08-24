#!/bin/sh
set -e
EBSYNTH=/Users/christopher/HellCEO/sdxl_lora_bench/ebsynth_src/bin/ebsynth
GUIDES=/Users/christopher/HellCEO/sdxl_lora_bench/ebsynth_work/guides
STYLE=/Users/christopher/HellCEO/sdxl_lora_bench/out/full_walk_smoothed_0.2
OUT=/Users/christopher/HellCEO/sdxl_lora_bench/ebsynth_work/out

KEYFRAMES="0 8 12 18 24 30 36 42"

nearest_keyframe() {
  target=$1
  best=0
  bestdist=999
  for k in $KEYFRAMES; do
    d=$(( target - k ))
    if [ $d -lt 0 ]; then d=$(( -d )); fi
    if [ $d -lt $bestdist ]; then bestdist=$d; best=$k; fi
  done
  echo $best
}

i=0
while [ $i -le 42 ]; do
  fi=$(printf "%06d" $i)
  is_kf=0
  for k in $KEYFRAMES; do
    if [ "$k" = "$i" ]; then is_kf=1; fi
  done
  if [ $is_kf -eq 1 ]; then
    cp "$STYLE/frame_$fi.png" "$OUT/frame_$fi.png"
    echo "[kf] frame_$fi copied directly"
  else
    kf=$(nearest_keyframe $i)
    kfi=$(printf "%06d" $kf)
    echo "[gen] frame_$fi from keyframe $kfi"
    "$EBSYNTH" -style "$STYLE/frame_$kfi.png" \
      -guide "$GUIDES/frame_$kfi.png" "$GUIDES/frame_$fi.png" \
      -output "$OUT/frame_$fi.png" \
      -patchsize 5 -pyramidlevels 6 -searchvoteiters 12 -patchmatchiters 6 -extrapass3x3
  fi
  i=$(( i + 1 ))
done
echo "ALL_DONE"
