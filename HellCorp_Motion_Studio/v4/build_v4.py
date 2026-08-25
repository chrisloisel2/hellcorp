#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "app.js"
DST = ROOT / "app_v4.js"
INDEX = ROOT / "index.html"
INDEX_V4 = ROOT / "index_v4.html"

IMPORTS = "import { createOrganicGaitRuntime, organicGaitSummary } from './v4/organic_gait.js';\n"

APPEND = r'''

function organicSmooth01(t) {
  t = clamp(Number(t || 0), 0, 1);
  return t * t * (3 - 2 * t);
}

function organicWorldPosition(boneName) {
  const bone = getBone(boneName);
  if (!bone) return null;
  const out = new THREE.Vector3();
  bone.getWorldPosition(out);
  return out;
}

function organicWorldQuaternion(boneName) {
  const bone = getBone(boneName);
  if (!bone) return null;
  const out = new THREE.Quaternion();
  bone.getWorldQuaternion(out);
  return out;
}

// Rotate a bone from its CURRENT authored orientation toward a desired child
// direction. This preserves the authored twist much better than rebuilding the
// local rotation from T-pose every frame.
function organicAimBone(boneName, childName, targetWorld, blend = 1) {
  const bone = getBone(boneName);
  const child = getBone(childName);
  if (!bone || !child || !targetWorld) return false;

  currentVrm.scene.updateMatrixWorld(true);
  const bp = new THREE.Vector3();
  const cp = new THREE.Vector3();
  bone.getWorldPosition(bp);
  child.getWorldPosition(cp);
  const currentDir = cp.sub(bp).normalize();
  const desiredDir = targetWorld.clone().sub(bp).normalize();
  if (currentDir.lengthSq() < 1e-8 || desiredDir.lengthSq() < 1e-8) return false;

  const currentWorldQ = new THREE.Quaternion();
  bone.getWorldQuaternion(currentWorldQ);
  const deltaWorld = new THREE.Quaternion().setFromUnitVectors(currentDir, desiredDir);
  const desiredWorldQ = deltaWorld.multiply(currentWorldQ);
  const parentWorldQ = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentWorldQ);
  const desiredLocalQ = parentWorldQ.invert().multiply(desiredWorldQ);

  bone.quaternion.slerp(desiredLocalQ, clamp(blend, 0, 1));
  currentVrm.scene.updateMatrixWorld(true);
  return true;
}

function organicRestoreFootWorldOrientation(side, wantedWorldQ, blend) {
  const foot = getBone(`${side}Foot`);
  if (!foot || !wantedWorldQ) return;
  currentVrm.scene.updateMatrixWorld(true);
  const parentWorldQ = new THREE.Quaternion();
  foot.parent.getWorldQuaternion(parentWorldQ);
  const wantedLocal = parentWorldQ.invert().multiply(wantedWorldQ.clone());
  foot.quaternion.slerp(wantedLocal, clamp(blend, 0, 1));
  currentVrm.scene.updateMatrixWorld(true);
}

class OrganicLegGroundingV4 {
  constructor(config = {}) {
    this.config = config || {};
    this.anchors = { left: null, right: null };
  }

  reset() {
    this.anchors.left = null;
    this.anchors.right = null;
  }

  solveLeg(side, anchor, rawWeight) {
    const upperName = `${side}UpperLeg`;
    const lowerName = `${side}LowerLeg`;
    const footName = `${side}Foot`;
    const upper = getBone(upperName);
    const lower = getBone(lowerName);
    const foot = getBone(footName);
    if (!upper || !lower || !foot || !anchor) return;

    currentVrm.scene.updateMatrixWorld(true);
    const hip = organicWorldPosition(upperName);
    const knee = organicWorldPosition(lowerName);
    const ankle = organicWorldPosition(footName);
    const authoredFootWorldQ = organicWorldQuaternion(footName);
    if (!hip || !knee || !ankle) return;

    const upperLen = hip.distanceTo(knee);
    const lowerLen = knee.distanceTo(ankle);
    if (upperLen < 1e-5 || lowerLen < 1e-5) return;

    const w = organicSmooth01(Math.pow(clamp(rawWeight, 0, 1), Number(this.config.ikBlendExponent ?? 0.72)));
    if (w <= 1e-5) return;

    const horizontalLock = Number(this.config.horizontalLock ?? 0.96);
    const verticalLock = Number(this.config.verticalLock ?? 0.42);
    const target = ankle.clone();
    target.x = lerp(ankle.x, anchor.x, horizontalLock * w);
    target.z = lerp(ankle.z, anchor.z, horizontalLock * w);
    target.y = lerp(ankle.y, anchor.y, verticalLock * w);

    let toTarget = target.clone().sub(hip);
    let dist = toTarget.length();
    if (dist < 1e-6) return;
    const reachMargin = Number(this.config.maxReachMargin ?? 0.008);
    const minReach = Math.abs(upperLen - lowerLen) + reachMargin;
    const maxReach = Math.max(minReach + 1e-4, upperLen + lowerLen - reachMargin);
    dist = clamp(dist, minReach, maxReach);
    const dir = toTarget.normalize();
    const reachableTarget = hip.clone().addScaledVector(dir, dist);

    // Keep the knee on the same side of the leg plane as the authored pose.
    // This is critical for avoiding sudden backward/inverted knees.
    const hipToKnee = knee.clone().sub(hip);
    const along = hipToKnee.dot(dir);
    let pole = hipToKnee.clone().sub(dir.clone().multiplyScalar(along));
    if (pole.lengthSq() < 1e-7) {
      // Front-view fallback: bend toward the viewer while removing any component
      // parallel to the hip->ankle axis.
      pole = new THREE.Vector3(0, 0, 1);
      pole.sub(dir.clone().multiplyScalar(pole.dot(dir)));
      if (pole.lengthSq() < 1e-7) {
        pole.set(1, 0, 0);
        pole.sub(dir.clone().multiplyScalar(pole.dot(dir)));
      }
    }
    pole.normalize();

    const x = (upperLen * upperLen - lowerLen * lowerLen + dist * dist) / (2 * dist);
    const h2 = Math.max(0, upperLen * upperLen - x * x);
    const h = Math.sqrt(h2);
    const kneeTarget = hip.clone().addScaledVector(dir, x).addScaledVector(pole, h);

    organicAimBone(upperName, lowerName, kneeTarget, w);
    currentVrm.scene.updateMatrixWorld(true);
    organicAimBone(lowerName, footName, reachableTarget, w);

    // Keep the authored heel-strike / flat-foot / toe-off orientation instead of
    // letting IK make the shoe wobble as the knee solves.
    organicRestoreFootWorldOrientation(
      side,
      authoredFootWorldQ,
      Number(this.config.preserveFootOrientation ?? 0.92) * w,
    );
  }

  apply(pose) {
    if (this.config?.enabled === false || !currentVrm) return;
    const acquire = Number(this.config.acquireWeight ?? 0.10);
    const release = Number(this.config.releaseWeight ?? 0.025);

    currentVrm.scene.updateMatrixWorld(true);
    for (const side of ['left', 'right']) {
      const weight = clamp(Number(pose?.support?.[side] || 0), 0, 1);
      const footPos = organicWorldPosition(`${side}Foot`);
      if (weight >= acquire && !this.anchors[side] && footPos) {
        this.anchors[side] = footPos.clone();
      } else if (weight <= release) {
        this.anchors[side] = null;
      }
      if (this.anchors[side]) this.solveLeg(side, this.anchors[side], weight);
    }
  }
}

function applyOrganicPoseV4(pose) {
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
    setFirstExpr(['happy', 'joy'], clamp(Number(pose?.expressions?.happy || 0)));
    setFirstExpr(['relaxed'], clamp(Number(pose?.expressions?.relaxed || 0)));
    const mouthOpen = clamp(Number(pose?.expressions?.mouthOpen || 0));
    if (mouthOpen > 0) setFirstExpr(['aa', 'a'], mouthOpen);
    em.update();
  }
  currentVrm.scene.updateMatrixWorld(true);
}

window.__renderOrganicWalk = async (profile, preset, options = {}) => {
  if (!currentVrm) throw new Error('Load a VRM before V4 rendering.');

  const fps = Number(options.fps || preset?.fps || 30);
  const cycles = Math.max(1, Number(options.cycles || 1));
  const size = Math.max(64, Number(options.size || 512));
  const view = options.view || 'front';
  const outputName = safeName(options.outputName || `${profile?.name || 'character'}_${preset?.name || 'organic'}_${view}`);
  const runtime = createOrganicGaitRuntime(profile, preset, { fps });
  const count = runtime.framesPerCycle * cycles;
  const dt = 1 / fps;
  const preRollFrames = Math.max(runtime.framesPerCycle, Number(options.preRollFrames || 0));
  const grounding = new OrganicLegGroundingV4(preset?.grounding || { enabled: true });

  const root = await navigator.storage.getDirectory();
  const outDir = await childDir(root, outputName);
  const framesDir = await childDir(outDir, 'frames');
  const renderSize = Math.round(size * supersampleFor(size));

  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  setupPostFX(renderSize);
  setView(view);
  els.posterize.checked = false;

  // Full-cycle deterministic preroll: spring bones settle and support-foot
  // anchors are acquired in the exact same cyclic state as the exported loop.
  grounding.reset();
  for (let i = -preRollFrames; i < 0; i++) {
    const pose = runtime.frame(i);
    applyOrganicPoseV4(pose);
    grounding.apply(pose);
    renderScenePostFX(dt, renderSize);
  }

  for (let i = 0; i < count; i++) {
    const pose = runtime.frame(i);
    applyOrganicPoseV4(pose);
    grounding.apply(pose);
    renderScenePostFX(dt, renderSize);
    const frameCanvas = copyRenderToWork(size);
    await writeBlob(framesDir, `frame_${String(i).padStart(6, '0')}.png`, await canvasBlob(frameCanvas));
    if ((i & 1) === 0 || i === count - 1) {
      setProgress((i + 1) / count, `Organic V4 ${i + 1}/${count}`);
      await nextFrame();
    }
  }

  const manifest = {
    format: 'HellCorpOrganicRenderV1',
    character: profile?.name || stem(currentVrmFile),
    vrm: currentVrmFile?.name || null,
    preset: preset?.name || 'organic_walk',
    fps,
    duration: runtime.duration,
    frames_per_cycle: runtime.framesPerCycle,
    cycles,
    frame_count: count,
    frame_size: [size, size],
    view,
    output_name: outputName,
    grounding: preset?.grounding || null,
    summary: organicGaitSummary(profile, preset),
  };
  await writeText(outDir, 'manifest.json', JSON.stringify(manifest, null, 2));

  renderer.setSize(768, 768, false);
  grounding.reset();
  resetVrmPose();
  setView(previewView);
  renderScene();
  setProgress(1, `Organic V4 complete: ${outputName}`);
  log(`ORGANIC V4 complete: ${outputName}, ${count} frames at ${fps} FPS.`);
  return manifest;
};
'''


def main() -> None:
    src = SRC.read_text(encoding="utf-8")
    DST.write_text(IMPORTS + src + APPEND, encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    html = html.replace('<script type="module" src="app.js"></script>', '<script type="module" src="app_v4.js"></script>', 1)
    html = html.replace('<title>HellCorp Motion Studio</title>', '<title>HellCorp Motion Studio V4 - Organic Gait</title>', 1)
    html = html.replace('<h1>HellCorp Motion Studio</h1>', '<h1>HellCorp Motion Studio V4 - Organic Gait</h1>', 1)
    INDEX_V4.write_text(html, encoding="utf-8")
    print(f"Generated {DST.relative_to(ROOT)}")
    print(f"Generated {INDEX_V4.relative_to(ROOT)}")


if __name__ == '__main__':
    main()
