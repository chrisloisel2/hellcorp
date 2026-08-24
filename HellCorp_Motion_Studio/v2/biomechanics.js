// HellCorp Motion Studio V2 - deterministic biomechanical preprocessing.
// Pure functions: no Three.js dependency, deterministic for identical input.

const DEFAULTS = Object.freeze({
  minContactFrames: 2,
  contactVelocity: 0.055,
  contactHeightSlack: 0.045,
  pelvisFollow: 0.72,
  pelvisSway: 0.16,
  pelvisBob: 0.10,
  shoulderCounter: 0.20,
  rootScaleXZ: 0.55,
  rootScaleY: 0.28,
  maxRootStep: 0.08,
  kneeClamp: 2.75,
});

const L = Object.freeze({
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftToe: 31, rightToe: 32,
  leftShoulder: 11, rightShoulder: 12,
});

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function p(lm, i) { return lm && lm[i] ? lm[i] : null; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function mul(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function mid(a, b) { return mul(add(a, b), 0.5); }
function len(a) { return Math.hypot(a.x, a.y, a.z); }
function dist(a, b) { return len(sub(a, b)); }

function safeMid(lm, ia, ib) {
  const a = p(lm, ia), b = p(lm, ib);
  return a && b ? mid(a, b) : null;
}

function footPoint(lm, side) {
  const ankle = p(lm, side === 'left' ? L.leftAnkle : L.rightAnkle);
  const heel = p(lm, side === 'left' ? L.leftHeel : L.rightHeel);
  const toe = p(lm, side === 'left' ? L.leftToe : L.rightToe);
  if (!ankle) return null;
  let out = { ...ankle };
  let n = 1;
  if (heel) { out = add(out, heel); n++; }
  if (toe) { out = add(out, toe); n++; }
  return mul(out, 1 / n);
}

function angle3(a, b, c) {
  if (!a || !b || !c) return Math.PI;
  const u = sub(a, b), v = sub(c, b);
  const lu = len(u), lv = len(v);
  if (lu < 1e-6 || lv < 1e-6) return Math.PI;
  const d = clamp((u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv), -1, 1);
  return Math.acos(d);
}

function smoothScalar(values, radius = 2) {
  return values.map((_, i) => {
    let acc = 0, wsum = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      const w = radius + 1 - Math.abs(i - j);
      acc += values[j] * w; wsum += w;
    }
    return acc / Math.max(wsum, 1);
  });
}

function normalizeLandmarkFrame(lm) {
  if (!lm?.length) return null;
  // MediaPipe world landmarks: Y grows up/down according to model convention.
  // We keep coordinates untouched here and only use relative distances/velocities.
  return lm.map((q) => q ? ({ x: Number(q.x || 0), y: Number(q.y || 0), z: Number(q.z || 0), visibility: Number(q.visibility ?? 1) }) : null);
}

function inferGround(frames) {
  const ys = [];
  for (const f of frames) {
    const lm = f.landmarks;
    for (const side of ['left', 'right']) {
      const fp = footPoint(lm, side);
      if (fp) ys.push(fp.y);
    }
  }
  if (!ys.length) return 0;
  ys.sort((a, b) => b - a); // MediaPipe body world Y generally lower on screen/body => larger Y.
  const n = Math.max(1, Math.floor(ys.length * 0.12));
  return ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
}

function buildContacts(frames, fps, opts) {
  const ground = inferGround(frames);
  const out = { left: [], right: [] };
  for (const side of ['left', 'right']) {
    let prev = null;
    let streak = 0;
    for (let i = 0; i < frames.length; i++) {
      const fp = footPoint(frames[i].landmarks, side);
      let velocity = Infinity;
      if (fp && prev) velocity = dist(fp, prev) * fps;
      const heightOk = fp ? Math.abs(ground - fp.y) <= opts.contactHeightSlack : false;
      const candidate = !!fp && velocity <= opts.contactVelocity && heightOk;
      streak = candidate ? streak + 1 : 0;
      out[side][i] = streak >= opts.minContactFrames;
      prev = fp;
    }
    // Fill one-frame holes in otherwise stable contacts.
    for (let i = 1; i < out[side].length - 1; i++) {
      if (!out[side][i] && out[side][i - 1] && out[side][i + 1]) out[side][i] = true;
    }
  }
  return { ...out, ground };
}

function computeBodyMeasures(frames) {
  const pelvis = [], shoulders = [], stance = [], kneeL = [], kneeR = [];
  for (const f of frames) {
    const lm = f.landmarks;
    const ph = safeMid(lm, L.leftHip, L.rightHip) || { x: 0, y: 0, z: 0 };
    const sh = safeMid(lm, L.leftShoulder, L.rightShoulder) || ph;
    pelvis.push(ph); shoulders.push(sh);
    const lf = footPoint(lm, 'left'), rf = footPoint(lm, 'right');
    stance.push(lf && rf ? dist(lf, rf) : 0);
    kneeL.push(angle3(p(lm, L.leftHip), p(lm, L.leftKnee), p(lm, L.leftAnkle)));
    kneeR.push(angle3(p(lm, L.rightHip), p(lm, L.rightKnee), p(lm, L.rightAnkle)));
  }
  return { pelvis, shoulders, stance, kneeL, kneeR };
}

function stabilizeRoot(frames, measures, contacts, fps, opts) {
  const roots = [];
  const firstPelvis = measures.pelvis[0] || { x: 0, y: 0, z: 0 };
  let root = { x: 0, y: 0, z: 0 };
  let leftAnchor = null, rightAnchor = null;

  for (let i = 0; i < frames.length; i++) {
    const lm = frames[i].landmarks;
    const pelvis = measures.pelvis[i];
    const lf = footPoint(lm, 'left'), rf = footPoint(lm, 'right');
    if (contacts.left[i] && !leftAnchor && lf) leftAnchor = { ...lf };
    if (!contacts.left[i]) leftAnchor = null;
    if (contacts.right[i] && !rightAnchor && rf) rightAnchor = { ...rf };
    if (!contacts.right[i]) rightAnchor = null;

    const raw = {
      x: (pelvis.x - firstPelvis.x) * opts.rootScaleXZ,
      y: (pelvis.y - firstPelvis.y) * opts.rootScaleY,
      z: (pelvis.z - firstPelvis.z) * opts.rootScaleXZ,
    };

    // Contact constraint: when a foot is planted, move root opposite to detected foot drift.
    const corrections = [];
    if (leftAnchor && lf) corrections.push(sub(leftAnchor, lf));
    if (rightAnchor && rf) corrections.push(sub(rightAnchor, rf));
    let correction = { x: 0, y: 0, z: 0 };
    if (corrections.length) {
      correction = corrections.reduce((a, b) => add(a, b), correction);
      correction = mul(correction, 1 / corrections.length);
    }
    const target = {
      x: raw.x + correction.x * opts.pelvisFollow,
      y: raw.y + correction.y * opts.pelvisFollow,
      z: raw.z + correction.z * opts.pelvisFollow,
    };
    const dx = clamp(target.x - root.x, -opts.maxRootStep, opts.maxRootStep);
    const dy = clamp(target.y - root.y, -opts.maxRootStep, opts.maxRootStep);
    const dz = clamp(target.z - root.z, -opts.maxRootStep, opts.maxRootStep);
    root = { x: root.x + dx, y: root.y + dy, z: root.z + dz };
    roots.push({ ...root });
  }

  for (const axis of ['x', 'y', 'z']) {
    const s = smoothScalar(roots.map((r) => r[axis]), 2);
    for (let i = 0; i < roots.length; i++) roots[i][axis] = s[i];
  }
  return roots;
}

function applyRigCorrections(frame, i, measures, contacts, roots, opts) {
  const out = clone(frame);
  if (!out?.rig) return out;
  const r = out.rig;
  const lm = frame.landmarks;

  r.Hips = r.Hips || {};
  r.Hips.position = { ...(r.Hips.position || {}), ...roots[i] };
  r.Hips.rotation = r.Hips.rotation || { x: 0, y: 0, z: 0, rotationOrder: 'XYZ' };

  const lh = p(lm, L.leftHip), rh = p(lm, L.rightHip);
  const ls = p(lm, L.leftShoulder), rs = p(lm, L.rightShoulder);
  if (lh && rh) {
    const hipRoll = Math.atan2(rh.y - lh.y, Math.hypot(rh.x - lh.x, rh.z - lh.z));
    r.Hips.rotation.z = lerp(Number(r.Hips.rotation.z || 0), hipRoll, opts.pelvisSway);
  }
  if (ls && rs && lh && rh) {
    const shoulderRoll = Math.atan2(rs.y - ls.y, Math.hypot(rs.x - ls.x, rs.z - ls.z));
    const hipRoll = Math.atan2(rh.y - lh.y, Math.hypot(rh.x - lh.x, rh.z - lh.z));
    r.Spine = r.Spine || { x: 0, y: 0, z: 0, rotationOrder: 'XYZ' };
    r.Spine.z = lerp(Number(r.Spine.z || 0), shoulderRoll - hipRoll * 0.5, opts.shoulderCounter);
  }

  // Planting bias: avoid fully straight robotic knees during stance while preserving source motion.
  const lContact = contacts.left[i], rContact = contacts.right[i];
  if (lContact && r.LeftLowerLeg) r.LeftLowerLeg.x = clamp(Number(r.LeftLowerLeg.x || 0), -opts.kneeClamp, opts.kneeClamp);
  if (rContact && r.RightLowerLeg) r.RightLowerLeg.x = clamp(Number(r.RightLowerLeg.x || 0), -opts.kneeClamp, opts.kneeClamp);

  out.biomech = {
    root: roots[i],
    contactLeft: lContact,
    contactRight: rContact,
    kneeAngleLeft: measures.kneeL[i],
    kneeAngleRight: measures.kneeR[i],
    stanceWidth: measures.stance[i],
  };
  return out;
}

export function processBiomechanicalFrames(inputFrames, fps, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const frames = inputFrames.map((f) => ({ ...clone(f), landmarks: normalizeLandmarkFrame(f.landmarks) }));
  if (!frames.some((f) => f.landmarks?.length)) return inputFrames.map(clone);
  const contacts = buildContacts(frames, fps, opts);
  const measures = computeBodyMeasures(frames);
  const roots = stabilizeRoot(frames, measures, contacts, fps, opts);
  return frames.map((f, i) => applyRigCorrections(f, i, measures, contacts, roots, opts));
}

export function biomechanicsSummary(frames) {
  if (!frames?.length) return { frames: 0 };
  let left = 0, right = 0, both = 0;
  for (const f of frames) {
    if (f.biomech?.contactLeft) left++;
    if (f.biomech?.contactRight) right++;
    if (f.biomech?.contactLeft && f.biomech?.contactRight) both++;
  }
  return { frames: frames.length, leftContactFrames: left, rightContactFrames: right, doubleSupportFrames: both };
}
