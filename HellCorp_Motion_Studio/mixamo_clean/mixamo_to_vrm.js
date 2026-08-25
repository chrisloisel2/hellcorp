import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Mixamo -> VRM Humanoid map. This intentionally mirrors the mapping used by
// the official pixiv/three-vrm Mixamo example instead of inventing a custom
// world-space solver.
export const MIXAMO_VRM_MAP = Object.freeze({
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',

  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',

  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',

  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
});

const REQUIRED_CORE = Object.freeze([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
]);

function canonicalSourceBoneName(name) {
  let value = String(name || '').trim();
  if (!value) return '';
  value = value.split('.')[0];
  value = value.split('|').pop();
  value = value.replace(/:/g, '');
  value = value.replace(/\s+/g, '');
  return value;
}

function buildSourceIndex(asset) {
  const map = new Map();
  asset.traverse((obj) => {
    if (!obj?.isBone) return;
    const key = canonicalSourceBoneName(obj.name);
    if (key && !map.has(key)) map.set(key, obj);
  });
  return map;
}

function chooseClip(animations, selector) {
  if (!animations?.length) throw new Error('The FBX contains no animation clip.');
  if (selector == null || selector === '') {
    return animations.find((clip) => clip.name === 'mixamo.com') || animations[0];
  }
  const asNumber = Number(selector);
  if (Number.isInteger(asNumber) && String(selector).trim() !== '') {
    if (asNumber < 0 || asNumber >= animations.length) {
      throw new Error(`Clip index ${asNumber} is outside 0..${animations.length - 1}.`);
    }
    return animations[asNumber];
  }
  const exact = animations.find((clip) => clip.name === selector);
  if (exact) return exact;
  const needle = String(selector).toLowerCase();
  const fuzzy = animations.find((clip) => String(clip.name || '').toLowerCase().includes(needle));
  if (fuzzy) return fuzzy;
  throw new Error(`Animation clip not found: ${selector}`);
}

function cloneTimes(track) {
  return new Float32Array(track.times);
}

function cloneValues(track) {
  return new Float32Array(track.values);
}

function findHipsPositionTrack(clip) {
  return clip.tracks.find((track) => {
    const split = track.name.split('.');
    return canonicalSourceBoneName(split[0]) === 'mixamorigHips' && split[1] === 'position';
  }) || null;
}

function computeHipsScale(asset, clip, vrm, sourceIndex) {
  const hipsTrack = findHipsPositionTrack(clip);
  let motionHipsHeight = 0;
  if (hipsTrack?.values?.length >= 2) motionHipsHeight = Math.abs(Number(hipsTrack.values[1]));
  if (motionHipsHeight < 1e-6) {
    motionHipsHeight = Math.abs(Number(sourceIndex.get('mixamorigHips')?.position?.y || 0));
  }

  const normalizedHips = Number(vrm?.humanoid?.normalizedRestPose?.hips?.position?.[1] || 0);
  if (motionHipsHeight < 1e-6 || Math.abs(normalizedHips) < 1e-6) {
    throw new Error(`Unable to compute hips scale (Mixamo=${motionHipsHeight}, VRM=${normalizedHips}).`);
  }
  return {
    motionHipsHeight,
    vrmHipsHeight: normalizedHips,
    scale: normalizedHips / motionHipsHeight,
  };
}

function applyVrm0QuaternionConvention(values) {
  // Same convention used by the official three-vrm Mixamo example.
  for (let i = 0; i < values.length; i += 4) {
    values[i + 0] = -values[i + 0];
    values[i + 2] = -values[i + 2];
  }
}

function applyVrm0PositionConvention(values) {
  for (let i = 0; i < values.length; i += 3) {
    values[i + 0] = -values[i + 0];
    values[i + 2] = -values[i + 2];
  }
}

