import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const IDENTITY_Q = new THREE.Quaternion();

const CORE_MAP = [
  ['hips', 'Hips'],
  ['spine', 'Spine'],
  ['chest', 'Spine1'],
  ['upperChest', 'Spine2'],
  ['neck', 'Neck'],
  ['head', 'Head'],

  ['leftShoulder', 'LeftShoulder'],
  ['leftUpperArm', 'LeftArm'],
  ['leftLowerArm', 'LeftForeArm'],
  ['leftHand', 'LeftHand'],
  ['rightShoulder', 'RightShoulder'],
  ['rightUpperArm', 'RightArm'],
  ['rightLowerArm', 'RightForeArm'],
  ['rightHand', 'RightHand'],

  ['leftUpperLeg', 'LeftUpLeg'],
  ['leftLowerLeg', 'LeftLeg'],
  ['leftFoot', 'LeftFoot'],
  ['leftToes', 'LeftToeBase'],
  ['rightUpperLeg', 'RightUpLeg'],
  ['rightLowerLeg', 'RightLeg'],
  ['rightFoot', 'RightFoot'],
  ['rightToes', 'RightToeBase'],
];

const FINGERS = [
  ['Thumb', ['Metacarpal', 'Proximal', 'Distal']],
  ['Index', ['Proximal', 'Intermediate', 'Distal']],
  ['Middle', ['Proximal', 'Intermediate', 'Distal']],
  ['Ring', ['Proximal', 'Intermediate', 'Distal']],
  ['Little', ['Proximal', 'Intermediate', 'Distal']],
];

function buildBoneMap() {
  const out = CORE_MAP.slice();
  for (const side of ['Left', 'Right']) {
    const vrmSide = side.toLowerCase();
    for (const [digit, vrmSegments] of FINGERS) {
      for (let i = 0; i < 3; i++) {
        out.push([
          `${vrmSide}${digit}${vrmSegments[i]}`,
          `${side}Hand${digit === 'Little' ? 'Pinky' : digit}${i + 1}`,
        ]);
      }
    }
  }
  return out;
}

export const MIXAMO_TO_VRM = Object.freeze(buildBoneMap());

