#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description='Validate a HellCorp Puppet2D render manifest.')
    parser.add_argument('manifest')
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    root = manifest_path.parent
    with manifest_path.open('r', encoding='utf-8') as f:
        manifest = json.load(f)

    errors = []
    if manifest.get('format') != 'HellCorpPuppetRenderV1': errors.append(f"bad format: {manifest.get('format')}")
    if manifest.get('diffusion_used') is not False: errors.append('diffusion_used must be false')
    if manifest.get('ebsynth_used') is not False: errors.append('ebsynth_used must be false')
    if manifest.get('source_texture_changes') is not False: errors.append('source_texture_changes must be false')
    expected_size = tuple(manifest.get('frame_size', []))
    frame_hashes = manifest.get('frame_hashes', [])
    if len(frame_hashes) != manifest.get('frame_count'): errors.append('frame hash count does not match frame_count')

    for item in frame_hashes:
        index = int(item['index'])
        frame_path = root / 'frames' / f'frame_{index:04d}.png'
        if not frame_path.exists():
            errors.append(f'missing frame {frame_path.name}')
            continue
        if sha256_file(frame_path) != item['sha256']: errors.append(f'hash mismatch for {frame_path.name}')
        with Image.open(frame_path) as image:
            if tuple(image.size) != expected_size: errors.append(f'wrong dimensions for {frame_path.name}: {image.size}')

    for rel in ('atlas.png', 'atlas.json', 'preview.gif'):
        if not (root / rel).exists(): errors.append(f'missing {rel}')

    if errors:
        print('PUPPET_VALIDATION_FAIL')
        for error in errors: print(f'- {error}')
        raise SystemExit(1)

    print('PUPPET_VALIDATION_PASS')
    print(f"frames={manifest.get('frame_count')} size={manifest.get('frame_size')} fps={manifest.get('fps')}")
    print(f"source_art_sha256={manifest.get('source_art_sha256')}")


if __name__ == '__main__':
    main()
