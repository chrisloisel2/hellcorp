// HellCorp Motion Studio V4.1 - organic procedural gait runtime.
//
// V4.1 focuses on de-rigidifying the whole body: phased spine/chest motion,
// scapular movement, delayed elbow/wrist response, relaxed fingers, load/release
// timing and deliberate left/right asymmetry. The runtime is deterministic.

const TAU = Math.PI * 2;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function wrap01(v) { return ((v % 1) + 1) % 1; }
function smooth01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function smoother01(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }

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

function stanceWeight(stepPhase, stanceEnd = 0.60, enter = 0.075, leave = 0.095) {
  const p = wrap01(stepPhase);
  if (p > stanceEnd) return 0;
  const a = smoother01(p / Math.max(enter, 1e-5));
  const b = smoother01((stanceEnd - p) / Math.max(leave, 1e-5));
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
    hands: { ...(profile?.gait?.hands || {}), ...(preset?.gait?.hands || {}) },
    breathing: { ...(profile?.gait?.breathing || {}), ...(preset?.gait?.breathing || {}) },
    head: { ...(profile?.gait?.head || {}), ...(preset?.gait?.head || {}) },
    face: { ...(profile?.gait?.face || {}), ...(preset?.gait?.face || {}) },
  };
}

function warpedPhase(phase, cfg) {
  const amount = Number(cfg.timeWarp ?? 0.012);
  const skew = Number(cfg.timeWarpSkew ?? -0.24);
  const primary = Math.sin(TAU * 2 * phase + skew) * amount;
  const secondary = Math.sin(TAU * 4 * phase + 0.55) * amount * 0.22;
  return wrap01(phase + primary + secondary);
}

function legPose(stepPhase, cfg, sideScale = 1) {
  const s = wrap01(stepPhase);
  const hipAmp = Number(cfg.hipSwing ?? 1.0) * sideScale;
  const kneeAmp = Number(cfg.kneeSwing ?? 1.0) * sideScale;
  const footAmp = Number(cfg.footRoll ?? 1.0) * sideScale;

  const hip = sampleCyclic([
    [0.00, 0.285], [0.09, 0.220], [0.22, 0.075], [0.38, -0.145],
    [0.53, -0.285], [0.61, -0.325], [0.72, -0.145], [0.83, 0.120], [0.94, 0.300],
  ], s, 0.40) * hipAmp;

  const knee = sampleCyclic([
    [0.00, 0.110], [0.08, 0.225], [0.20, 0.130], [0.37, 0.060],
    [0.50, 0.115], [0.61, 0.545], [0.71, 0.735], [0.82, 0.470], [0.93, 0.205],
  ], s, 0.38) * kneeAmp;

  const foot = sampleCyclic([
    [0.00, -0.115], [0.08, -0.020], [0.20, 0.035], [0.39, 0.080],
    [0.51, 0.210], [0.60, 0.285], [0.70, 0.035], [0.82, -0.080], [0.94, -0.145],
  ], s, 0.40) * footAmp;

  const adduction = sampleCyclic([
    [0.00, -0.008], [0.18, -0.013], [0.45, 0.002], [0.66, 0.008], [0.86, -0.003],
  ], s, 0.42) * Number(cfg.adduction ?? 1.0) * sideScale;

  const toe = sampleCyclic([
    [0.00, 0.00], [0.34, 0.00], [0.50, 0.035], [0.60, 0.120],
    [0.68, 0.055], [0.80, 0.00], [0.94, 0.00],
  ], s, 0.40) * Number(cfg.toeRoll ?? 1.0);

  return {
    hip, knee, foot, adduction, toe,
    stance: stanceWeight(
      s,
      Number(cfg.stanceEnd ?? 0.60),
      Number(cfg.stanceEnter ?? 0.075),
      Number(cfg.stanceLeave ?? 0.095),
    ),
  };
}

