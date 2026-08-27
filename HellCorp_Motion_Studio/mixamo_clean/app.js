import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { parseMixamoFbx, createVrmAnimationClipFromMixamo } from './mixamo_to_vrm.js';

const canvas = document.getElementById('renderCanvas');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.setSize(768, 768, false);

const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 1.7);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2.5, 4.5, 4.0);
scene.add(key);
const fill = new THREE.DirectionalLight(0xdde6ff, 0.8);
fill.position.set(-3.0, 2.0, 2.5);
scene.add(fill);

let currentVrm = null;
let currentVrmFile = null;
let currentParsedFbx = null;
let currentFbxFile = null;
let currentMixer = null;
let currentAction = null;
let currentClip = null;
let currentDiagnostics = null;
let animationBounds = null;
let activeView = 'front';

const VIEW_AZIMUTH = Object.freeze({ front: 0, threequarter: 35, side: 90, back: 180 });

function setStatus(text, bad = false) {
  statusEl.textContent = text;
  statusEl.dataset.bad = bad ? '1' : '0';
}

function safeName(value) {
  return String(value || 'output')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'output';
}

function childDir(parent, name) {
  return parent.getDirectoryHandle(name, { create: true });
}

async function writeBlob(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function writeText(dir, name, text) {
  await writeBlob(dir, name, new Blob([text], { type: 'application/json' }));
}

function canvasBlob(sourceCanvas) {
  return new Promise((resolve, reject) => {
    sourceCanvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Canvas PNG encoding failed.')), 'image/png');
  });
}

function supersampleFor(size) {
  if (size <= 512) return 2.0;
  if (size <= 1024) return 1.5;
  return 1.0;
}

function resetAnimationState() {
  if (currentAction) currentAction.stop();
  if (currentMixer && currentVrm) {
    currentMixer.stopAllAction();
    currentMixer.uncacheRoot(currentVrm.scene);
  }
  currentMixer = null;
  currentAction = null;
  currentClip = null;
  currentDiagnostics = null;
  currentParsedFbx = null;
  currentFbxFile = null;
}

function clearVrm() {
  resetAnimationState();
  if (currentVrm) scene.remove(currentVrm.scene);
  currentVrm = null;
  currentVrmFile = null;
  animationBounds = null;
}

function updateCamera(bounds, view = activeView) {
  if (!bounds || bounds.isEmpty()) return;
  activeView = view;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const azimuth = THREE.MathUtils.degToRad(VIEW_AZIMUTH[view] ?? 0);
  const radius = Math.max(size.y * 3.0, 4.0);

  camera.position.set(
    center.x + Math.sin(azimuth) * radius,
    center.y,
    center.z + Math.cos(azimuth) * radius,
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(center);

  const horizontalSpan = view === 'side'
    ? size.z
    : (view === 'threequarter' ? Math.hypot(size.x, size.z) : size.x);
  const half = Math.max(size.y * 0.56, horizontalSpan * 0.56, 0.6);
  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half;
  camera.near = 0.01;
  camera.far = Math.max(100, radius * 4);
  camera.updateProjectionMatrix();
}

function renderNow() {
  if (currentVrm) currentVrm.scene.updateMatrixWorld(true);
  renderer.render(scene, camera);
}

async function loadVrmFile(file) {
  clearVrm();
  if (!file) throw new Error('VRM file missing.');
  setStatus('Loading VRM...');

  const url = URL.createObjectURL(file);
  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm?.humanoid) throw new Error('The file does not contain a usable VRM humanoid.');

    currentVrm = vrm;
    currentVrmFile = file;

    // Keep the standard three-vrm orientation compatibility for VRM0.
    VRMUtils.rotateVRM0(vrm);
    vrm.humanoid.resetNormalizedPose();
    vrm.expressionManager?.resetValues();
    vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
    scene.add(vrm.scene);
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);

    animationBounds = new THREE.Box3().setFromObject(vrm.scene);
    updateCamera(animationBounds, activeView);
    renderNow();

    const required = [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg',
    ];
    const missing = required.filter((name) => !vrm.humanoid.getNormalizedBoneNode(name));
    if (missing.length) throw new Error(`VRM is missing required humanoid bones: ${missing.join(', ')}`);

    setStatus('VRM ready');
    return {
      file: file.name,
      vrmVersion: vrm.meta?.metaVersion || 'unknown',
      requiredBones: 'OK',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
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

function evaluateAt(time) {
  if (!currentMixer || !currentClip || !currentVrm) throw new Error('Animation is not ready.');
  const duration = Math.max(1e-8, currentClip.duration);
  const t = THREE.MathUtils.clamp(Number(time || 0), 0, Math.max(0, duration - 1e-7));
  currentMixer.setTime(t);

  // dt=0 intentionally disables spring/inertial simulation during validation.
  // The exported body pose is therefore the Mixamo animation itself, not a
  // second animation system layered on top of it.
  currentVrm.update(0);
  currentVrm.scene.updateMatrixWorld(true);
  return t;
}

function computeAnimationBounds(samples = 96) {
  if (!currentVrm || !currentClip) throw new Error('Cannot scan bounds without an animation.');
  const union = new THREE.Box3();
  const duration = currentClip.duration;
  const n = Math.max(8, Math.min(240, Number(samples || 96)));
  for (let i = 0; i < n; i++) {
    const t = duration * (i / n);
    evaluateAt(t);
    union.union(new THREE.Box3().setFromObject(currentVrm.scene));
  }
  evaluateAt(0);
  return union;
}

async function loadFbxFile(file, options = {}) {
  if (!currentVrm) throw new Error('Load the VRM before the Mixamo FBX.');
  if (!file) throw new Error('FBX file missing.');
  resetAnimationState();
  setStatus('Parsing Mixamo FBX...');

  const parsed = await parseMixamoFbx(file);
  const result = createVrmAnimationClipFromMixamo(parsed, currentVrm, {
    clip: options.clip,
    rootMode: options.rootMode || 'preserve',
  });

  assertFiniteClip(result.clip);
  currentParsedFbx = parsed;
  currentFbxFile = file;
  currentClip = result.clip;
  currentDiagnostics = result.diagnostics;

  currentVrm.humanoid.resetNormalizedPose();
  currentVrm.update(0);

  currentMixer = new THREE.AnimationMixer(currentVrm.scene);
  currentAction = currentMixer.clipAction(currentClip);
  currentAction.reset();
  currentAction.enabled = true;
  currentAction.setLoop(THREE.LoopRepeat, Infinity);
  currentAction.play();
  evaluateAt(0);

  animationBounds = computeAnimationBounds(options.boundsSamples || 96);
  updateCamera(animationBounds, options.view || activeView);
  renderNow();

  const report = {
    sourceFile: file.name,
    clips: parsed.clips,
    selected: currentDiagnostics,
    bounds: {
      min: animationBounds.min.toArray(),
      max: animationBounds.max.toArray(),
      size: animationBounds.getSize(new THREE.Vector3()).toArray(),
    },
  };
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('Mixamo animation ready');
  return report;
}

async function renderAnimation(options = {}) {
  if (!currentVrm || !currentClip || !currentMixer) throw new Error('Load VRM and FBX first.');

  const fps = Math.max(1, Number(options.fps || 30));
  const size = Math.max(128, Number(options.size || 768));
  const view = options.view || 'front';
  const start = THREE.MathUtils.clamp(Number(options.start || 0), 0, currentClip.duration);
  const requestedEnd = options.end == null ? currentClip.duration : Number(options.end);
  const end = THREE.MathUtils.clamp(requestedEnd, start + 1 / fps, currentClip.duration);
  const frameCount = Math.max(1, Math.ceil((end - start) * fps));
  const name = safeName(options.name || `${safeName(currentVrmFile?.name)}_${safeName(currentFbxFile?.name)}_${view}`);

  const ss = supersampleFor(size);
  const renderSize = Math.round(size * ss);
  renderer.setSize(renderSize, renderSize, false);
  updateCamera(animationBounds, view);

  const work = document.createElement('canvas');
  work.width = size;
  work.height = size;
  const ctx = work.getContext('2d', { alpha: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const root = await navigator.storage.getDirectory();
  const outDir = await childDir(root, name);
  const framesDir = await childDir(outDir, 'frames');

  for (let i = 0; i < frameCount; i++) {
    const t = Math.min(end - 1e-8, start + i / fps);
    evaluateAt(t);
    renderNow();
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(renderer.domElement, 0, 0, renderSize, renderSize, 0, 0, size, size);
    await writeBlob(framesDir, `frame_${String(i).padStart(6, '0')}.png`, await canvasBlob(work));
    if ((i & 3) === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  const manifest = {
    format: 'HellCorpMixamoCleanV1',
    algorithm: 'official-three-vrm-normalized-bone-retarget',
    character: currentVrmFile?.name || null,
    source_fbx: currentFbxFile?.name || null,
    fps,
    start,
    end,
    duration: end - start,
    source_clip_duration: currentClip.duration,
    frame_count: frameCount,
    frame_size: [size, size],
    supersample: ss,
    view,
    output_name: name,
    spring_simulation: false,
    retarget: currentDiagnostics,
    validation: {
      finite_tracks: true,
      core_coverage: currentDiagnostics?.coreCoverage || 0,
      status: (currentDiagnostics?.coreCoverage || 0) >= 0.90 ? 'PASS' : 'FAIL',
    },
  };
  await writeText(outDir, 'manifest.json', JSON.stringify(manifest, null, 2));

  renderer.setSize(768, 768, false);
  evaluateAt(0);
  updateCamera(animationBounds, view);
  renderNow();
  setStatus(`Render complete: ${name}`);
  return manifest;
}

function applyMToonStyle(style = {}) {
  if (!currentVrm) return { error: 'No VRM loaded' };
  const styled = [];
  currentVrm.scene.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const mat of mats) {
      if (!mat.isMToonMaterial) continue;
      const name = mat.name || '';

      const pick = (table) => {
        if (!table) return undefined;
        const key = Object.keys(table).find((k) => k !== '*' && name.includes(k));
        return key ? table[key] : table['*'];
      };

      if (style.outlineWidthMode) mat.outlineWidthMode = style.outlineWidthMode;
      const width = pick(style.outlineWidthFactor);
      if (width != null) mat.outlineWidthFactor = width;
      if (style.outlineColorFactor) mat.outlineColorFactor = new THREE.Color(...style.outlineColorFactor);

      const toony = pick(style.toony);
      if (toony != null) mat.shadingToonyFactor = toony;

      const shift = pick(style.shadingShift);
      if (shift != null) mat.shadingShiftFactor = shift;

      const recolor = pick(style.recolor);
      if (recolor) mat.color = new THREE.Color(...recolor);

      // Multiplicative tint (litFactor * map) cannot lighten a dark baked texture
      // (e.g. near-black hair) into a light color, since the product stays <= the
      // texture's own value. flatRecolor drops the diffuse map so litFactor is the
      // whole story.
      const flatRecolor = pick(style.flatRecolor);
      if (flatRecolor) {
        mat.map = null;
        mat.shadeMultiplyTexture = null;
        mat.color = new THREE.Color(...flatRecolor);
      }

      mat.needsUpdate = true;
      styled.push({ name, color: mat.color?.getHexString?.() });
    }
  });
  renderNow();
  return { materialsStyled: styled };
}

window.__applyMToonStyle = applyMToonStyle;

function loadTextureFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = () => reject(new Error('Failed to decode swapped texture image.'));
    img.src = dataUrl;
  });
}

