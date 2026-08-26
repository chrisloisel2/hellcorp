import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { parseMixamoFbx, createVrmAnimationClipFromMixamo } from '../mixamo_clean/mixamo_to_vrm.js';

const statusEl = document.getElementById('status');

let currentVrm = null;
let currentVrmFile = null;
let currentFbxFile = null;
let currentMixer = null;
let currentAction = null;
let currentClip = null;
let currentDiagnostics = null;

const VIEW_AZIMUTH = Object.freeze({
  front: 0,
  front_3q_left: -35,
  front_3q_right: 35,
  threequarter: 35,
  side: 90,
  back: 180,
});

const DIRECT_JOINT_BONES = Object.freeze({
  hip_l: 'leftUpperLeg', hip_r: 'rightUpperLeg',
  knee_l: 'leftLowerLeg', knee_r: 'rightLowerLeg',
  ankle_l: 'leftFoot', ankle_r: 'rightFoot',
  toe_l: 'leftToes', toe_r: 'rightToes',
  shoulder_l: 'leftUpperArm', shoulder_r: 'rightUpperArm',
  elbow_l: 'leftLowerArm', elbow_r: 'rightLowerArm',
  wrist_l: 'leftHand', wrist_r: 'rightHand',
  neck: 'neck', head: 'head',
});

function setStatus(text, bad = false) {
  statusEl.textContent = text;
  statusEl.dataset.bad = bad ? '1' : '0';
}

function assertFiniteClip(clip) {
  for (const track of clip.tracks) {
    for (let i = 0; i < track.values.length; i++) {
      if (!Number.isFinite(Number(track.values[i]))) {
        throw new Error(`Non-finite animation value in ${track.name} at ${i}.`);
      }
    }
  }
}

function clearAnimation() {
  if (currentAction) currentAction.stop();
  if (currentMixer && currentVrm) {
    currentMixer.stopAllAction();
    currentMixer.uncacheRoot(currentVrm.scene);
  }
  currentMixer = null;
  currentAction = null;
  currentClip = null;
  currentDiagnostics = null;
  currentFbxFile = null;
}

async function loadVrmFile(file) {
  clearAnimation();
  currentVrm = null;
  currentVrmFile = null;
  if (!file) throw new Error('VRM file missing.');
  setStatus('Loading VRM...');

  const url = URL.createObjectURL(file);
  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm?.humanoid) throw new Error('The file does not contain a usable VRM humanoid.');

    VRMUtils.rotateVRM0(vrm);
    vrm.humanoid.resetNormalizedPose();
    vrm.expressionManager?.resetValues();
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);

    const required = [
      'hips', 'spine', 'chest', 'neck', 'head',
      'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightUpperArm', 'rightLowerArm', 'rightHand',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    ];
    const missing = required.filter((name) => !vrm.humanoid.getNormalizedBoneNode(name));
    if (missing.length) throw new Error(`VRM is missing required humanoid bones: ${missing.join(', ')}`);

    currentVrm = vrm;
    currentVrmFile = file;
    setStatus('VRM ready');
    return { file: file.name, vrmVersion: vrm.meta?.metaVersion || 'unknown' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadFbxFile(file, options = {}) {
  if (!currentVrm) throw new Error('Load the VRM before the Mixamo FBX.');
  if (!file) throw new Error('FBX file missing.');
  clearAnimation();
  setStatus('Parsing Mixamo FBX...');

  const parsed = await parseMixamoFbx(file);
  const result = createVrmAnimationClipFromMixamo(parsed, currentVrm, {
    clip: options.clip,
    rootMode: options.rootMode || 'detrend',
  });
  assertFiniteClip(result.clip);
  if ((result.diagnostics?.coreCoverage || 0) < 0.90) {
    throw new Error(`Strict retarget validation failed: coreCoverage=${result.diagnostics?.coreCoverage || 0}`);
  }

  currentClip = result.clip;
  currentDiagnostics = result.diagnostics;
  currentFbxFile = file;
  currentVrm.humanoid.resetNormalizedPose();
  currentVrm.update(0);

  currentMixer = new THREE.AnimationMixer(currentVrm.scene);
  currentAction = currentMixer.clipAction(currentClip);
  currentAction.reset();
  currentAction.enabled = true;
  currentAction.setLoop(THREE.LoopRepeat, Infinity);
  currentAction.play();
  evaluateAt(0);
  setStatus('Mixamo animation ready');
  return { sourceFile: file.name, clips: parsed.clips, selected: currentDiagnostics };
}

function evaluateAt(time) {
  if (!currentMixer || !currentClip || !currentVrm) throw new Error('Animation is not ready.');
  const duration = Math.max(1e-8, currentClip.duration);
  const t = THREE.MathUtils.clamp(Number(time || 0), 0, Math.max(0, duration - 1e-7));
  currentMixer.setTime(t);
  currentVrm.update(0);
  currentVrm.scene.updateMatrixWorld(true);
  return t;
}

function worldBone(name) {
  const node = currentVrm?.humanoid?.getNormalizedBoneNode(name);
  if (!node) return null;
  return node.getWorldPosition(new THREE.Vector3());
}

function extrapolate(a, b, factor) {
  return b.clone().add(b.clone().sub(a).multiplyScalar(factor));
}

function captureWorldJoints() {
  const joints = {};
  for (const [joint, bone] of Object.entries(DIRECT_JOINT_BONES)) {
    const p = worldBone(bone);
    if (p) joints[joint] = p;
  }

  if (!joints.toe_l) joints.toe_l = extrapolate(joints.knee_l, joints.ankle_l, 0.22);
  if (!joints.toe_r) joints.toe_r = extrapolate(joints.knee_r, joints.ankle_r, 0.22);

  const middleL = worldBone('leftMiddleProximal') || worldBone('leftIndexProximal');
  const middleR = worldBone('rightMiddleProximal') || worldBone('rightIndexProximal');
  joints.hand_l = middleL || extrapolate(joints.elbow_l, joints.wrist_l, 0.25);
  joints.hand_r = middleR || extrapolate(joints.elbow_r, joints.wrist_r, 0.25);

  const required = [
    'hip_l', 'hip_r', 'knee_l', 'knee_r', 'ankle_l', 'ankle_r', 'toe_l', 'toe_r',
    'shoulder_l', 'shoulder_r', 'elbow_l', 'elbow_r', 'wrist_l', 'wrist_r',
    'hand_l', 'hand_r', 'neck', 'head',
  ];
  const missing = required.filter((name) => !joints[name]);
  if (missing.length) throw new Error(`Cannot capture required joints: ${missing.join(', ')}`);
  return joints;
}

function projectWorldPoint(point, view) {
  const yaw = THREE.MathUtils.degToRad(VIEW_AZIMUTH[view] ?? 0);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: point.x * c + point.z * s, y: point.y, z: -point.x * s + point.z * c };
}

