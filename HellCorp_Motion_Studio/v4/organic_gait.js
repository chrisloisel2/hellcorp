// HellCorp Motion Studio V4 - organic procedural gait runtime.
//
// Goal: produce a convincing character-performance walk, not a literal mocap
// reconstruction. The runtime is deterministic and works entirely in normalized
// VRM humanoid bone space. Grounding is handled later by the V4 two-bone IK pass.

const TAU = Math.PI * 2;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function wrap01(v) { return ((v % 1) + 1) % 1; }
function smooth01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function smoother01(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function hash32(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = Math.imul(n, 9);
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return n >>> 0;
}
function hash01(seed, n) {
  return hash32((seed | 0) ^ Math.imul((n | 0) + 1, 0x9e3779b1)) / 0xffffffff;
}
function signedNoise(seed, n) { return hash01(seed, n) * 2 - 1; }

function catmull(p0, p1, p2, p3, t, tension = 0.5) {
  const t2 = t * t;
  const t3 = t2 * t;
  const m1 = (p2 - p0) * tension;
  const m2 = (p3 - p1) * tension;
  return (2 * t3 - 3 * t2 + 1) * p1
    + (t3 - 2 * t2 + t) * m1
    + (-2 * t3 + 3 * t2) * p2
    + (t3 - t2) * m2;
}

function sampleCyclic(keys, phase, tension = 0.48) {
  if (!keys?.length) return 0;
  if (keys.length === 1) return Number(keys[0][1] || 0);
  const arr = keys.slice().sort((a, b) => a[0] - b[0]);
  const p = wrap01(phase);
  let i1 = arr.length - 1;
  let i2 = 0;
  let u = 0;
  for (let i = 0; i < arr.length; i++) {
    const j = (i + 1) % arr.length;
    const t1 = arr[i][0];
    const t2 = j === 0 ? arr[0][0] + 1 : arr[j][0];
    const pp = p < t1 ? p + 1 : p;
    if (pp >= t1 && pp <= t2 + 1e-9) {
      i1 = i;
      i2 = j;
      u = (pp - t1) / Math.max(1e-8, t2 - t1);
      break;
    }
  }
  const i0 = (i1 - 1 + arr.length) % arr.length;
  const i3 = (i2 + 1) % arr.length;
  return catmull(arr[i0][1], arr[i1][1], arr[i2][1], arr[i3][1], u, tension);
}

function gaussianPhase(phase, center, width) {
  let d = Math.abs(wrap01(phase) - wrap01(center));
  d = Math.min(d, 1 - d);
  const s = Math.max(1e-5, width);
  return Math.exp(-(d * d) / (2 * s * s));
}

// A leg is in stance from heel strike (phase 0) until toe-off (~0.60).
// The soft envelope is used both for weight transfer and renderer-side IK.
function stanceWeight(stepPhase, stanceEnd = 0.60, enter = 0.055, leave = 0.075) {
  const p = wrap01(stepPhase);
  if (p > stanceEnd) return 0;
  const a = smooth01(p / Math.max(enter, 1e-5));
  const b = smooth01((stanceEnd - p) / Math.max(leave, 1e-5));
  return Math.min(a, b);
}

function ensureBone(bones, name) {
  if (!bones[name]) bones[name] = { x: 0, y: 0, z: 0, rotationOrder: 'XYZ' };
  return bones[name];
}

function initializeState(profile) {
  const state = {
    root: { x: 0, y: 0, z: 0 },
    bones: {},
    expressions: { blink: 0, happy: 0, relaxed: 0, mouthOpen: 0 },
    eyes: { x: 0, y: 0 },
    support: { left: 0, right: 0 },
  };
  for (const [name, r] of Object.entries(profile?.basePose || {})) {
    state.bones[name] = {
      x: Number(r.x || 0), y: Number(r.y || 0), z: Number(r.z || 0),
      rotationOrder: r.rotationOrder || 'XYZ',
    };
  }
  const root = profile?.baseRoot || {};
  state.root.x = Number(root.x || 0);
  state.root.y = Number(root.y || 0);
  state.root.z = Number(root.z || 0);
  return state;
}

function mergeConfig(profile, preset) {
  return {
    ...(profile?.gait || {}),
    ...(preset?.gait || {}),
    pelvis: { ...(profile?.gait?.pelvis || {}), ...(preset?.gait?.pelvis || {}) },
    torso: { ...(profile?.gait?.torso || {}), ...(preset?.gait?.torso || {}) },
    legs: { ...(profile?.gait?.legs || {}), ...(preset?.gait?.legs || {}) },
    arms: { ...(profile?.gait?.arms || {}), ...(preset?.gait?.arms || {}) },
    head: { ...(profile?.gait?.head || {}), ...(preset?.gait?.head || {}) },
    face: { ...(profile?.gait?.face || {}), ...(preset?.gait?.face || {}) },
  };
}

function warpedPhase(phase, cfg) {
  // Small periodic time warp: loading response is a little faster than the
  // float phase, while passing/up phases breathe slightly longer. This removes
  // the metronomic quality of a pure sine walk without breaking loop closure.
  const amount = Number(cfg.timeWarp ?? 0.014);
  const skew = Number(cfg.timeWarpSkew ?? -0.28);
  return wrap01(phase + amount * Math.sin(TAU * 2 * phase + skew));
}

function legPose(stepPhase, cfg, sideScale = 1) {
  const s = wrap01(stepPhase);
  const hipAmp = Number(cfg.hipSwing ?? 1.0) * sideScale;
  const kneeAmp = Number(cfg.kneeSwing ?? 1.0) * sideScale;
  const footAmp = Number(cfg.footRoll ?? 1.0) * sideScale;

  // One complete stride for one leg. Values are radians and intentionally use
  // asymmetric stance/swing timing rather than a sinusoid.
  const hip = sampleCyclic([
    [0.00, 0.295], [0.10, 0.215], [0.24, 0.055], [0.39, -0.155],
    [0.54, -0.305], [0.62, -0.340], [0.73, -0.120], [0.84, 0.155], [0.94, 0.315],
  ], s, 0.42) * hipAmp;

  const knee = sampleCyclic([
    [0.00, 0.095], [0.09, 0.205], [0.20, 0.115], [0.38, 0.055],
    [0.52, 0.125], [0.62, 0.610], [0.72, 0.790], [0.82, 0.520], [0.92, 0.205],
  ], s, 0.40) * kneeAmp;

  const foot = sampleCyclic([
    [0.00, -0.125], [0.08, -0.015], [0.21, 0.050], [0.40, 0.095],
    [0.52, 0.245], [0.60, 0.320], [0.70, 0.040], [0.82, -0.095], [0.94, -0.155],
  ], s, 0.42) * footAmp;

  // Catwalk-like adduction stays small. It closes the stance without making
  // the knees cross through each other.
  const adduction = sampleCyclic([
    [0.00, -0.010], [0.18, -0.016], [0.45, 0.002], [0.65, 0.010], [0.86, -0.004],
  ], s, 0.44) * Number(cfg.adduction ?? 1.0) * sideScale;

  return { hip, knee, foot, adduction, stance: stanceWeight(s, Number(cfg.stanceEnd ?? 0.60)) };
}

function applyLegs(state, phase, cfg) {
  const asym = Number(cfg.asymmetry ?? 0.035);
  const left = legPose(phase, cfg, 1 + asym);
  const right = legPose(phase + 0.5, cfg, 1 - asym * 0.7);

  const lu = ensureBone(state.bones, 'leftUpperLeg');
  const ru = ensureBone(state.bones, 'rightUpperLeg');
  const ll = ensureBone(state.bones, 'leftLowerLeg');
  const rl = ensureBone(state.bones, 'rightLowerLeg');
  const lf = ensureBone(state.bones, 'leftFoot');
  const rf = ensureBone(state.bones, 'rightFoot');

  lu.x += left.hip;
  ru.x += right.hip;
  ll.x += left.knee;
  rl.x += right.knee;
  lf.x += left.foot;
  rf.x += right.foot;
  lu.z += left.adduction;
  ru.z -= right.adduction;

  state.support.left = left.stance;
  state.support.right = right.stance;
  return { left, right };
}

function applyWeightAndPelvis(state, phase, cfg, legs) {
  const p = TAU * phase;
  const pelvis = ensureBone(state.bones, 'hips');

  const leftW = legs.left.stance;
  const rightW = legs.right.stance;
  const sum = leftW + rightW;
  const balance = sum > 1e-5 ? (rightW - leftW) / sum : Math.sin(p);

  // COM travels toward the stance leg, but only a few millimetres. The old V3
  // moved the whole avatar by centimetres, which read as suspension from a wire.
  state.root.x += balance * Number(cfg.shiftX ?? 0.0042);

  // Human walking has two vertical peaks per stride. Lowest points are near
  // double-support/heel strike; mid-stance rises as the support leg straightens.
  const vertical = -Math.cos(p * 2) * Number(cfg.bobY ?? 0.0060)
    + Math.cos(p * 4 + 0.45) * Number(cfg.bobSecondary ?? 0.0010);
  state.root.y += vertical;

  // Pelvis motion is coupled to weight transfer instead of being a free pendulum.
  pelvis.z += balance * Number(cfg.roll ?? 0.032);
  pelvis.y += Math.cos(p) * Number(cfg.yaw ?? 0.026);
  pelvis.x += (-Math.cos(p * 2)) * Number(cfg.pitch ?? 0.0075);

  return { balance, vertical };
}

function applyTorso(state, phase, cfg, pelvisInfo) {
  const p = TAU * phase;
  const spine = ensureBone(state.bones, 'spine');
  const chest = ensureBone(state.bones, 'chest');
  const upperChest = ensureBone(state.bones, 'upperChest');
  const lShoulder = ensureBone(state.bones, 'leftShoulder');
  const rShoulder = ensureBone(state.bones, 'rightShoulder');

  const counterYaw = -Math.cos(p + Number(cfg.phaseLag ?? 0.16)) * Number(cfg.counterYaw ?? 0.020);
  const counterRoll = -pelvisInfo.balance * Number(cfg.counterRoll ?? 0.012);

  spine.y += counterYaw * 0.55;
  chest.y += counterYaw;
  upperChest.y += counterYaw * 0.35;
  spine.z += counterRoll * 0.55;
  chest.z += counterRoll;

  // Shoulders travel in opposition to the pelvis and are deliberately delayed.
  const shoulderSwing = -Math.cos(p + 0.18) * Number(cfg.shoulderYaw ?? 0.014);
  lShoulder.y += shoulderSwing;
  rShoulder.y += shoulderSwing;
  lShoulder.z += -pelvisInfo.balance * Number(cfg.shoulderRoll ?? 0.006);
  rShoulder.z += -pelvisInfo.balance * Number(cfg.shoulderRoll ?? 0.006);
}

function applyArms(state, phase, cfg) {
  const p = TAU * phase;
  const amp = Number(cfg.swing ?? 0.115);
  const asym = Number(cfg.asymmetry ?? 0.055);
  const lag = Number(cfg.lag ?? 0.10);
  const swing = Math.cos(p - lag);

  const lua = ensureBone(state.bones, 'leftUpperArm');
  const rua = ensureBone(state.bones, 'rightUpperArm');
  const lla = ensureBone(state.bones, 'leftLowerArm');
  const rla = ensureBone(state.bones, 'rightLowerArm');
  const lh = ensureBone(state.bones, 'leftHand');
  const rh = ensureBone(state.bones, 'rightHand');

  // Opposite arm to forward leg. The upper arms remain hanging down because the
  // profile owns the large Z-axis down rotation; gait only adds modest X swing.
  lua.x += -swing * amp * (1 + asym);
  rua.x += swing * amp * (1 - asym * 0.6);

  // Elbows flex more when the corresponding arm swings forward and relax back.
  const lForward = clamp((swing + 1) * 0.5, 0, 1);
  const rForward = clamp((-swing + 1) * 0.5, 0, 1);
  lla.x += -Number(cfg.elbowFlex ?? 0.040) * (0.35 + lForward * 0.65);
  rla.x += -Number(cfg.elbowFlex ?? 0.040) * (0.35 + rForward * 0.65);

  const handLag = p - lag - 0.30;
  lh.x += -Math.cos(handLag) * Number(cfg.handLag ?? 0.018);
  rh.x += Math.cos(handLag) * Number(cfg.handLag ?? 0.018);
  lh.z += Math.sin(p * 0.5 + 0.3) * Number(cfg.handRoll ?? 0.007);
  rh.z += Math.sin(p * 0.5 + 2.7) * Number(cfg.handRoll ?? 0.007);
}

function applyBreathing(state, phase, cfg) {
  const p = TAU * (phase * Number(cfg.cycles ?? 0.5) + Number(cfg.phase ?? 0.13));
  const breath = Math.sin(p);
  ensureBone(state.bones, 'chest').x += breath * Number(cfg.chestPitch ?? 0.0060);
  ensureBone(state.bones, 'spine').x += breath * Number(cfg.spinePitch ?? 0.0030);
  state.root.y += breath * Number(cfg.rootLift ?? 0.0012);
}

function applyHead(state, phase, cfg, pelvisInfo, seed) {
  const p = TAU * phase;
  const head = ensureBone(state.bones, 'head');
  const neck = ensureBone(state.bones, 'neck');
  const chest = ensureBone(state.bones, 'chest');
  const hips = ensureBone(state.bones, 'hips');

  // Vestibular-style counter-motion. It cancels most body wobble, but not all:
  // a perfectly fixed head also reads synthetic.
  head.z -= (hips.z * 0.38 + chest.z * 0.48) * Number(cfg.rollStabilization ?? 0.72);
  head.y -= (hips.y * 0.30 + chest.y * 0.50) * Number(cfg.yawStabilization ?? 0.62);
  neck.z -= chest.z * Number(cfg.neckCounter ?? 0.18);

  const n1 = signedNoise(seed, 31);
  const n2 = signedNoise(seed, 67);
  head.y += Math.sin(p * 0.5 + n1) * Number(cfg.microYaw ?? 0.0022);
  head.z += Math.sin(p * 0.75 + n2) * Number(cfg.microRoll ?? 0.0016);
  head.x += Math.sin(p * 0.5 + 1.2) * Number(cfg.microPitch ?? 0.0015);
  void pelvisInfo;
}

function blinkValue(phase, times, width) {
  let v = 0;
  for (const t of times || []) v = Math.max(v, gaussianPhase(phase, Number(t), width));
  return clamp(Math.pow(v, 0.68), 0, 1);
}

function sampleEyeTargets(phase, targets) {
  if (!targets?.length) return { x: 0, y: 0 };
  const arr = targets.slice().sort((a, b) => a.t - b.t);
  let current = arr[arr.length - 1];
  let next = arr[0];
  for (let i = 0; i < arr.length; i++) {
    if (phase >= arr[i].t) current = arr[i];
    if (arr[i].t > phase) { next = arr[i]; break; }
  }
  const t1 = Number(current.t || 0);
  let t2 = Number(next.t || 0);
  let pp = phase;
  if (t2 <= t1) t2 += 1;
  if (pp < t1) pp += 1;
  const raw = clamp((pp - t1) / Math.max(1e-6, t2 - t1), 0, 1);
  // Eyes hold, then make a short smooth saccade.
  const u = raw < 0.82 ? 0 : smoother01((raw - 0.82) / 0.18);
  return {
    x: lerp(Number(current.x || 0), Number(next.x || 0), u),
    y: lerp(Number(current.y || 0), Number(next.y || 0), u),
  };
}

function applyFace(state, phase, cfg, profile, preset) {
  const times = preset?.blinkTimes || profile?.blinkTimes || [0.28, 0.78];
  state.expressions.blink = blinkValue(phase, times, Number(cfg.blinkWidth ?? 0.024));
  state.expressions.happy = clamp(Number(preset?.expressions?.happy ?? profile?.expressions?.happy ?? 0.08), 0, 1);
  state.expressions.relaxed = clamp(Number(preset?.expressions?.relaxed ?? profile?.expressions?.relaxed ?? 0.14), 0, 1);
  state.expressions.mouthOpen = clamp(Number(preset?.expressions?.mouthOpen ?? 0), 0, 1);
  state.eyes = sampleEyeTargets(phase, preset?.eyeTargets || profile?.eyeTargets || [{ t: 0, x: 0, y: 0 }]);
}

function applyAsymmetry(state, profile) {
  for (const [path, value] of Object.entries(profile?.asymmetry || {})) {
    const parts = path.split('.');
    const bone = ensureBone(state.bones, parts[0]);
    const axis = parts[parts.length - 1];
    if (axis in bone) bone[axis] += Number(value || 0);
  }
}

function evaluateFrame(profile, preset, phase, frameIndex, fps) {
  const state = initializeState(profile);
  const cfg = mergeConfig(profile, preset);
  const seed = Number(preset?.seed ?? profile?.seed ?? 1707);
  const gaitPhase = warpedPhase(phase, cfg);

  const legs = applyLegs(state, gaitPhase, cfg.legs);
  const pelvisInfo = applyWeightAndPelvis(state, gaitPhase, cfg.pelvis, legs);
  applyTorso(state, gaitPhase, cfg.torso, pelvisInfo);
  applyArms(state, gaitPhase, cfg.arms);
  applyBreathing(state, phase, cfg.breathing || {});
  applyHead(state, gaitPhase, cfg.head, pelvisInfo, seed);
  applyAsymmetry(state, profile);
  applyFace(state, phase, cfg.face, profile, preset);

  return {
    phase: wrap01(phase),
    gaitPhase,
    frameIndex,
    fps,
    root: state.root,
    bones: state.bones,
    expressions: state.expressions,
    eyes: state.eyes,
    support: state.support,
  };
}

export function createOrganicGaitRuntime(profile, preset, options = {}) {
  const fps = Number(options.fps || preset?.fps || 30);
  const duration = Number(preset?.duration || 1.40);
  const framesPerCycle = Math.max(8, Math.round(duration * fps));
  return {
    fps,
    duration,
    framesPerCycle,
    frame(index) {
      const phase = wrap01(index / framesPerCycle);
      return evaluateFrame(profile, preset, phase, index, fps);
    },
  };
}

export function organicGaitSummary(profile, preset) {
  return {
    format: 'HellCorpOrganicGaitV1',
    character: profile?.name || 'character',
    preset: preset?.name || 'organic_walk',
    fps: Number(preset?.fps || 30),
    duration: Number(preset?.duration || 1.40),
    deterministic: true,
    grounding: 'two-bone support-leg IK in renderer',
  };
}
