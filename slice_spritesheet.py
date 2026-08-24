#!/usr/bin/env python3
"""
Decoupe intelligente de feuilles de sprites (grille personnage x pose) en
fichiers individuels, pour import facile dans Godot (AnimatedSprite2D /
SpriteFrames).

Ce n'est pas un decoupage bete en cellules de taille fixe: le fond (quasi
uniforme, coins de l'image) est detecte automatiquement, puis un profil de
pixels "premier plan" sert a trouver les vraies bandes de lignes (les 4
rangees de poses) et, a l'interieur de chaque ligne, les vraies colonnes
(les 4 frames). Si la detection ne retombe pas sur le nombre attendu de
bandes (lignes qui se touchent, artefact...), on retombe proprement sur un
decoupage egal plutot que de planter.

Usage:
    hellcorp_ai/.venv/bin/python3 slice_spritesheet.py
    hellcorp_ai/.venv/bin/python3 slice_spritesheet.py assets/lucy.png
    hellcorp_ai/.venv/bin/python3 slice_spritesheet.py --rows 4 --cols 4 --debug
    hellcorp_ai/.venv/bin/python3 slice_spritesheet.py --transparent

(Pillow n'est pas dans le python3 systeme de ce Mac -> on utilise le venv
deja present dans hellcorp_ai/.venv pour ce depot.)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit(
        "Pillow/numpy manquants pour ce python3.\n"
        "Relance avec le venv du depot, par exemple:\n"
        "  hellcorp_ai/.venv/bin/python3 slice_spritesheet.py"
    )

ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT_DIR = ROOT / "assets"
DEFAULT_OUTPUT_DIR = DEFAULT_INPUT_DIR / "sliced"


def detect_background_color(arr: np.ndarray) -> np.ndarray:
    """Couleur de fond = mediane d'une bordure de 2px sur les 4 cotes."""
    border = np.concatenate([
        arr[0:2, :, :3].reshape(-1, 3),
        arr[-2:, :, :3].reshape(-1, 3),
        arr[:, 0:2, :3].reshape(-1, 3),
        arr[:, -2:, :3].reshape(-1, 3),
    ])
    return np.median(border, axis=0)


def foreground_mask(arr: np.ndarray, bg: np.ndarray, threshold: float) -> np.ndarray:
    diff = arr[..., :3].astype(np.int32) - bg.astype(np.int32)
    dist = np.sqrt((diff ** 2).sum(axis=-1))
    return dist > threshold


def find_bands(active: np.ndarray, min_gap: int) -> list[tuple[int, int]]:
    """Segments contigus (start, end inclus) ou `active` est vrai, en
    fusionnant les segments separes par un trou <= min_gap (bruit)."""
    n = len(active)
    runs: list[list[int]] = []
    i = 0
    while i < n:
        if active[i]:
            j = i
            while j < n and active[j]:
                j += 1
            runs.append([i, j - 1])
            i = j
        else:
            i += 1
    merged: list[list[int]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] - 1 <= min_gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged]


def equal_bands(length: int, count: int) -> list[tuple[int, int]]:
    edges = np.linspace(0, length, count + 1).round().astype(int)
    return [(int(edges[i]), int(edges[i + 1]) - 1) for i in range(count)]


def reconcile_bands(
    bands: list[tuple[int, int]], target: int, length: int
) -> tuple[list[tuple[int, int]], str]:
    """Ajuste les bandes detectees au nombre attendu.
    - trop de bandes -> fusionne les paires les plus proches (petit trou);
    - trop peu / echec -> decoupage egal (fallback), jamais d'echec dur."""
    if len(bands) == target:
        return bands, "detecte"
    if len(bands) == 0:
        return equal_bands(length, target), "egal (rien detecte)"
    if len(bands) > target:
        merged = [list(b) for b in bands]
        while len(merged) > target:
            gaps = [merged[i + 1][0] - merged[i][1] - 1 for i in range(len(merged) - 1)]
            k = int(np.argmin(gaps))
            merged[k][1] = merged[k + 1][1]
            del merged[k + 1]
        return [(a, b) for a, b in merged], "detecte+fusionne"
    return equal_bands(length, target), f"egal (seulement {len(bands)} detectees)"


def pad_clamped(a: int, b: int, pad: int, lo: int, hi: int) -> tuple[int, int]:
    return max(lo, a - pad), min(hi, b + pad)


def flood_fill_from_border(candidate: np.ndarray) -> np.ndarray:
    """Sous-ensemble de `candidate` connecte au bord de l'image (4-connexite),
    par reconstruction morphologique (dilatation iterative bornee par
    `candidate`). Sert a ne detourer que le vrai fond exterieur, sans manger
    les zones sombres A L'INTERIEUR d'un sprite (ex: vetements noirs sur un
    fond noir) qui ressemblent au fond par coincidence de couleur mais ne
    touchent jamais le bord."""
    marker = np.zeros_like(candidate)
    marker[0, :] = candidate[0, :]
    marker[-1, :] = candidate[-1, :]
    marker[:, 0] = candidate[:, 0]
    marker[:, -1] = candidate[:, -1]
    while True:
        grown = marker.copy()
        grown[1:, :] |= marker[:-1, :]
        grown[:-1, :] |= marker[1:, :]
        grown[:, 1:] |= marker[:, :-1]
        grown[:, :-1] |= marker[:, 1:]
        grown &= candidate
        if np.array_equal(grown, marker):
            return grown
        marker = grown


