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