function detrendHorizontalPosition(times, values) {
  const count = Math.floor(values.length / 3);
  if (count < 2) return;
  const t0 = Number(times[0]);
  const t1 = Number(times[times.length - 1]);
  const span = Math.max(1e-8, t1 - t0);
  const x0 = Number(values[0]);
  const z0 = Number(values[2]);
  const x1 = Number(values[(count - 1) * 3]);
  const z1 = Number(values[(count - 1) * 3 + 2]);
  for (let i = 0; i < count; i++) {
    const u = THREE.MathUtils.clamp((Number(times[i]) - t0) / span, 0, 1);
    values[i * 3] -= THREE.MathUtils.lerp(x0, x1, u) - x0;
    values[i * 3 + 2] -= THREE.MathUtils.lerp(z0, z1, u) - z0;
  }
}

function lockHorizontalPosition(values) {
  if (values.length < 3) return;
  const x = Number(values[0]);
  const z = Number(values[2]);
  for (let i = 0; i < values.length; i += 3) {
    values[i] = x;
    values[i + 2] = z;
  }
}

function convertQuaternionTrack(track, sourceBone, targetNodeName, isVrm0) {
  const values = cloneValues(track);
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  sourceBone.getWorldQuaternion(restRotationInverse).invert();
  sourceBone.parent.getWorldQuaternion(parentRestWorldRotation);

  for (let i = 0; i < values.length; i += 4) {
    q.fromArray(values, i);
    q.premultiply(parentRestWorldRotation).multiply(restRotationInverse).normalize();
    q.toArray(values, i);
  }
  if (isVrm0) applyVrm0QuaternionConvention(values);

  return new THREE.QuaternionKeyframeTrack(
    `${targetNodeName}.quaternion`,
    cloneTimes(track),
    values,
    track.getInterpolation(),
  );
}

function convertHipsPositionTrack(track, targetNodeName, scale, isVrm0, rootMode) {
  const times = cloneTimes(track);
  const values = cloneValues(track);
  for (let i = 0; i < values.length; i++) values[i] *= scale;
  if (isVrm0) applyVrm0PositionConvention(values);

  if (rootMode === 'detrend') detrendHorizontalPosition(times, values);
  else if (rootMode === 'lock-horizontal') lockHorizontalPosition(values);
  else if (rootMode !== 'preserve') {
    throw new Error(`Unknown root mode: ${rootMode}. Expected preserve, detrend, or lock-horizontal.`);
  }

  return new THREE.VectorKeyframeTrack(
    `${targetNodeName}.position`,
    times,
    values,
    track.getInterpolation(),
  );
}

export async function parseMixamoFbx(fileOrArrayBuffer) {
  let buffer;
  if (fileOrArrayBuffer instanceof ArrayBuffer) buffer = fileOrArrayBuffer;
  else if (ArrayBuffer.isView(fileOrArrayBuffer)) buffer = fileOrArrayBuffer.buffer;
  else if (fileOrArrayBuffer?.arrayBuffer) buffer = await fileOrArrayBuffer.arrayBuffer();
  else throw new Error('parseMixamoFbx expects a File or ArrayBuffer.');

  const loader = new FBXLoader();
  const asset = loader.parse(buffer, '');
  asset.updateMatrixWorld(true);
  const sourceIndex = buildSourceIndex(asset);

  const requiredSource = [
    'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2',
    'mixamorigLeftArm', 'mixamorigRightArm',
    'mixamorigLeftUpLeg', 'mixamorigRightUpLeg',
  ];
  const missing = requiredSource.filter((name) => !sourceIndex.has(name));
  if (missing.length) {
    throw new Error(`This is not a standard Mixamo humanoid FBX. Missing: ${missing.join(', ')}`);
  }
  if (!asset.animations?.length) throw new Error('FBX loaded, but it has no animation clips.');

  return {
    asset,
    sourceIndex,
    clips: asset.animations.map((clip, index) => ({
      index,
      name: clip.name || `clip_${index}`,
      duration: Number(clip.duration || 0),
      tracks: Number(clip.tracks?.length || 0),
    })),
  };
}