function normalizeFrames(rawFrames, padding, mirrorX) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const frame of rawFrames) {
    for (const p of Object.values(frame.joints)) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }

  const spanX = Math.max(1e-8, maxX - minX);
  const spanY = Math.max(1e-8, maxY - minY);
  minX -= spanX * padding; maxX += spanX * padding;
  minY -= spanY * padding; maxY += spanY * padding;
  const denomX = Math.max(1e-8, maxX - minX);
  const denomY = Math.max(1e-8, maxY - minY);
  const denomZ = Math.max(1e-8, maxZ - minZ);

  const frames = rawFrames.map((frame) => {
    const joints = {};
    for (const [name, p] of Object.entries(frame.joints)) {
      let x = (p.x - minX) / denomX;
      if (mirrorX) x = 1 - x;
      joints[name] = { x, y: 1 - (p.y - minY) / denomY, z: (p.z - minZ) / denomZ - 0.5 };
    }
    return { time: frame.time, joints };
  });
  return { frames, bounds: { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY, min_z: minZ, max_z: maxZ } };
}

function continuityReport(frames) {
  let maxStep = 0, maxJoint = null, maxFrame = null;
  for (let i = 1; i < frames.length; i++) {
    for (const [name, p] of Object.entries(frames[i].joints)) {
      const q = frames[i - 1].joints[name];
      if (!q) continue;
      const step = Math.hypot(p.x - q.x, p.y - q.y);
      if (step > maxStep) { maxStep = step; maxJoint = name; maxFrame = i; }
    }
  }
  return { max_joint_step: maxStep, max_joint: maxJoint, frame: maxFrame };
}

async function exportPoseClip(options = {}) {
  if (!currentVrm || !currentClip || !currentMixer) throw new Error('Load VRM and FBX first.');
  const view = options.view || 'front';
  const samples = Math.max(2, Math.floor(Number(options.samples || 16)));
  const padding = Math.max(0, Math.min(0.5, Number(options.padding ?? 0.08)));
  const start = THREE.MathUtils.clamp(Number(options.start || 0), 0, currentClip.duration);
  const requestedEnd = options.end == null ? currentClip.duration : Number(options.end);
  const end = THREE.MathUtils.clamp(requestedEnd, start + 1e-6, currentClip.duration);
  const mirrorX = Boolean(options.mirrorX);

  const rawFrames = [];
  for (let i = 0; i < samples; i++) {
    const alpha = i / samples;
    const t = start + (end - start) * alpha;
    evaluateAt(t);
    const world = captureWorldJoints();
    const joints = {};
    for (const [name, p] of Object.entries(world)) joints[name] = projectWorldPoint(p, view);
    rawFrames.push({ time: t, joints });
  }

  const normalized = normalizeFrames(rawFrames, padding, mirrorX);
  const result = {
    format: 'HellCorpPuppetPoseV1',
    source_vrm: currentVrmFile?.name || null,
    source_fbx: currentFbxFile?.name || null,
    source_clip: currentClip?.name || null,
    source_clip_duration: currentClip.duration,
    start, end, samples, view, mirror_x: mirrorX, padding,
    retarget: currentDiagnostics,
    projection: { type: 'orthographic-skeleton-normalized', bounds: normalized.bounds },
    validation: {
      core_coverage: currentDiagnostics?.coreCoverage || 0,
      finite: true,
      continuity: continuityReport(normalized.frames),
      status: (currentDiagnostics?.coreCoverage || 0) >= 0.90 ? 'PASS' : 'FAIL',
    },
    frames: normalized.frames,
  };
  evaluateAt(0);
  return result;
}

window.__puppetPose = {
  loadVrmFile,
  loadFbxFile,
  exportPoseClip,
  getState() {
    return { vrm: currentVrmFile?.name || null, fbx: currentFbxFile?.name || null, clip: currentClip?.name || null, diagnostics: currentDiagnostics };
  },
};

const vrmInput = document.getElementById('vrmInput');
const fbxInput = document.getElementById('fbxInput');
vrmInput.addEventListener('change', async () => {
  try { await loadVrmFile(vrmInput.files?.[0]); } catch (e) { setStatus(e.message || String(e), true); console.error(e); }
});
fbxInput.addEventListener('change', async () => {
  try { await loadFbxFile(fbxInput.files?.[0], { rootMode: 'detrend' }); } catch (e) { setStatus(e.message || String(e), true); console.error(e); }
});

setStatus('Ready');