function applyLegs(state, phase, cfg) {
  const asym = Number(cfg.asymmetry ?? 0.025);
  const left = legPose(phase, cfg, 1 + asym);
  const right = legPose(phase + 0.5, cfg, 1 - asym * 0.65);

  const lu = ensureBone(state.bones, 'leftUpperLeg');
  const ru = ensureBone(state.bones, 'rightUpperLeg');
  const ll = ensureBone(state.bones, 'leftLowerLeg');
  const rl = ensureBone(state.bones, 'rightLowerLeg');
  const lf = ensureBone(state.bones, 'leftFoot');
  const rf = ensureBone(state.bones, 'rightFoot');
  const lt = ensureBone(state.bones, 'leftToes');
  const rt = ensureBone(state.bones, 'rightToes');

  lu.x += left.hip;
  ru.x += right.hip;
  ll.x += left.knee;
  rl.x += right.knee;
  lf.x += left.foot;
  rf.x += right.foot;
  lt.x += left.toe;
  rt.x += right.toe;
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
  const rawBalance = sum > 1e-5 ? (rightW - leftW) / sum : Math.sin(p);
  const balance = Math.tanh(rawBalance * Number(cfg.balanceSoftness ?? 1.25));

  state.root.x += balance * Number(cfg.shiftX ?? 0.0030);
  const vertical = -Math.cos(p * 2) * Number(cfg.bobY ?? 0.0062)
    + Math.cos(p * 4 + 0.42) * Number(cfg.bobSecondary ?? 0.0012);
  state.root.y += vertical;

  const loadLeft = gaussianPhase(phase, 0.02, Number(cfg.loadWidth ?? 0.075));
  const loadRight = gaussianPhase(phase, 0.52, Number(cfg.loadWidth ?? 0.075));
  const load = loadLeft + loadRight;

  pelvis.z += balance * Number(cfg.roll ?? 0.038);
  pelvis.y += Math.cos(p + Number(cfg.yawPhase ?? 0.02)) * Number(cfg.yaw ?? 0.029);
  pelvis.x += (-Math.cos(p * 2 + 0.10)) * Number(cfg.pitch ?? 0.0090)
    + load * Number(cfg.loadPitch ?? 0.0040);

  return { balance, vertical, load, leftW, rightW };
}

function applyTorso(state, phase, cfg, pelvisInfo) {
  const p = TAU * phase;
  const spine = ensureBone(state.bones, 'spine');
  const chest = ensureBone(state.bones, 'chest');
  const upperChest = ensureBone(state.bones, 'upperChest');
  const lShoulder = ensureBone(state.bones, 'leftShoulder');
  const rShoulder = ensureBone(state.bones, 'rightShoulder');

  const lag = Number(cfg.phaseLag ?? 0.18);
  const counterYaw = Number(cfg.counterYaw ?? 0.026);
  const counterRoll = Number(cfg.counterRoll ?? 0.018);
  const pitchWave = Number(cfg.pitchWave ?? 0.012);
  const lateralFlex = Number(cfg.lateralFlex ?? 0.010);

  spine.y += -Math.cos(p + lag * 0.45) * counterYaw * 0.42;
  chest.y += -Math.cos(p + lag * 0.95) * counterYaw * 0.78;
  upperChest.y += -Math.cos(p + lag * 1.35) * counterYaw * 0.48;

  spine.z += -pelvisInfo.balance * counterRoll * 0.34
    + Math.sin(p * 2 + 0.55) * lateralFlex * 0.25;
  chest.z += -pelvisInfo.balance * counterRoll * 0.72
    + Math.sin(p * 2 + 0.78) * lateralFlex * 0.50;
  upperChest.z += -pelvisInfo.balance * counterRoll * 0.46
    + Math.sin(p * 2 + 0.96) * lateralFlex * 0.38;

  spine.x += Math.cos(p * 2 + 0.28) * pitchWave * 0.30
    - pelvisInfo.load * Number(cfg.loadAbsorb ?? 0.0040);
  chest.x += Math.cos(p * 2 + 0.54) * pitchWave * 0.58
    + pelvisInfo.load * Number(cfg.chestRecoil ?? 0.0035);
  upperChest.x += Math.cos(p * 2 + 0.80) * pitchWave * 0.34;

  const lForward = (Math.cos(p - Number(cfg.armPhase ?? 0.12)) + 1) * 0.5;
  const rForward = 1 - lForward;
  const protraction = Number(cfg.shoulderProtraction ?? 0.010);
  const lift = Number(cfg.shoulderLift ?? 0.006);
  lShoulder.x += (lForward - 0.5) * protraction;
  rShoulder.x += (rForward - 0.5) * protraction;
  lShoulder.z += -pelvisInfo.balance * Number(cfg.shoulderRoll ?? 0.007) + (lForward - 0.5) * lift;
  rShoulder.z += -pelvisInfo.balance * Number(cfg.shoulderRoll ?? 0.007) - (rForward - 0.5) * lift;
}

