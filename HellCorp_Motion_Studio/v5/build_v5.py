#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "app.js"
DST = ROOT / "app_v5.js"
INDEX = ROOT / "index.html"
INDEX_V5 = ROOT / "index_v5.html"

IMPORTS = (
    "import { loadMixamoFbx, createMixamoRetargeter, summarizeMixamoAsset } "
    "from './v5/mixamo_retarget.js';\n"
)

APPEND = r'''
let mixamoAssetV5 = null;
let mixamoFileNameV5 = null;

function renderSceneCleanV5(dt) {
  if (currentVrm) currentVrm.update(dt);
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(scene, camera);
}

window.__loadMixamoFbxFromInput = async () => {
  const input = document.getElementById('mixamoFbxInput');
  const file = input?.files?.[0];
  if (!file) throw new Error('No Mixamo FBX selected.');

  setProgress(0, 'Parsing Mixamo FBX...');
  mixamoAssetV5 = await loadMixamoFbx(file);
  mixamoFileNameV5 = file.name;
  const summary = summarizeMixamoAsset(mixamoAssetV5);
  log(`MIXAMO V5: ${file.name} - ${summary.boneCount} bones - ${summary.clips.length} animation clip(s).`);
  for (const clip of summary.clips) {
    log(`  clip[${clip.index}] ${clip.name || '(unnamed)'} duration=${clip.duration.toFixed(3)}s tracks=${clip.tracks}`);
  }
  setProgress(1, 'Mixamo FBX ready.');
  return summary;
};

window.__renderMixamoClip = async (options = {}) => {
  if (!currentVrm) throw new Error('Load a target VRM first.');
  if (!mixamoAssetV5) throw new Error('Load a Mixamo FBX first.');

  const fps = Math.max(1, Number(options.fps || 30));
  const size = Math.max(64, Number(options.size || 768));
  const view = options.view || 'front';
  const rootMode = options.rootMode || 'inplace';
  const clipSelector = options.clipSelector ?? 0;
  const rotationStrength = Number(options.rotationStrength ?? 1.0);
  const rootStrength = Number(options.rootStrength ?? 1.0);
  const preRollFrames = Math.max(0, Number(options.preRollFrames ?? Math.round(fps * 0.5)));
  const outputName = safeName(options.outputName || `${stem(currentVrmFile)}_${safeName(mixamoFileNameV5)}_${view}`);

  resetVrmPose();
  currentVrm.scene.position.set(0, 0, 0);
  currentVrm.scene.updateMatrixWorld(true);

  const retargeter = createMixamoRetargeter({
    source: mixamoAssetV5.source,
    sourceIndex: mixamoAssetV5.index,
    animations: mixamoAssetV5.animations,
    clipSelector,
    getTargetBone: getBone,
    resetTargetPose: resetVrmPose,
    targetRoot: currentVrm.scene,
    rootMode,
    rotationStrength,
    rootStrength,
  });

  const clipDuration = Math.max(1e-6, retargeter.duration);
  const start = Math.max(0, Math.min(Number(options.start ?? 0), clipDuration));
  const requestedEnd = options.end == null ? clipDuration : Number(options.end);
  const end = Math.max(start + 1 / fps, Math.min(requestedEnd, clipDuration));
  const frameCount = Math.max(1, Math.ceil((end - start) * fps));
  const dt = 1 / fps;
  const diagnostics = retargeter.diagnostics();

  log(
    `MIXAMO V5 retarget: mapped=${diagnostics.mappedBones}, scale=${diagnostics.scale.toFixed(5)}, ` +
    `root=${rootMode}, clip=${diagnostics.clip}.`
  );
  if (diagnostics.missingTarget.length) {
    log(`MIXAMO V5 optional target bones missing: ${diagnostics.missingTarget.join(', ')}`);
  }

  const root = await navigator.storage.getDirectory();
  const outDir = await childDir(root, outputName);
  const framesDir = await childDir(outDir, 'frames');

  const renderSize = Math.round(size * supersampleFor(size));
  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  setView(view);
  els.posterize.checked = false;

  // V5 bypasses OutlineAO, luminance banding, grade, sharpen and pixel conversion.
  // Continuity and animation quality are the source of truth for now.
  for (let i = -preRollFrames; i < 0; i++) {
    const t = start + i * dt;
    retargeter.applyTime(t);
    renderSceneCleanV5(dt);
  }

  for (let i = 0; i < frameCount; i++) {
    const t = start + i * dt;
    retargeter.applyTime(t);
    renderSceneCleanV5(dt);
    const frameCanvas = copyRenderToWork(size);
    await writeBlob(
      framesDir,
      `frame_${String(i).padStart(6, '0')}.png`,
      await canvasBlob(frameCanvas),
    );

    if ((i & 3) === 0 || i === frameCount - 1) {
      setProgress((i + 1) / frameCount, `Mixamo V5 ${i + 1}/${frameCount}`);
      await nextFrame();
    }
  }

  const manifest = {
    format: 'HellCorpMixamoRenderV1',
    target_vrm: currentVrmFile?.name || null,
    source_fbx: mixamoFileNameV5,
    clip: diagnostics.clip,
    clip_selector: clipSelector,
    clip_duration: clipDuration,
    range: [start, end],
    fps,
    frame_count: frameCount,
    frame_size: [size, size],
    view,
    root_mode: rootMode,
    rotation_strength: rotationStrength,
    root_strength: rootStrength,
    renderer: {
      mode: 'native-vrm-clean',
      post_fx: false,
      pixel_art: false,
      supersample: supersampleFor(size),
    },
    retarget: diagnostics,
  };

  await writeText(outDir, 'manifest.json', JSON.stringify(manifest, null, 2));

  retargeter.dispose();
  resetVrmPose();
  currentVrm.scene.position.set(0, 0, 0);
  renderer.setSize(768, 768, false);
  setView(previewView);
  renderScene();

  setProgress(1, `Mixamo V5 complete: ${outputName}`);
  log(`MIXAMO V5 complete: ${outputName}, ${frameCount} frames.`);
  return manifest;
};
'''


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)


def main() -> None:
    src = SRC.read_text(encoding="utf-8")
    DST.write_text(IMPORTS + src + APPEND, encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    html = replace_once(
        html,
        '<script type="module" src="app.js"></script>',
        '<script type="module" src="app_v5.js"></script>',
        "entrypoint",
    )
    html = html.replace(
        '<title>HellCorp Motion Studio</title>',
        '<title>HellCorp Motion Studio V5 - Mixamo</title>',
        1,
    )
    html = html.replace(
        '<h1>HellCorp Motion Studio</h1>',
        '<h1>HellCorp Motion Studio V5 - Mixamo Retarget</h1>',
        1,
    )
    html = html.replace(
        '<p>VRM + Body Video + Face Video -> sprites 2D</p>',
        '<p>VRM + Mixamo FBX -> continuous high-quality animation frames</p>',
        1,
    )

    vrm_box_end = '''      </label>

      <label class="filebox">
        <span>Dossier body</span>'''
    mixamo_box = '''      </label>

      <label class="filebox">
        <span>Animation Mixamo FBX</span>
        <input id="mixamoFbxInput" type="file" accept=".fbx,application/octet-stream" />
        <strong>FBX animation</strong>
      </label>

      <label class="filebox">
        <span>Dossier body</span>'''
    html = replace_once(html, vrm_box_end, mixamo_box, "mixamo-input")

    INDEX_V5.write_text(html, encoding="utf-8")
    print(f"Generated {DST.relative_to(ROOT)}")
    print(f"Generated {INDEX_V5.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