def apply_chroma_key(arr_rgba: np.ndarray, bg: np.ndarray, threshold: float) -> np.ndarray:
    """Rend le fond transparent avec un leger degrade (feather) plutot
    qu'une decoupe dure, pour eviter un liseret sombre autour du sprite.
    Seules les zones de couleur "fond" connectees au bord sont detourees."""
    diff = arr_rgba[..., :3].astype(np.float32) - bg.astype(np.float32)
    dist = np.sqrt((diff ** 2).sum(axis=-1))
    low, high = threshold, threshold * 2.0
    candidate = dist <= high
    border_bg = flood_fill_from_border(candidate)
    alpha = np.clip((dist - low) / (high - low), 0.0, 1.0)
    alpha = np.where(border_bg, alpha, 1.0)
    out = arr_rgba.copy()
    out[..., 3] = (alpha * 255).astype(np.uint8)
    return out


def slice_sheet(
    path: Path,
    out_root: Path,
    rows: int,
    cols: int,
    padding: int,
    threshold: float,
    transparent: bool,
    debug: bool,
) -> None:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    arr = np.array(im)
    bg = detect_background_color(arr)
    mask = foreground_mask(arr, bg, threshold)

    row_active = mask.sum(axis=1) > max(2, int(0.002 * w))
    row_bands_raw = find_bands(row_active, min_gap=max(1, int(0.0025 * h)))
    row_bands, row_method = reconcile_bands(row_bands_raw, rows, h)

    stem = path.stem.replace(" ", "_")
    out_dir = out_root / stem
    out_dir.mkdir(parents=True, exist_ok=True)

    debug_im = im.copy() if debug else None
    debug_draw = ImageDraw.Draw(debug_im) if debug_im is not None else None

    n_written = 0
    print(f"{path.name}: {len(row_bands)} ligne(s) [{row_method}]")

    for r, (ry0, ry1) in enumerate(row_bands):
        py0, py1 = pad_clamped(ry0, ry1, padding, 0, h - 1)
        col_active = mask[ry0:ry1 + 1, :].sum(axis=0) > max(2, int(0.002 * (ry1 - ry0 + 1)))
        col_bands_raw = find_bands(col_active, min_gap=max(1, int(0.0025 * w)))
        col_bands, col_method = reconcile_bands(col_bands_raw, cols, w)
        print(f"  ligne {r}: {len(col_bands)} colonne(s) [{col_method}]")

        for c, (cx0, cx1) in enumerate(col_bands):
            px0, px1 = pad_clamped(cx0, cx1, padding, 0, w - 1)
            crop = arr[py0:py1 + 1, px0:px1 + 1].copy()
            if transparent:
                crop = apply_chroma_key(crop, bg, threshold)
            frame_path = out_dir / f"{stem}_row{r:02d}_frame{c:02d}.png"
            Image.fromarray(crop).save(frame_path)
            n_written += 1

            if debug_draw is not None:
                debug_draw.rectangle([px0, py0, px1, py1], outline=(255, 0, 255, 255), width=2)

    if debug_im is not None:
        debug_path = out_dir / f"{stem}_debug_grid.png"
        debug_im.save(debug_path)
        print(f"  debug -> {debug_path}")

    print(f"  -> {n_written} frame(s) dans {out_dir}")


def collect_inputs(inputs: list[str]) -> list[Path]:
    if not inputs:
        return sorted(DEFAULT_INPUT_DIR.glob("*.png"))
    paths: list[Path] = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            paths.extend(sorted(p.glob("*.png")))
        else:
            paths.append(p)
    return paths


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="*", help="fichiers .png ou dossiers (defaut: assets/*.png)")
    ap.add_argument("--out", default=str(DEFAULT_OUTPUT_DIR), help="dossier de sortie")
    ap.add_argument("--rows", type=int, default=4, help="nombre de lignes attendu (defaut 4)")
    ap.add_argument("--cols", type=int, default=4, help="nombre de frames par ligne (defaut 4)")
    ap.add_argument("--padding", type=int, default=4, help="marge en px autour de chaque frame")
    ap.add_argument("--threshold", type=float, default=30.0, help="sensibilite detection fond/sprite")
    ap.add_argument(
        "--transparent", action="store_true",
        help="detoure le fond en alpha (flood-fill depuis le bord). "
             "Marche bien si le perso contraste avec le fond; sur un perso "
             "tres sombre sur fond noir ca peut manger du tissu (voir les !!)",
    )
    ap.add_argument("--debug", action="store_true", help="ecrit une image avec la grille detectee dessinee dessus")
    args = ap.parse_args()

    files = collect_inputs(args.inputs)
    files = [f for f in files if f.suffix.lower() == ".png" and "sliced" not in f.parts]
    if not files:
        sys.exit(f"Aucun .png trouve (cherche dans {DEFAULT_INPUT_DIR} par defaut).")

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    if args.transparent:
        print(
            "note: --transparent detoure via flood-fill depuis le bord de "
            "chaque frame (pas juste un seuil de couleur), donc les zones "
            "sombres a l'INTERIEUR d'un sprite restent opaques meme sur fond "
            "noir. Mais si le perso a du tissu/cheveux rendu exactement a la "
            "meme valeur (0,0,0) que le fond, sans aucun contour, il n'y a "
            "aucune info pour les separer -> verifie visuellement les "
            "personnages tres sombres avant de les utiliser dans Godot.\n"
        )

    for f in files:
        if not f.exists():
            print(f"!! introuvable, ignore: {f}", file=sys.stderr)
            continue
        slice_sheet(
            f, out_root,
            rows=args.rows, cols=args.cols, padding=args.padding,
            threshold=args.threshold, transparent=args.transparent,
            debug=args.debug,
        )


if __name__ == "__main__":
    main()