function applyArms(state, phase, cfg) {
  const p = TAU * phase;
  const amp = Number(cfg.swing ?? 0.145);
  const asym = Number(cfg.asymmetry ?? 0.045);
  const lag = Number(cfg.lag ?? 0.14);
  const leftDriver = Math.cos(p - lag);
  const rightDriver = -Math.cos(p - lag * 1.08);

  const lua = ensureBone(state.bones, 'leftUpperArm');
  const rua = ensureBone(state.bones, 'rightUpperArm');
  const lla = ensureBone(state.bones, 'leftLowerArm');
  const rla = ensureBone(state.bones, 'rightLowerArm');
  const lh = ensureBone(state.bones, 'leftHand');
  const rh = ensureBone(state.bones, 'rightHand');

  lua.x += -leftDriver * amp * (1 + asym);
  rua.x += -rightDriver * amp * (1 - asym * 0.55);

  const twist = Number(cfg.upperArmTwist ?? 0.030);
  lua.y += Math.sin(p - lag - 0.20) * twist;
  rua.y -= Math.sin(p - lag * 1.06 - 0.20) * twist * 0.92;
  const armPlane = Number(cfg.armPlane ?? 0.014);
  lua.z += Math.sin(p * 2 + 0.35) * armPlane;
  rua.z -= Math.sin(p * 2 + 0.55) * armPlane * 0.90;

  const lForward = clamp((leftDriver + 1) * 0.5, 0, 1);
  const rForward = clamp((rightDriver + 1) * 0.5, 0, 1);
  const elbowFlex = Number(cfg.elbowFlex ?? 0.085);
  lla.x += -elbowFlex * (0.34 + lForward * 0.66);
  rla.x += -elbowFlex * (0.34 + rForward * 0.66);
  const elbowTwist = Number(cfg.elbowTwist ?? 0.014);
  lla.y += Math.sin(p - lag - 0.42) * elbowTwist;
  rla.y -= Math.sin(p - lag - 0.48) * elbowTwist;

  const wristPhase = p - lag - Number(cfg.wristLag ?? 0.48);
  const handFlex = Number(cfg.handFlex ?? 0.035);
  const pronation = Number(cfg.pronation ?? 0.045);
  const deviation = Number(cfg.handDeviation ?? 0.020);
  lh.x += -Math.cos(wristPhase) * handFlex;
  rh.x += Math.cos(wristPhase + 0.08) * handFlex * 0.92;
  lh.y += Math.sin(wristPhase - 0.20) * pronation;
  rh.y -= Math.sin(wristPhase - 0.12) * pronation * 0.92;
  lh.z += Math.sin(wristPhase * 0.92 + 0.25) * deviation;
  rh.z -= Math.sin(wristPhase * 0.92 + 0.42) * deviation * 0.90;
}