function cleanSourceName(name) {
  if (!name) return '';
  const noNamespace = String(name).split(':').pop();
  return noNamespace.replace(/^mixamorig/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function indexSourceBones(root) {
  const byName = new Map();
  root.traverse((obj) => {
    if (!obj?.isBone) return;
    const key = cleanSourceName(obj.name);
    if (key && !byName.has(key)) byName.set(key, obj);
  });
  return byName;
}

function sourceBone(index, mixamoName) {
  return index.get(cleanSourceName(mixamoName)) || null;
}

function worldQuaternion(obj) {
  const q = new THREE.Quaternion();
  obj.getWorldQuaternion(q);
  return q;
}

function worldPosition(obj) {
  const p = new THREE.Vector3();
  obj.getWorldPosition(p);
  return p;
}

function captureSourceRest(index) {
  const rest = new Map();
  for (const [, sourceName] of MIXAMO_TO_VRM) {
    const bone = sourceBone(index, sourceName);
    if (!bone || rest.has(sourceName)) continue;
    rest.set(sourceName, {
      worldQuaternion: worldQuaternion(bone),
      worldPosition: worldPosition(bone),
    });
  }
  return rest;
}

function captureTargetRest(getTargetBone) {
  const rest = new Map();
  for (const [vrmName] of MIXAMO_TO_VRM) {
    const bone = getTargetBone(vrmName);
    if (!bone || rest.has(vrmName)) continue;
    rest.set(vrmName, {
      worldQuaternion: worldQuaternion(bone),
      worldPosition: worldPosition(bone),
      localQuaternion: bone.quaternion.clone(),
    });
  }
  return rest;
}

function chainLength(rest, names) {
  let total = 0;
  for (let i = 0; i < names.length - 1; i++) {
    const a = rest.get(names[i])?.worldPosition;
    const b = rest.get(names[i + 1])?.worldPosition;
    if (a && b) total += a.distanceTo(b);
  }
  return total;
}

function estimateScale(sourceRest, targetRest) {
  const sourceLegL = chainLength(sourceRest, ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot']);
  const sourceLegR = chainLength(sourceRest, ['Hips', 'RightUpLeg', 'RightLeg', 'RightFoot']);
  const targetLegL = chainLength(targetRest, ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot']);
  const targetLegR = chainLength(targetRest, ['hips', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']);

  const source = [sourceLegL, sourceLegR].filter((v) => v > 1e-6);
  const target = [targetLegL, targetLegR].filter((v) => v > 1e-6);
  if (source.length && target.length) {
    const s = source.reduce((a, b) => a + b, 0) / source.length;
    const t = target.reduce((a, b) => a + b, 0) / target.length;
    if (s > 1e-6 && Number.isFinite(t / s)) return t / s;
  }

  const sh = sourceRest.get('Hips')?.worldPosition;
  const sf = sourceRest.get('LeftFoot')?.worldPosition || sourceRest.get('RightFoot')?.worldPosition;
  const th = targetRest.get('hips')?.worldPosition;
  const tf = targetRest.get('leftFoot')?.worldPosition || targetRest.get('rightFoot')?.worldPosition;
  if (sh && sf && th && tf) {
    const s = sh.distanceTo(sf);
    const t = th.distanceTo(tf);
    if (s > 1e-6 && Number.isFinite(t / s)) return t / s;
  }
  return 1;
}

function clipBySelector(animations, selector) {
  if (!animations?.length) throw new Error('FBX contains no animation clips.');
  if (selector == null || selector === '') return animations[0];

  const numeric = Number(selector);
  if (Number.isInteger(numeric) && String(selector).trim() !== '') {
    if (numeric < 0 || numeric >= animations.length) {
      throw new Error(`clip index ${numeric} out of range (0..${animations.length - 1})`);
    }
    return animations[numeric];
  }

  const exact = animations.find((c) => c.name === selector);
  if (exact) return exact;
  const lower = String(selector).toLowerCase();
  const fuzzy = animations.find((c) => String(c.name || '').toLowerCase().includes(lower));
  if (fuzzy) return fuzzy;
  throw new Error(`animation clip not found: ${selector}`);
}

export async function loadMixamoFbx(fileOrBuffer, options = {}) {
  const loader = new FBXLoader();
  let buffer;
  if (fileOrBuffer instanceof ArrayBuffer) buffer = fileOrBuffer;
  else if (ArrayBuffer.isView(fileOrBuffer)) buffer = fileOrBuffer.buffer;
  else if (fileOrBuffer?.arrayBuffer) buffer = await fileOrBuffer.arrayBuffer();
  else throw new Error('Expected File, ArrayBuffer or typed array for FBX input.');

  const source = loader.parse(buffer, options.resourcePath || '');
  source.updateMatrixWorld(true);

  const index = indexSourceBones(source);
  const required = ['Hips', 'Spine', 'LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg'];
  const missing = required.filter((name) => !sourceBone(index, name));
  if (missing.length) {
    throw new Error(`Not a compatible Mixamo humanoid FBX. Missing bones: ${missing.join(', ')}`);
  }

  const animations = source.animations || [];
  if (!animations.length) throw new Error('FBX parsed correctly but contains no animation.');

  return {
    source,
    index,
    animations,
    clips: animations.map((clip, i) => ({
      index: i,
      name: clip.name || `clip_${i}`,
      duration: Number(clip.duration || 0),
      tracks: clip.tracks?.length || 0,
    })),
  };
}

export function createMixamoRetargeter(config) {
  const {
    source,
    sourceIndex,
    animations,
    clipSelector,
    getTargetBone,
    resetTargetPose,
    targetRoot,
    rootMode = 'inplace',
    rotationStrength = 1,
    rootStrength = 1,
  } = config || {};

  if (!source || !sourceIndex || !animations || !getTargetBone || !targetRoot) {
    throw new Error('createMixamoRetargeter: missing source/target configuration.');
  }

  const clip = clipBySelector(animations, clipSelector);
  source.updateMatrixWorld(true);
  const sourceRest = captureSourceRest(sourceIndex);

  resetTargetPose?.();
  targetRoot.updateMatrixWorld(true);
  const targetRootBasePosition = targetRoot.position.clone();
  const targetRest = captureTargetRest(getTargetBone);

  const mappings = [];
  const missingSource = [];
  const missingTarget = [];

  for (const [vrmName, mixamoName] of MIXAMO_TO_VRM) {
    const s = sourceBone(sourceIndex, mixamoName);
    const t = getTargetBone(vrmName);
    const sr = sourceRest.get(mixamoName);
    const tr = targetRest.get(vrmName);
    if (!s || !sr) {
      missingSource.push(mixamoName);
      continue;
    }
    if (!t || !tr) {
      missingTarget.push(vrmName);
      continue;
    }

    const align = tr.worldQuaternion.clone().multiply(sr.worldQuaternion.clone().invert());
    mappings.push({
      vrmName,
      mixamoName,
      sourceBone: s,
      targetBone: t,
      sourceRest: sr,
      targetRest: tr,
      align,
      alignInv: align.clone().invert(),
    });
  }

  const mixer = new THREE.AnimationMixer(source);
  const action = mixer.clipAction(clip);
  action.reset();
  action.enabled = true;
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = false;
  action.play();

  const scale = estimateScale(sourceRest, targetRest);
  const hipsMap = mappings.find((m) => m.vrmName === 'hips');
  const sourceHips = sourceBone(sourceIndex, 'Hips');
  const sourceHipsRest = sourceRest.get('Hips');

  function resetTarget() {
    resetTargetPose?.();
    targetRoot.position.copy(targetRootBasePosition);
    targetRoot.updateMatrixWorld(true);
  }

  function applyRootMotion() {
    if (!sourceHips || !sourceHipsRest || !hipsMap || rootMode === 'locked') return;
    const current = worldPosition(sourceHips);
    const delta = current.sub(sourceHipsRest.worldPosition).multiplyScalar(scale * Number(rootStrength || 0));
    delta.applyQuaternion(hipsMap.align);

    if (rootMode === 'inplace' || rootMode === 'vertical') {
      delta.x = 0;
      delta.z = 0;
    } else if (rootMode === 'horizontal') {
      delta.y = 0;
    }

    targetRoot.position.copy(targetRootBasePosition).add(delta);
    targetRoot.updateMatrixWorld(true);
  }

  function applyTime(timeSeconds) {
    const duration = Math.max(1e-8, Number(clip.duration || 0));
    const t = ((Number(timeSeconds || 0) % duration) + duration) % duration;

    mixer.setTime(t);
    source.updateMatrixWorld(true);

    resetTarget();
    applyRootMotion();

    const strength = THREE.MathUtils.clamp(Number(rotationStrength ?? 1), 0, 1.5);

    for (const m of mappings) {
      const sourceCurrentWorld = worldQuaternion(m.sourceBone);
      const deltaSource = sourceCurrentWorld.multiply(m.sourceRest.worldQuaternion.clone().invert());
      const deltaTarget = m.align.clone().multiply(deltaSource).multiply(m.alignInv);
      const weightedDelta = IDENTITY_Q.clone().slerp(deltaTarget, Math.min(strength, 1));

      if (strength > 1) {
        const extra = IDENTITY_Q.clone().slerp(deltaTarget, Math.min(strength - 1, 0.5));
        weightedDelta.multiply(extra);
      }

      const desiredWorld = weightedDelta.multiply(m.targetRest.worldQuaternion.clone());
      const parentWorld = new THREE.Quaternion();
      m.targetBone.parent.getWorldQuaternion(parentWorld);
      const desiredLocal = parentWorld.invert().multiply(desiredWorld);

      m.targetBone.quaternion.copy(desiredLocal).normalize();
      targetRoot.updateMatrixWorld(true);
    }

    return t;
  }

  function dispose() {
    action.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(source);
  }

  return {
    clip,
    duration: Number(clip.duration || 0),
    scale,
    mappings,
    missingSource: [...new Set(missingSource)],
    missingTarget: [...new Set(missingTarget)],
    applyTime,
    resetTarget,
    dispose,
    diagnostics() {
      return {
        clip: clip.name || 'mixamo_clip',
        duration: Number(clip.duration || 0),
        mappedBones: mappings.length,
        scale,
        rootMode,
        missingSource: [...new Set(missingSource)],
        missingTarget: [...new Set(missingTarget)],
      };
    },
  };
}

export function summarizeMixamoAsset(asset) {
  return {
    clips: asset?.clips || [],
    boneCount: asset?.index?.size || 0,
    compatible: !!asset?.index?.get(cleanSourceName('Hips')),
    mappedBoneDefinitions: MIXAMO_TO_VRM.length,
  };
}
