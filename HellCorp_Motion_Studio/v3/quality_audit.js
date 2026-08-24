// Deterministic numerical audit for authored animation loops.
// It catches the defects that are hard to see from a single still: loop seams,
// frozen sections, excessive per-frame rotation and high angular jerk.

function abs(v) { return Math.abs(Number(v || 0)); }
function delta(a, b) { return Number(b || 0) - Number(a || 0); }
function boneAxis(frame, bone, axis) { return Number(frame?.bones?.[bone]?.[axis] || 0); }

const DEFAULT_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot',
];

export function auditAuthoredRuntime(runtime, options = {}) {
  const bones = options.bones || DEFAULT_BONES;
  const frames = [];
  for (let i = 0; i < runtime.framesPerCycle; i++) frames.push(runtime.frame(i));
  if (frames.length < 2) return { frameCount: frames.length, ok: true };

  let maxAngularStep = 0;
  let maxAngularAccel = 0;
  let maxAngularJerk = 0;
  let nearlyFrozenPairs = 0;
  let totalPairs = 0;
  const perBone = {};

  for (const bone of bones) {
    let boneMaxStep = 0;
    let boneMaxAccel = 0;
    const velocity = [];
    for (let i = 0; i < frames.length; i++) {
      const j = (i + 1) % frames.length;
      let magnitude = 0;
      for (const axis of ['x', 'y', 'z']) {
        const d = delta(boneAxis(frames[i], bone, axis), boneAxis(frames[j], bone, axis));
        magnitude += d * d;
      }
      magnitude = Math.sqrt(magnitude);
      velocity.push(magnitude);
      boneMaxStep = Math.max(boneMaxStep, magnitude);
      maxAngularStep = Math.max(maxAngularStep, magnitude);
      totalPairs++;
      if (magnitude < 1e-5) nearlyFrozenPairs++;
    }
    const accel = [];
    for (let i = 0; i < velocity.length; i++) {
      const a = velocity[(i + 1) % velocity.length] - velocity[i];
      accel.push(a);
      boneMaxAccel = Math.max(boneMaxAccel, abs(a));
      maxAngularAccel = Math.max(maxAngularAccel, abs(a));
    }
    for (let i = 0; i < accel.length; i++) {
      const jerk = accel[(i + 1) % accel.length] - accel[i];
      maxAngularJerk = Math.max(maxAngularJerk, abs(jerk));
    }
    perBone[bone] = { maxAngularStep: boneMaxStep, maxAngularAccel: boneMaxAccel };
  }

  const first = frames[0];
  const last = frames[frames.length - 1];
  const rootLoopDelta = Math.hypot(
    delta(last?.root?.x, first?.root?.x),
    delta(last?.root?.y, first?.root?.y),
    delta(last?.root?.z, first?.root?.z),
  );
  let boneLoopDelta = 0;
  for (const bone of bones) {
    for (const axis of ['x', 'y', 'z']) {
      boneLoopDelta = Math.max(boneLoopDelta, abs(delta(boneAxis(last, bone, axis), boneAxis(first, bone, axis))));
    }
  }

  const frozenRatio = totalPairs ? nearlyFrozenPairs / totalPairs : 0;
  const warnings = [];
  if (boneLoopDelta > 0.12) warnings.push(`large bone loop seam: ${boneLoopDelta.toFixed(4)} rad`);
  if (rootLoopDelta > 0.035) warnings.push(`large root loop seam: ${rootLoopDelta.toFixed(4)}`);
  if (maxAngularStep > 0.22) warnings.push(`large per-frame angular step: ${maxAngularStep.toFixed(4)} rad`);
  if (maxAngularJerk > 0.16) warnings.push(`high angular jerk: ${maxAngularJerk.toFixed(4)}`);
  if (frozenRatio > 0.35) warnings.push(`too many frozen bone/frame pairs: ${(frozenRatio * 100).toFixed(1)}%`);

  return {
    frameCount: frames.length,
    fps: runtime.fps,
    maxAngularStep,
    maxAngularAccel,
    maxAngularJerk,
    rootLoopDelta,
    boneLoopDelta,
    frozenRatio,
    warnings,
    ok: warnings.length === 0,
    perBone,
  };
}
