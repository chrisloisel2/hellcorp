#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "app.js"
DST = ROOT / "app_v3.js"
INDEX = ROOT / "index.html"
INDEX_V3 = ROOT / "index_v3.html"

IMPORTS = (
    "import { createAuthoredRuntime, authoredClipSummary } from './v3/authored_animation.js';\n"
    "import { auditAuthoredRuntime } from './v3/quality_audit.js';\n"
)

APPEND = r'''

function authoredWrap01(v) {
  return ((Number(v || 0) % 1) + 1) % 1;
}

function authoredSmoothstep(t) {
  t = clamp(Number(t || 0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Cyclic support interval. start > end means the interval crosses phase 1 -> 0.
function authoredSupportWeight(phase, interval, fade = 0.06) {
  if (!Array.isArray(interval) || interval.length < 2) return 0;
  const start = authoredWrap01(interval[0]);
  const end = authoredWrap01(interval[1]);
  const p = authoredWrap01(phase);
  let span = authoredWrap01(end - start);
  if (span < 1e-6) span = 1;
  const d = authoredWrap01(p - start);
  if (d > span) return 0;
  const f = Math.max(1e-4, Math.min(Number(fade || 0.06), span * 0.45));
  const enter = authoredSmoothstep(d / f);
  const leave = authoredSmoothstep((span - d) / f);
  return Math.min(enter, leave);
}

function authoredIntervalsWeight(phase, intervals, fade) {
  let w = 0;
  for (const interval of intervals || []) {
    w = Math.max(w, authoredSupportWeight(phase, interval, fade));
  }
  return w;
}

function authoredWorldPosition(boneName) {
  const bone = getBone(boneName);
  if (!bone) return null;
  const p = new THREE.Vector3();
  bone.getWorldPosition(p);
  return p;
}

class AuthoredFootLockV3 {
  constructor(config = {}) {
    this.config = config || {};
    this.anchors = { left: null, right: null };
  }

  reset() {
    this.anchors.left = null;
    this.anchors.right = null;
  }

  weight(side, phase) {
    const intervals = this.config?.[side]?.support || [];
    return authoredIntervalsWeight(phase, intervals, Number(this.config.fade ?? 0.055));
  }

  apply(phase) {
    if (this.config?.enabled === false || !currentVrm) return;

    currentVrm.scene.updateMatrixWorld(true);
    const samples = [];

    for (const side of ['left', 'right']) {
      const weight = this.weight(side, phase);
      const boneName = this.config?.[side]?.bone || `${side}Foot`;
      const pos = authoredWorldPosition(boneName);

      if (weight > 0.02 && !this.anchors[side] && pos) this.anchors[side] = pos.clone();
      if (weight <= 0.002) this.anchors[side] = null;

      if (weight > 0 && pos && this.anchors[side]) {
        samples.push({ weight, delta: this.anchors[side].clone().sub(pos) });
      }
    }

    if (!samples.length) return;

    let total = 0;
    const correction = new THREE.Vector3();
    for (const sample of samples) {
      correction.addScaledVector(sample.delta, sample.weight);
      total += sample.weight;
    }
    if (total > 1e-6) correction.multiplyScalar(1 / total);

    const xzStrength = Number(this.config.xzStrength ?? 0.98);
    const yStrength = Number(this.config.yStrength ?? 0.80);
    const maxCorrection = Number(this.config.maxCorrection ?? 0.14);

    correction.x = clamp(correction.x * xzStrength, -maxCorrection, maxCorrection);
    correction.y = clamp(correction.y * yStrength, -maxCorrection, maxCorrection);
    correction.z = clamp(correction.z * xzStrength, -maxCorrection, maxCorrection);

    // The authored pelvis/root may move freely, but the support ankle is kept
    // in world space. This removes the marionette/string effect without
    // freezing the swing leg or removing the organic pelvis motion.
    currentVrm.scene.position.add(correction);
    currentVrm.scene.updateMatrixWorld(true);
  }
}

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

  if (pose?.eyes) {
    const x = Number(pose.eyes.x || 0);
    const y = Number(pose.eyes.y || 0);
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

  currentVrm.scene.updateMatrixWorld(true);
}

window.__renderAuthoredClip = async (clip, profile, options = {}) => {
  if (!currentVrm) throw new Error('Load a VRM before authored rendering.');

  const fps = Number(options.fps || clip?.fps || 30);
  const cycles = Math.max(1, Number(options.cycles || 1));
  const size = Math.max(64, Number(options.size || 512));
  const view = options.view || 'front';
  const outputName = safeName(options.outputName || `${profile?.name || 'character'}_${clip?.name || 'clip'}_${view}`);
  const preRollFrames = Math.max(0, Number(options.preRollFrames ?? 18));
  const runtime = createAuthoredRuntime(clip, profile, { fps });
  const audit = auditAuthoredRuntime(runtime);
  const count = runtime.framesPerCycle * cycles;
  const dt = 1 / fps;
  const layers = { ...(profile?.layers || {}), ...(clip?.layers || {}) };
  const footLock = new AuthoredFootLockV3(layers.footLock || { enabled: false });

  if (audit.warnings?.length) log(`AUTHORED V3 audit warnings: ${audit.warnings.join(' | ')}`);
  else log(`AUTHORED V3 audit OK: seam=${audit.boneLoopDelta.toFixed(4)}, maxStep=${audit.maxAngularStep.toFixed(4)} rad.`);

  const root = await navigator.storage.getDirectory();
  const outDir = await childDir(root, outputName);
  const framesDir = await childDir(outDir, 'frames');
  const renderSize = Math.round(size * supersampleFor(size));

  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  setupPostFX(renderSize);
  setView(view);
  els.posterize.checked = false;

  // Deterministic preroll settles spring bones and also acquires the support
  // foot anchor before exported frame zero.
  footLock.reset();
  for (let i = -preRollFrames; i < 0; i++) {
    const pose = runtime.frame(i);
    applyAuthoredPoseV3(pose);
    footLock.apply(pose.phase);
    renderScenePostFX(dt, renderSize);
  }

  for (let i = 0; i < count; i++) {
    const pose = runtime.frame(i);
    applyAuthoredPoseV3(pose);
    footLock.apply(pose.phase);
    renderScenePostFX(dt, renderSize);
    const frameCanvas = copyRenderToWork(size);
    await writeBlob(framesDir, `frame_${String(i).padStart(6, '0')}.png`, await canvasBlob(frameCanvas));
    if ((i & 1) === 0 || i === count - 1) {
      setProgress((i + 1) / count, `Authored V3 ${i + 1}/${count}`);
      await nextFrame();
    }
  }

  const manifest = {
    format: 'HellCorpAuthoredRenderV2',
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
    foot_lock: layers.footLock || null,
    summary: authoredClipSummary(clip, profile),
    quality_audit: audit,
  };
  await writeText(outDir, 'manifest.json', JSON.stringify(manifest, null, 2));

  renderer.setSize(768, 768, false);
  footLock.reset();
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
    DST.write_text(IMPORTS + src + APPEND, encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    html = html.replace('<script type="module" src="app.js"></script>', '<script type="module" src="app_v3.js"></script>', 1)
    html = html.replace('<title>HellCorp Motion Studio</title>', '<title>HellCorp Motion Studio V3 - Authored</title>', 1)
    html = html.replace('<h1>HellCorp Motion Studio</h1>', '<h1>HellCorp Motion Studio V3 - Authored Animation</h1>', 1)
    INDEX_V3.write_text(html, encoding="utf-8")
    print(f"Generated {DST.relative_to(ROOT)}")
    print(f"Generated {INDEX_V3.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