function applyHands(state, phase, cfg) {
  if (cfg?.enabled === false) return;
  const p = TAU * phase;
  const curlScale = Number(cfg.curlScale ?? 1.0);
  const pulse = Number(cfg.curlPulse ?? 0.025);
  const pulseL = 1 + Math.sin(p - 0.48) * pulse;
  const pulseR = 1 + Math.sin(p + Math.PI - 0.34) * pulse * 0.90;

  const fingers = {
    Index: [0.14, 0.24, 0.07],
    Middle: [0.17, 0.30, 0.09],
    Ring: [0.21, 0.35, 0.11],
    Little: [0.25, 0.39, 0.13],
    ...(cfg.fingerCurl || {}),
  };
  const segments = ['Proximal', 'Intermediate', 'Distal'];

  for (const [side, sign, pulseSide] of [['left', 1, pulseL], ['right', -1, pulseR]]) {
    for (const [digit, values] of Object.entries(fingers)) {
      for (let i = 0; i < segments.length; i++) {
        const bone = ensureBone(state.bones, `${side}${digit}${segments[i]}`);
        bone.z += sign * Number(values[i] || 0) * curlScale * pulseSide;
      }
    }
  }

  const thumb = cfg.thumb || {};
  const leftThumb = ensureBone(state.bones, 'leftThumbProximal');
  const rightThumb = ensureBone(state.bones, 'rightThumbProximal');
  leftThumb.x += Number(thumb.x ?? -0.055);
  rightThumb.x += Number(thumb.x ?? -0.055);
  leftThumb.y += Number(thumb.y ?? 0.090);
  rightThumb.y -= Number(thumb.y ?? 0.090);
  leftThumb.z += Number(thumb.z ?? 0.065);
  rightThumb.z -= Number(thumb.z ?? 0.065);
}

function applyBreathing(state, phase, cfg) {
  const p = TAU * (phase * Number(cfg.cycles ?? 0.5) + Number(cfg.phase ?? 0.13));
  const breath = Math.sin(p);
  const secondary = Math.sin(p * 2 + 0.40) * 0.18;
  ensureBone(state.bones, 'chest').x += (breath + secondary) * Number(cfg.chestPitch ?? 0.0060);
  ensureBone(state.bones, 'spine').x += breath * Number(cfg.spinePitch ?? 0.0030);
  ensureBone(state.bones, 'upperChest').x += breath * Number(cfg.upperChestPitch ?? 0.0020);
  state.root.y += breath * Number(cfg.rootLift ?? 0.0011);
}

function applyHead(state, phase, cfg, pelvisInfo, seed) {
  const p = TAU * phase;
  const head = ensureBone(state.bones, 'head');
  const neck = ensureBone(state.bones, 'neck');
  const chest = ensureBone(state.bones, 'chest');
  const upperChest = ensureBone(state.bones, 'upperChest');
  const hips = ensureBone(state.bones, 'hips');

  head.z -= (hips.z * 0.30 + chest.z * 0.42 + upperChest.z * 0.22)
    * Number(cfg.rollStabilization ?? 0.68);
  head.y -= (hips.y * 0.22 + chest.y * 0.44 + upperChest.y * 0.20)
    * Number(cfg.yawStabilization ?? 0.58);
  neck.z -= chest.z * Number(cfg.neckCounter ?? 0.16);
  neck.y -= upperChest.y * Number(cfg.neckYawCounter ?? 0.08);

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
  applyHands(state, gaitPhase, cfg.hands);
  applyBreathing(state, phase, cfg.breathing);
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
  const duration = Number(preset?.duration || 1.46);
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
    format: 'HellCorpOrganicGaitV2',
    character: profile?.name || 'character',
    preset: preset?.name || 'organic_walk',
    fps: Number(preset?.fps || 30),
    duration: Number(preset?.duration || 1.46),
    deterministic: true,
    upper_body: 'multi-segment delayed torso + scapula + elbow/wrist/finger lag',
    grounding: 'soft two-bone support-leg IK in renderer',
  };
}