async function swapMaterialTexture(nameSubstring, dataUrl) {
  if (!currentVrm) return { error: 'No VRM loaded' };
  const tex = await loadTextureFromDataUrl(dataUrl);
  let count = 0;
  currentVrm.scene.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const mat of mats) {
      if (!mat.isMToonMaterial || !(mat.name || '').includes(nameSubstring)) continue;
      mat.map = tex;
      // The shadow-side color also samples its own multiply texture (the original
      // baked-dark diffuse); leaving it in place would tint shaded areas back
      // toward the old hue, so it must be cleared along with the lit-side map.
      mat.shadeMultiplyTexture = null;
      mat.needsUpdate = true;
      count++;
    }
  });
  renderNow();
  return { swapped: count };
}

window.__swapMaterialTexture = swapMaterialTexture;

function solveAffine(p0, p1, p2, q0, q1, q2) {
  // Solve M such that M * pi = qi, for i in {0,1,2}, as a 2D affine map
  // (2x3 matrix [a c e; b d f]) — this is exactly the matrix CanvasRenderingContext2D.setTransform expects.
  const [x0, y0] = p0, [x1, y1] = p1, [x2, y2] = p2;
  const det = x0 * (y1 - y2) - y0 * (x1 - x2) + (x1 * y2 - x2 * y1);
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;

  function solveRow(v0, v1, v2) {
    // Cramer's rule for [k0,k1,k2] such that v_i = k0*x_i + k1*y_i + k2
    const k0 = invDet * (v0 * (y1 - y2) - y0 * (v1 - v2) + (v1 * y2 - v2 * y1));
    const k1 = invDet * (x0 * (v1 - v2) - v0 * (x1 - x2) + (x1 * v2 - x2 * v1));
    const k2 = invDet * (x0 * (y1 * v2 - y2 * v1) - y0 * (x1 * v2 - x2 * v1) + (x1 * y2 - x2 * y1) * v0);
    return [k0, k1, k2];
  }

  const [a, c, e] = solveRow(q0[0], q1[0], q2[0]);
  const [b, d, f] = solveRow(q0[1], q1[1], q2[1]);
  return [a, b, c, d, e, f];
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode reference image.'));
    img.src = dataUrl;
  });
}