export function createVrmAnimationClipFromMixamo(parsed, vrm, options = {}) {
  if (!parsed?.asset || !parsed?.sourceIndex || !vrm?.humanoid) {
    throw new Error('createVrmAnimationClipFromMixamo received invalid source or VRM.');
  }

  const sourceClip = chooseClip(parsed.asset.animations, options.clip);
  parsed.asset.updateMatrixWorld(true);
  vrm.humanoid.resetNormalizedPose();
  vrm.scene.updateMatrixWorld(true);

  const isVrm0 = vrm.meta?.metaVersion === '0';
  const rootMode = options.rootMode || 'preserve';
  const hipsScale = computeHipsScale(parsed.asset, sourceClip, vrm, parsed.sourceIndex);
  const converted = [];
  const mappedBones = new Set();
  const sourceAnimatedBones = new Set();
  const ignoredTracks = [];
  const missingTargetBones = new Set();

  for (const sourceTrack of sourceClip.tracks) {
    const split = sourceTrack.name.split('.');
    const canonical = canonicalSourceBoneName(split[0]);
    const property = split[1];
    const vrmBoneName = MIXAMO_VRM_MAP[canonical];
    if (!vrmBoneName) {
      ignoredTracks.push(sourceTrack.name);
      continue;
    }

    sourceAnimatedBones.add(vrmBoneName);
    const sourceBone = parsed.sourceIndex.get(canonical);
    const targetBone = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
    if (!sourceBone || !targetBone) {
      missingTargetBones.add(vrmBoneName);
      continue;
    }

    if (sourceTrack instanceof THREE.QuaternionKeyframeTrack && property === 'quaternion') {
      converted.push(convertQuaternionTrack(sourceTrack, sourceBone, targetBone.name, isVrm0));
      mappedBones.add(vrmBoneName);
    } else if (
      sourceTrack instanceof THREE.VectorKeyframeTrack
      && property === 'position'
      && vrmBoneName === 'hips'
    ) {
      converted.push(convertHipsPositionTrack(
        sourceTrack,
        targetBone.name,
        hipsScale.scale,
        isVrm0,
        rootMode,
      ));
      mappedBones.add('hips');
    } else {
      // We intentionally ignore per-limb translations/scales. VRM body
      // proportions must come from the target humanoid; only hips translation
      // is transferable safely.
      ignoredTracks.push(sourceTrack.name);
    }
  }

  const missingCore = REQUIRED_CORE.filter((name) => sourceAnimatedBones.has(name) && !mappedBones.has(name));
  const presentCore = REQUIRED_CORE.filter((name) => mappedBones.has(name));
  const expectedAnimatedCore = REQUIRED_CORE.filter((name) => sourceAnimatedBones.has(name));
  const coreCoverage = expectedAnimatedCore.length
    ? presentCore.length / expectedAnimatedCore.length
    : 0;

  if (!converted.length) throw new Error('No Mixamo tracks could be converted to VRM tracks.');
  if (!mappedBones.has('hips')) throw new Error('Hips were not retargeted. Refusing to render an invalid animation.');
  if (coreCoverage < 0.90 || missingCore.length) {
    throw new Error(`Retarget validation failed. Core coverage ${(coreCoverage * 100).toFixed(1)}%; missing: ${missingCore.join(', ') || 'unknown'}.`);
  }

  const clip = new THREE.AnimationClip(
    `mixamo_clean_${sourceClip.name || 'clip'}`,
    sourceClip.duration,
    converted,
  );
  clip.resetDuration();
  clip.optimize();

  const diagnostics = {
    algorithm: 'pixiv-three-vrm-official-normalized-bone-retarget',
    sourceClip: sourceClip.name || 'unnamed',
    duration: Number(sourceClip.duration || 0),
    sourceTrackCount: Number(sourceClip.tracks.length || 0),
    convertedTrackCount: converted.length,
    mappedBoneCount: mappedBones.size,
    mappedBones: [...mappedBones],
    sourceAnimatedBones: [...sourceAnimatedBones],
    coreCoverage,
    missingCore,
    missingTargetBones: [...missingTargetBones],
    ignoredTracks,
    rootMode,
    vrmVersion: vrm.meta?.metaVersion || 'unknown',
    hipsScale,
  };

  return { clip, diagnostics, sourceClip };
}
