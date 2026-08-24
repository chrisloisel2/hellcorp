// HellCorp Motion Studio V3 - authored animation runtime.
//
// This module intentionally does not depend on MediaPipe, Kalidokit or Three.js.
// It evaluates a deterministic animation clip into a normalized humanoid pose.
// Rendering/application to a VRM is handled by the generated app_v3.js.

const TAU = Math.PI * 2;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function wrap01(v) { return ((v % 1) + 1) % 1; }
function smoothstep01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function smootherstep01(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function hash32(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = Math.imul(n, 9);
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return n >>> 0;
}
function hash01(seed, n) { return hash32((seed | 0) ^ Math.imul((n | 0) + 1, 0x9e3779b1)) / 0xffffffff; }
function signedNoise(seed, n) { return hash01(seed, n) * 2 - 1; }

function catmullRom(p0, p1, p2, p3, t, tension = 0.5) {
  const t2 = t * t;
  const t3 = t2 * t;
  const m1 = (p2 - p0) * tension;
  const m2 = (p3 - p1) * tension;
  const a = 2 * t3 - 3 * t2 + 1;
  const b = t3 - 2 * t2 + t;
  const c = -2 * t3 + 3 * t2;
  const d = t3 - t2;
  return a * p1 + b * m1 + c * p2 + d * m2;
}

function normalizedKeys(track) {
  const keys = Array.isArray(track) ? track : (track?.keys || []);
  return keys
    .map((k) => ({ t: wrap01(Number(k.t || 0)), v: Number(k.v || 0), ease: k.ease || null }))
    .sort((a, b) => a.t - b.t);
}

function segmentFor(keys, phase) {
  if (!keys.length) return null;
  if (keys.length === 1) return { i1: 0, i2: 0, u: 0 };
  const p = wrap01(phase);
  for (let i = 0; i < keys.length; i++) {
    const j = (i + 1) % keys.length;
    const t1 = keys[i].t;
    const t2 = j === 0 ? keys[0].t + 1 : keys[j].t;
    const pp = p < t1 ? p + 1 : p;
    if (pp >= t1 && pp <= t2 + 1e-9) {
      const span = Math.max(1e-9, t2 - t1);
      return { i1: i, i2: j, u: clamp((pp - t1) / span, 0, 1) };
    }
  }
  return { i1: keys.length - 1, i2: 0, u: 0 };
}

function sampleTrack(track, phase) {
  const keys = normalizedKeys(track);
  if (!keys.length) return 0;
  if (keys.length === 1) return keys[0].v;
  const seg = segmentFor(keys, phase);
  const i1 = seg.i1;
  const i2 = seg.i2;
  let u = seg.u;
  const curve = (Array.isArray(track) ? null : track.curve) || 'catmull';
  const explicitEase = keys[i1]?.ease || null;
  if (explicitEase === 'smooth') u = smoothstep01(u);
  else if (explicitEase === 'smoother') u = smootherstep01(u);
  else if (explicitEase === 'linear' || curve === 'linear') return lerp(keys[i1].v, keys[i2].v, u);
  if (curve === 'step') return keys[i1].v;
  if (curve === 'smooth') return lerp(keys[i1].v, keys[i2].v, smootherstep01(u));

  const i0 = (i1 - 1 + keys.length) % keys.length;
  const i3 = (i2 + 1) % keys.length;
  const tension = Number(Array.isArray(track) ? 0.5 : (track.tension ?? 0.5));
  return catmullRom(keys[i0].v, keys[i1].v, keys[i2].v, keys[i3].v, u, tension);
}

function ensureBone(bones, name) {
  if (!bones[name]) bones[name] = { x: 0, y: 0, z: 0, rotationOrder: 'XYZ' };
  return bones[name];
}

function addPath(state, path, value, mode = 'add') {
  const parts = path.split('.');
  if (parts[0] === 'root' && parts[1] === 'position') {
    const axis = parts[2];
    if (axis && axis in state.root) state.root[axis] = mode === 'absolute' ? value : state.root[axis] + value;
    return;
  }
  const boneName = parts[0];
  const axis = parts[parts.length - 1];
  if (!['x', 'y', 'z'].includes(axis)) return;
  const bone = ensureBone(state.bones, boneName);
  bone[axis] = mode === 'absolute' ? value : Number(bone[axis] || 0) + value;
}

function gaussianPhase(phase, center, width) {
  let d = Math.abs(wrap01(phase) - wrap01(center));
  d = Math.min(d, 1 - d);
  const s = Math.max(1e-4, width);
  return Math.exp(-(d * d) / (2 * s * s));
}

function blinkValue(phase, blinkTimes, width = 0.030) {
  let value = 0;
  for (const t of blinkTimes || []) {
    const d0 = gaussianPhase(phase, Number(t), width);
    value = Math.max(value, d0);
  }
  return clamp(Math.pow(value, 0.72), 0, 1);
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
  const span = Math.max(1e-6, t2 - t1);
  const raw = clamp((pp - t1) / span, 0, 1);
  // Eyes hold their target for most of the interval, then saccade quickly.
  const transitionStart = 0.78;
  const u = raw <= transitionStart ? 0 : smootherstep01((raw - transitionStart) / (1 - transitionStart));
  return {
    x: lerp(Number(current.x || 0), Number(next.x || 0), u),
    y: lerp(Number(current.y || 0), Number(next.y || 0), u),
  };
}

function applyBreathing(state, phase, cfg) {
  if (!cfg || cfg.enabled === false) return;
  const cycles = Number(cfg.cycles ?? 1.0);
  const p = TAU * (phase * cycles + Number(cfg.phase || 0));
  const breath = Math.sin(p);
  const secondary = Math.sin(p * 2 + 0.35) * 0.22;
  const chest = ensureBone(state.bones, 'chest');
  const spine = ensureBone(state.bones, 'spine');
  chest.x += breath * Number(cfg.chestPitch || 0.012);
  spine.x += breath * Number(cfg.spinePitch || 0.006);
  state.root.y += (breath + secondary) * Number(cfg.rootLift || 0.004);
}

function applyPelvisFigureEight(state, phase, cfg) {
  if (!cfg || cfg.enabled === false) return;
  const p = TAU * (phase + Number(cfg.phase || 0));
  const hips = ensureBone(state.bones, 'hips');
  hips.z += Math.sin(p) * Number(cfg.roll || 0.015);
  hips.y += Math.sin(p * 2 + Math.PI / 2) * Number(cfg.yaw || 0.012);
  state.root.x += Math.sin(p) * Number(cfg.shiftX || 0.004);
}

function applyStepCompression(state, phase, cfg) {
  if (!cfg || cfg.enabled === false) return;
  const contacts = cfg.contacts || [0, 0.5];
  const width = Number(cfg.width || 0.055);
  let hit = 0;
  for (const c of contacts) hit += gaussianPhase(phase, c, width);
  state.root.y -= hit * Number(cfg.drop || 0.008);
  const hips = ensureBone(state.bones, 'hips');
  hips.x += hit * Number(cfg.hipPitch || 0.010);
}

function applyHeadStabilization(state, phase, cfg) {
  if (!cfg || cfg.enabled === false) return;
  const hips = ensureBone(state.bones, 'hips');
  const spine = ensureBone(state.bones, 'spine');
  const neck = ensureBone(state.bones, 'neck');
  const head = ensureBone(state.bones, 'head');
  const gain = Number(cfg.gain ?? 0.40);
  head.z -= (Number(hips.z || 0) * 0.45 + Number(spine.z || 0) * 0.55) * gain;
  head.y -= (Number(hips.y || 0) * 0.30 + Number(spine.y || 0) * 0.40) * gain;
  neck.z -= Number(spine.z || 0) * Number(cfg.neckGain ?? 0.12);
}

function applyMicroMotion(state, phase, cfg, seed) {
  if (!cfg || cfg.enabled === false) return;
  const p = TAU * phase;
  const a = signedNoise(seed, 11);
  const b = signedNoise(seed, 29);
  const c = signedNoise(seed, 47);
  const head = ensureBone(state.bones, 'head');
  const chest = ensureBone(state.bones, 'chest');
  const leftHand = ensureBone(state.bones, 'leftHand');
  const rightHand = ensureBone(state.bones, 'rightHand');
  head.y += (Math.sin(p * 0.5 + a) + 0.35 * Math.sin(p * 1.5 + b)) * Number(cfg.headYaw || 0.004);
  head.z += (Math.sin(p * 0.75 + b) + 0.25 * Math.sin(p * 2.0 + c)) * Number(cfg.headRoll || 0.003);
  chest.z += Math.sin(p * 1.25 + c) * Number(cfg.chestRoll || 0.0025);
  leftHand.z += Math.sin(p * 1.6 + a) * Number(cfg.handRoll || 0.010);
  rightHand.z += Math.sin(p * 1.6 + a + Math.PI * 0.85) * Number(cfg.handRoll || 0.010);
}

function applyArmFollowThrough(state, phase, cfg) {
  if (!cfg || cfg.enabled === false) return;
  const lag = Number(cfg.lag || 0.06);
  const p = TAU * wrap01(phase - lag);
  const amp = Number(cfg.amplitude || 0.018);
  const leftLower = ensureBone(state.bones, 'leftLowerArm');
  const rightLower = ensureBone(state.bones, 'rightLowerArm');
  const leftHand = ensureBone(state.bones, 'leftHand');
  const rightHand = ensureBone(state.bones, 'rightHand');
  leftLower.x += Math.sin(p) * amp;
  rightLower.x -= Math.sin(p) * amp;
  leftHand.x += Math.sin(p - 0.35) * amp * 0.55;
  rightHand.x -= Math.sin(p - 0.35) * amp * 0.55;
}

function applyAsymmetry(state, cfg) {
  if (!cfg) return;
  for (const [path, value] of Object.entries(cfg)) addPath(state, path, Number(value || 0), 'add');
}

function initializeState(profile) {
  const state = {
    root: { x: 0, y: 0, z: 0 },
    bones: {},
    expressions: { blink: 0, happy: 0, relaxed: 0, mouthOpen: 0 },
    eyes: { x: 0, y: 0 },
  };
  for (const [boneName, rot] of Object.entries(profile?.basePose || {})) {
    state.bones[boneName] = {
      x: Number(rot.x || 0), y: Number(rot.y || 0), z: Number(rot.z || 0),
      rotationOrder: rot.rotationOrder || 'XYZ',
    };
  }
  const root = profile?.baseRoot || {};
  state.root.x = Number(root.x || 0);
  state.root.y = Number(root.y || 0);
  state.root.z = Number(root.z || 0);
  return state;
}

function applyClipTracks(state, clip, phase) {
  for (const [path, track] of Object.entries(clip?.tracks || {})) {
    const mode = Array.isArray(track) ? 'add' : (track.mode || 'add');
    addPath(state, path, sampleTrack(track, phase), mode);
  }
}

function evaluateFrame(clip, profile, phase, frameIndex, fps) {
  const state = initializeState(profile);
  applyClipTracks(state, clip, phase);

  const layers = { ...(profile?.layers || {}), ...(clip?.layers || {}) };
  const seed = Number(clip?.seed ?? profile?.seed ?? 1337);
  applyPelvisFigureEight(state, phase, layers.pelvisFigureEight);
  applyStepCompression(state, phase, layers.stepCompression);
  applyBreathing(state, phase, layers.breathing);
  applyArmFollowThrough(state, phase, layers.armFollowThrough);
  applyMicroMotion(state, phase, layers.microMotion, seed);
  applyHeadStabilization(state, phase, layers.headStabilization);
  applyAsymmetry(state, profile?.asymmetry);

  const blinkTimes = clip?.blinkTimes || profile?.blinkTimes || [0.23, 0.73];
  state.expressions.blink = blinkValue(phase, blinkTimes, Number(layers?.blink?.width || 0.028));
  state.expressions.happy = clamp(Number(clip?.expressions?.happy ?? profile?.expressions?.happy ?? 0.08), 0, 1);
  state.expressions.relaxed = clamp(Number(clip?.expressions?.relaxed ?? profile?.expressions?.relaxed ?? 0.10), 0, 1);
  state.expressions.mouthOpen = clamp(Number(clip?.expressions?.mouthOpen ?? 0), 0, 1);
  state.eyes = sampleEyeTargets(phase, clip?.eyeTargets || profile?.eyeTargets || [{ t: 0, x: 0, y: 0 }]);

  return {
    phase,
    frameIndex,
    fps,
    root: state.root,
    bones: state.bones,
    expressions: state.expressions,
    eyes: state.eyes,
  };
}

export function createAuthoredRuntime(clip, profile = {}, options = {}) {
  const fps = Number(options.fps || clip?.fps || 30);
  const duration = Number(options.duration || clip?.duration || 1.2);
  const framesPerCycle = Math.max(1, Math.round(duration * fps));
  return {
    fps,
    duration,
    framesPerCycle,
    frame(frameIndex) {
      const local = ((frameIndex % framesPerCycle) + framesPerCycle) % framesPerCycle;
      const phase = local / framesPerCycle;
      return evaluateFrame(clip, profile, phase, frameIndex, fps);
    },
    samplePhase(phase) {
      return evaluateFrame(clip, profile, wrap01(phase), Math.round(wrap01(phase) * framesPerCycle), fps);
    },
  };
}

export function authoredClipSummary(clip, profile = {}) {
  return {
    format: clip?.format || null,
    name: clip?.name || 'authored_clip',
    fps: Number(clip?.fps || 30),
    duration: Number(clip?.duration || 1.2),
    trackCount: Object.keys(clip?.tracks || {}).length,
    baseBoneCount: Object.keys(profile?.basePose || {}).length,
    layerCount: Object.keys({ ...(profile?.layers || {}), ...(clip?.layers || {}) }).length,
  };
}
