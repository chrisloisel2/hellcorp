#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "app.js"
DST = ROOT / "app_v3.js"
INDEX = ROOT / "index.html"
INDEX_V3 = ROOT / "index_v3.html"

IMPORT = "import { createAuthoredRuntime, authoredClipSummary } from './v3/authored_animation.js';\n"

APPEND = r'''

function applyAuthoredPoseV3(pose) {
  resetVrmPose();
  for (const [boneName, rot] of Object.entries(pose?.bones || {})) {
    setBoneRotation(boneName, rot, 1);
  }
  if (pose?.root) {
    currentVrm.scene.position.set(
      Number(pose.root.x || 0),
      Number(pose.root.y || 0),
      Number(pose.root.z || 0),
    );
  }

  const eyeScale = 1.0;
  if (pose?.eyes) {
    const x = Number(pose.eyes.x || 0) * eyeScale;
    const y = Number(pose.eyes.y || 0) * eyeScale;
    const le = getBone('leftEye');
    const re = getBone('rightEye');
    if (le) le.rotation.set(y, x, 0);
    if (re) re.rotation.set(y, x, 0);
  }

  const em = currentVrm?.expressionManager;
  if (em) {
    em.resetValues();
    const blink = clamp(Number(pose?.expressions?.blink || 0));
    const leftDone = setExpr('blinkLeft', blink);
    const rightDone = setExpr('blinkRight', blink);
    if (!leftDone && !rightDone) setExpr('blink', blink);

    const happy = clamp(Number(pose?.expressions?.happy || 0));
    setFirstExpr(['happy', 'joy'], happy);
    const relaxed = clamp(Number(pose?.expressions?.relaxed || 0));
    setFirstExpr(['relaxed'], relaxed);
    const mouthOpen = clamp(Number(pose?.expressions?.mouthOpen || 0));
    if (mouthOpen > 0) setFirstExpr(['aa', 'a'], mouthOpen);
    em.update();
  }
}

window.__renderAuthoredClip = async (clip, profile, options = {}) => {
  if (!currentVrm) throw new Error('Load a VRM before authored rendering.');

  const fps = Number(options.fps || clip?.fps || 30);
  const cycles = Math.max(1, Number(options.cycles || 1));
  const size = Math.max(64, Number(options.size || 512));
  const view = options.view || 'front';
  const outputName = safeName(options.outputName || `${profile?.name || 'character'}_${clip?.name || 'clip'}_${view}`);
  const preRollFrames = Math.max(0, Number(options.preRollFrames ?? 12));
  const runtime = createAuthoredRuntime(clip, profile, { fps });
  const count = runtime.framesPerCycle * cycles;
  const dt = 1 / fps;

  const root = await navigator.storage.getDirectory();
  const outDir = await childDir(root, outputName);
  const framesDir = await childDir(outDir, 'frames');
  const renderSize = Math.round(size * supersampleFor(size));

  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  setupPostFX(renderSize);
  setView(view);
  els.posterize.checked = false;

  // Deterministic preroll lets VRM spring bones settle into the authored motion
  // before the first exported frame. The same fixed dt is used for every run.
  for (let i = -preRollFrames; i < 0; i++) {
    const pose = runtime.frame(i);
    applyAuthoredPoseV3(pose);
    renderScenePostFX(dt, renderSize);
  }

  for (let i = 0; i < count; i++) {
    const pose = runtime.frame(i);
    applyAuthoredPoseV3(pose);
    renderScenePostFX(dt, renderSize);
    const frameCanvas = copyRenderToWork(size);
    await writeBlob(framesDir, `frame_${String(i).padStart(6, '0')}.png`, await canvasBlob(frameCanvas));
    if ((i & 1) === 0 || i === count - 1) {
      setProgress((i + 1) / count, `Authored V3 ${i + 1}/${count}`);
      await nextFrame();
    }
  }

  const manifest = {
    format: 'HellCorpAuthoredRenderV1',
    character: profile?.name || stem(currentVrmFile),
    vrm: currentVrmFile?.name || null,
    clip: clip?.name || 'authored_clip',
    fps,
    duration: runtime.duration,
    frames_per_cycle: runtime.framesPerCycle,
    cycles,
    frame_count: count,
    frame_size: [size, size],
    view,
    output_name: outputName,
    summary: authoredClipSummary(clip, profile),
  };
  await writeText(outDir, 'manifest.json', JSON.stringify(manifest, null, 2));

  renderer.setSize(768, 768, false);
  resetVrmPose();
  setView(previewView);
  renderScene();
  setProgress(1, `Authored V3 complete: ${outputName}`);
  log(`AUTHORED V3 complete: ${outputName}, ${count} frames at ${fps} FPS.`);
  return manifest;
};
'''


def main() -> None:
    src = SRC.read_text(encoding="utf-8")
    DST.write_text(IMPORT + src + APPEND, encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    html = html.replace('<script type="module" src="app.js"></script>', '<script type="module" src="app_v3.js"></script>', 1)
    html = html.replace('<title>HellCorp Motion Studio</title>', '<title>HellCorp Motion Studio V3 - Authored</title>', 1)
    html = html.replace('<h1>HellCorp Motion Studio</h1>', '<h1>HellCorp Motion Studio V3 - Authored Animation</h1>', 1)
    INDEX_V3.write_text(html, encoding="utf-8")
    print(f"Generated {DST.relative_to(ROOT)}")
    print(f"Generated {INDEX_V3.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
