const EPSILON = 1e-8;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function angleBetween(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function shortestAngleDelta(from, to) {
  let d = (to - from + Math.PI) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d - Math.PI;
}

export function lerpAngle(from, to, t) {
  return from + shortestAngleDelta(from, to) * t;
}

export function normalizedJoint(frame, name) {
  const joint = frame?.joints?.[name];
  if (!joint || !Number.isFinite(joint.x) || !Number.isFinite(joint.y)) {
    throw new Error(`Missing or invalid joint: ${name}`);
  }
  return joint;
}

const BONE_ENDPOINTS = {
  pelvis: ['hip_l', 'hip_r'],
  spine: ['pelvis', 'chest'],
  chest: ['chest', 'neck'],
  neck: ['neck', 'head'],
  head: ['neck', 'head'],
  upper_arm_l: ['shoulder_l', 'elbow_l'],
  forearm_l: ['elbow_l', 'wrist_l'],
  hand_l: ['wrist_l', 'hand_l'],
  upper_arm_r: ['shoulder_r', 'elbow_r'],
  forearm_r: ['elbow_r', 'wrist_r'],
  hand_r: ['wrist_r', 'hand_r'],
  thigh_l: ['hip_l', 'knee_l'],
  calf_l: ['knee_l', 'ankle_l'],
  foot_l: ['ankle_l', 'toe_l'],
  thigh_r: ['hip_r', 'knee_r'],
  calf_r: ['knee_r', 'ankle_r'],
  foot_r: ['ankle_r', 'toe_r'],
};

function derivedJoint(frame, name) {
  if (name === 'pelvis') {
    const l = normalizedJoint(frame, 'hip_l');
    const r = normalizedJoint(frame, 'hip_r');
    return { x: (l.x + r.x) * 0.5, y: (l.y + r.y) * 0.5, z: ((l.z || 0) + (r.z || 0)) * 0.5 };
  }
  if (name === 'chest') {
    const l = normalizedJoint(frame, 'shoulder_l');
    const r = normalizedJoint(frame, 'shoulder_r');
    return { x: (l.x + r.x) * 0.5, y: (l.y + r.y) * 0.5, z: ((l.z || 0) + (r.z || 0)) * 0.5 };
  }
  return normalizedJoint(frame, name);
}

export function solveRigFrame(frame, rig, previous = null) {
  const result = {
    time: frame.time || 0,
    bones: {},
    root: { x: 0, y: 0 },
  };

  const pelvis = derivedJoint(frame, 'pelvis');
  const restPelvis = rig.rest_pose?.pelvis || { x: 0.5, y: 0.6 };
  result.root.x = pelvis.x - restPelvis.x;
  result.root.y = pelvis.y - restPelvis.y;

  const smoothing = clamp(rig.motion?.angle_smoothing ?? 0.35, 0, 0.95);
  const maxJump = (rig.motion?.max_angle_jump_deg ?? 55) * Math.PI / 180;

  for (const [boneName, endpoints] of Object.entries(BONE_ENDPOINTS)) {
    if (!rig.bones?.[boneName]) continue;

    const a = derivedJoint(frame, endpoints[0]);
    const b = derivedJoint(frame, endpoints[1]);
    let angle = angleBetween(a, b);

    const restAngle = rig.bones[boneName].rest_angle_rad || 0;
    angle -= restAngle;

    const prevAngle = previous?.bones?.[boneName]?.angle;
    if (Number.isFinite(prevAngle)) {
      const delta = shortestAngleDelta(prevAngle, angle);
      if (Math.abs(delta) > maxJump) {
        angle = prevAngle + Math.sign(delta) * maxJump;
      }
      angle = lerpAngle(prevAngle, angle, 1 - smoothing);
    }

    const limits = rig.bones[boneName].limits_deg;
    if (limits) {
      angle = clamp(angle, limits[0] * Math.PI / 180, limits[1] * Math.PI / 180);
    }

    result.bones[boneName] = {
      angle,
      length: Math.max(EPSILON, distance(a, b)),
      depth: ((a.z || 0) + (b.z || 0)) * 0.5,
    };
  }

  return result;
}

export function solveClip(frames, rig) {
  const solved = [];
  let previous = null;
  for (const frame of frames) {
    const current = solveRigFrame(frame, rig, previous);
    solved.push(current);
    previous = current;
  }
  return solved;
}