// Projects the current (posed, skinned) 3D geometry of every mesh into its own UV
// layout and, per triangle, affine-warps the matching patch of a single fixed
// reference image (aligned to a front orthographic view) onto it. Because the
// front camera is orthographic, world->screen is itself affine, so composing it
// with the reference-image alignment transform is exact per triangle — no
// per-frame re-projection is involved. This runs once, at a single bake pose;
// the resulting textures are ordinary UV textures from then on and deform with
// the skeleton like any other painted texture.
async function bakeProjectedTexture(options) {
  if (!currentVrm) return { error: 'No VRM loaded' };
  const {
    refImageDataUrl, canvasSize, align, bakeSize = 1024, nameFilter = null,
    cullSign = 1, // sign of (r1-r0)x(r2-r0) that means "facing away from camera" — flip if the bake comes out back-to-front
  } = options;
  const refImg = await loadImage(refImageDataUrl);

  updateCamera(animationBounds, 'front');
  currentVrm.scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  const meshes = [];
  currentVrm.scene.traverse((obj) => {
    if (obj.isSkinnedMesh && obj.geometry?.attributes?.uv) {
      if (!nameFilter || obj.name.includes(nameFilter) || (obj.material?.name || '').includes(nameFilter)) {
        meshes.push(obj);
      }
    }
  });

  const results = {};
  const tmp = new THREE.Vector3();

  for (const mesh of meshes) {
    const geom = mesh.geometry;
    const uvAttr = geom.attributes.uv;
    const posAttr = geom.attributes.position;
    const index = geom.index;
    const vertexCount = posAttr.count;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geom.groups && geom.groups.length ? geom.groups : [{ start: 0, count: (index ? index.count : vertexCount), materialIndex: 0 }];

    const refPixels = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      mesh.getVertexPosition(i, tmp);
      tmp.applyMatrix4(mesh.matrixWorld);
      const ndc = tmp.clone().project(camera);
      const px = (ndc.x * 0.5 + 0.5) * canvasSize;
      const py = (1 - (ndc.y * 0.5 + 0.5)) * canvasSize;
      refPixels[i] = [(px - align.pasteX) / align.scale, (py - align.pasteY) / align.scale];
    }

    const getIdx = index ? (k) => index.getX(k) : (k) => k;
    const margin = 40;

    for (const group of groups) {
      const mat = materials[group.materialIndex] || materials[0];
      if (!mat?.isMToonMaterial) continue;
      const size = mat.map?.image ? Math.max(mat.map.image.width, mat.map.image.height) : bakeSize;

      const bakeCanvas = document.createElement('canvas');
      bakeCanvas.width = size;
      bakeCanvas.height = size;
      const ctx = bakeCanvas.getContext('2d');
      // Fallback base layer: the original texture, so triangles the projector
      // never sees (back-facing, or outside the reference photo's frame) keep
      // their original look instead of turning transparent/black.
      if (mat.map?.image) ctx.drawImage(mat.map.image, 0, 0, size, size);
      let drawn = 0;
      const triStart = Math.floor(group.start / 3);
      const triEnd = Math.floor((group.start + group.count) / 3);

      for (let t = triStart; t < triEnd; t++) {
        const i0 = getIdx(t * 3), i1 = getIdx(t * 3 + 1), i2 = getIdx(t * 3 + 2);
        const u0 = uvAttr.getX(i0) * size, v0 = (1 - uvAttr.getY(i0)) * size;
        const u1 = uvAttr.getX(i1) * size, v1 = (1 - uvAttr.getY(i1)) * size;
        const u2 = uvAttr.getX(i2) * size, v2 = (1 - uvAttr.getY(i2)) * size;

        const r0 = refPixels[i0], r1 = refPixels[i1], r2 = refPixels[i2];
        const within = (p) => p[0] > -margin && p[0] < refImg.width + margin && p[1] > -margin && p[1] < refImg.height + margin;
        if (!within(r0) || !within(r1) || !within(r2)) continue;

        const signedArea = (r1[0] - r0[0]) * (r2[1] - r0[1]) - (r2[0] - r0[0]) * (r1[1] - r0[1]);
        if (Math.sign(signedArea) === Math.sign(cullSign)) continue; // back-facing relative to the projector

        const affine = solveAffine(r0, r1, r2, [u0, v0], [u1, v1], [u2, v2]);
        if (!affine) continue;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(u0, v0);
        ctx.lineTo(u1, v1);
        ctx.lineTo(u2, v2);
        ctx.closePath();
        ctx.clip();
        ctx.setTransform(...affine);
        ctx.drawImage(refImg, 0, 0);
        ctx.restore();
        drawn++;
      }

      results[mat.name] = {
        meshName: mesh.name,
        dataUrl: bakeCanvas.toDataURL('image/png'),
        triangles: triEnd - triStart,
        drawn,
      };
    }
  }

  renderNow();
  return results;
}

window.__bakeProjectedTexture = bakeProjectedTexture;

window.__mixamoClean = {
  loadVrmFile,
  loadFbxFile,
  renderAnimation,
  getState() {
    return {
      vrm: currentVrmFile?.name || null,
      fbx: currentFbxFile?.name || null,
      clip: currentClip?.name || null,
      diagnostics: currentDiagnostics,
    };
  },
};

const vrmInput = document.getElementById('vrmInput');
const fbxInput = document.getElementById('fbxInput');
vrmInput.addEventListener('change', async () => {
  try { await loadVrmFile(vrmInput.files?.[0]); } catch (e) { setStatus(e.message || String(e), true); console.error(e); }
});
fbxInput.addEventListener('change', async () => {
  try { await loadFbxFile(fbxInput.files?.[0], { rootMode: 'preserve' }); } catch (e) { setStatus(e.message || String(e), true); console.error(e); }
});
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    if (!animationBounds) return;
    updateCamera(animationBounds, button.dataset.view);
    renderNow();
  });
}

setStatus('Ready');
