import { createAuthoredRuntime, authoredClipSummary } from './v3/authored_animation.js';
import { auditAuthoredRuntime } from './v3/quality_audit.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  VRMLoaderPlugin,
  VRMUtils,
} from '@pixiv/three-vrm';
import {
  FilesetResolver,
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
import {
  Pose as KalidoPose,
  Face as KalidoFace,
  Hand as KalidoHand,
} from 'https://cdn.jsdelivr.net/npm/kalidokit@1.1.5/dist/kalidokit.es.js';

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FINGER_DIGITS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];

// Facteur de supersampling pour l'export (rendu plus grand puis reduit =
// bien meilleures diagonales/cheveux/contours qu'un rendu direct a la taille cible).
// Degresse avec la taille cible pour eviter des render targets demesures (VRAM/temps)
// a 1920/4K, ou la densite de pixels native rend le supersampling moins necessaire.
function supersampleFor(size) {
  if (size <= 512) return 3;
  if (size <= 1024) return 2;
  if (size <= 2048) return 1.5;
  return 1;
}

const PASSTHROUGH_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Contours geometriques (depth+normal edge detection, stables frame a frame
// car bases sur la geometrie et non sur l'image finale) + AO approximee bon
// marche (cavite basee sur les memes echantillons de profondeur voisins).
const OutlineAOShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    texelSize: { value: new THREE.Vector2(1, 1) },
    depthThreshold: { value: 0.01 },
    normalThreshold: { value: 0.35 },
    outlineColor: { value: new THREE.Color(0x050308) },
    outlineThickness: { value: 2.2 },
    aoStrength: { value: 0.18 },
    rimColor: { value: new THREE.Color(0xfff2cc) },
    rimStrength: { value: 0.35 },
  },
  vertexShader: PASSTHROUGH_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 texelSize;
    uniform float depthThreshold;
    uniform float normalThreshold;
    uniform vec3 outlineColor;
    uniform float outlineThickness;
    uniform float aoStrength;
    uniform vec3 rimColor;
    uniform float rimStrength;
    varying vec2 vUv;
    float getDepth(vec2 uv) { return texture2D(tDepth, uv).r; }
    vec3 getNormal(vec2 uv) { return normalize(texture2D(tNormal, uv).rgb * 2.0 - 1.0); }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      if (color.a < 0.001) { gl_FragColor = color; return; }
      vec2 o = texelSize * outlineThickness;
      float dC = getDepth(vUv);
      float dL = getDepth(vUv - vec2(o.x, 0.0));
      float dR = getDepth(vUv + vec2(o.x, 0.0));
      float dT = getDepth(vUv + vec2(0.0, o.y));
      float dB = getDepth(vUv - vec2(0.0, o.y));
      float depthEdge = abs(dL - dR) + abs(dT - dB);

      vec3 nC = getNormal(vUv);
      vec3 nL = getNormal(vUv - vec2(o.x, 0.0));
      vec3 nR = getNormal(vUv + vec2(o.x, 0.0));
      vec3 nT = getNormal(vUv + vec2(0.0, o.y));
      vec3 nB = getNormal(vUv - vec2(0.0, o.y));
      float normalEdge = (1.0 - dot(nC, nL)) + (1.0 - dot(nC, nR)) + (1.0 - dot(nC, nT)) + (1.0 - dot(nC, nB));

      float edge = clamp(step(depthThreshold, depthEdge) + step(normalThreshold, normalEdge), 0.0, 1.0);
      float cavity = clamp(depthEdge / max(depthThreshold, 1e-6) * 0.35, 0.0, 1.0) * aoStrength;
      vec3 shaded = color.rgb * (1.0 - cavity);

      // Rim light : bord du modele en incidence rasante (normale ~perpendiculaire
      // a la camera), typique du rendu manga/anime peint.
      float rim = smoothstep(0.55, 0.9, 1.0 - abs(nC.z));
      shaded += rimColor * rim * rimStrength;

      vec3 outColor = mix(shaded, outlineColor, edge);
      gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), color.a);
    }
  `,
};

// Banding de la luminance (LIGHT/MID/SHADOW/DEEP SHADOW) en preservant la
// teinte, pour un rendu cel-shade plus tranche que le degrade continu MToon.
const ToonBandShader = {
  uniforms: { tDiffuse: { value: null }, bands: { value: 4.0 }, contrast: { value: 1.6 } },
  vertexShader: PASSTHROUGH_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float bands;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (c.a < 0.001) { gl_FragColor = c; return; }
      float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      // Ecarte la luminance de son point milieu avant de quantifier : les
      // faibles variations de MToon (gradient doux) donnent alors des paliers
      // francs au lieu d'un banding a peine visible.
      float pushed = clamp((lum - 0.5) * contrast + 0.5, 0.0, 1.0);
      float banded = floor(pushed * bands + 0.5) / bands;
      float scale = banded / max(lum, 0.02);
      gl_FragColor = vec4(clamp(c.rgb * scale, 0.0, 1.0), c.a);
    }
  `,
};

// Etalonnage parametrique (ombres froides, hautes lumieres cremes, peau
// chaude, rouges plus satures) : LUT "HellCorp" approximee sans texture externe.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    shadowTint: { value: new THREE.Color(0x1a1428) },
    highlightTint: { value: new THREE.Color(0xfff2df) },
    skinWarmth: { value: 0.06 },
    redBoost: { value: 0.12 },
    liftShadow: { value: 0.06 },
    saturation: { value: 1.35 },
  },
  vertexShader: PASSTHROUGH_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3 shadowTint;
    uniform vec3 highlightTint;
    uniform float skinWarmth;
    uniform float redBoost;
    uniform float liftShadow;
    uniform float saturation;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (c.a < 0.001) { gl_FragColor = c; return; }
      float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      vec3 col = c.rgb;
      col = mix(col, col * shadowTint * 2.0, (1.0 - smoothstep(0.0, 0.5, lum)) * liftShadow);
      col = mix(col, col * highlightTint, smoothstep(0.65, 1.0, lum) * 0.35);
      float isSkinish = smoothstep(0.15, 0.55, lum) * (1.0 - smoothstep(0.85, 1.0, lum));
      col += vec3(skinWarmth, skinWarmth * 0.55, 0.0) * isSkinish * 0.5;
      float redness = max(col.r - max(col.g, col.b), 0.0);
      col += vec3(redBoost, 0.0, 0.0) * redness;
      // Sature davantage pour un rendu plus graphique/imprime, moins "photo 3D".
      float gray = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(gray), col, saturation);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }
  `,
};

// Unsharp mask tres leger sur l'image finale (yeux/bouche/line-art/cheveux).
const SharpenShader = {
  uniforms: { tDiffuse: { value: null }, texelSize: { value: new THREE.Vector2(1, 1) }, amount: { value: 0.25 } },
  vertexShader: PASSTHROUGH_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 texelSize;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (c.a < 0.001) { gl_FragColor = c; return; }
      vec4 blur = (
        texture2D(tDiffuse, vUv + vec2(texelSize.x, 0.0)) +
        texture2D(tDiffuse, vUv - vec2(texelSize.x, 0.0)) +
        texture2D(tDiffuse, vUv + vec2(0.0, texelSize.y)) +
        texture2D(tDiffuse, vUv - vec2(0.0, texelSize.y))
      ) * 0.25;
      vec3 sharpened = c.rgb + (c.rgb - blur.rgb) * amount;
      gl_FragColor = vec4(clamp(sharpened, 0.0, 1.0), c.a);
    }
  `,
};

let postFX = null;

function setupPostFX(renderSize) {
  if (postFX && postFX.size === renderSize) return postFX;
  if (postFX) {
    postFX.composer.dispose();
    postFX.depthNormalTarget.dispose();
  }
  const depthTexture = new THREE.DepthTexture(renderSize, renderSize);
  const depthNormalTarget = new THREE.WebGLRenderTarget(renderSize, renderSize, { depthTexture, depthBuffer: true });
  const normalMaterial = new THREE.MeshNormalMaterial();

  const composer = new EffectComposer(renderer);
  composer.setSize(renderSize, renderSize);
  composer.addPass(new RenderPass(scene, camera));

  const outlinePass = new ShaderPass(OutlineAOShader);
  outlinePass.uniforms.texelSize.value.set(1 / renderSize, 1 / renderSize);
  composer.addPass(outlinePass);

  const toonPass = new ShaderPass(ToonBandShader);
  composer.addPass(toonPass);

  composer.addPass(new SMAAPass());
  composer.addPass(new OutputPass());

  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  const sharpenPass = new ShaderPass(SharpenShader);
  sharpenPass.uniforms.texelSize.value.set(1 / renderSize, 1 / renderSize);
  composer.addPass(sharpenPass);

  postFX = { composer, outlinePass, toonPass, gradePass, sharpenPass, depthNormalTarget, normalMaterial, size: renderSize };
  return postFX;
}

function renderScenePostFX(dt, renderSize) {
  const fx = setupPostFX(renderSize);
  if (currentVrm) currentVrm.update(dt);

  const prevOverride = scene.overrideMaterial;
  const prevTarget = renderer.getRenderTarget();
  scene.overrideMaterial = fx.normalMaterial;
  renderer.setRenderTarget(fx.depthNormalTarget);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = prevOverride;
  renderer.setRenderTarget(prevTarget);

  fx.outlinePass.uniforms.tNormal.value = fx.depthNormalTarget.texture;
  fx.outlinePass.uniforms.tDepth.value = fx.depthNormalTarget.depthTexture;
  const depthWorldSpan = 0.015; // ~1.5cm de sensibilite aux contours, en unites monde
  fx.outlinePass.uniforms.depthThreshold.value = depthWorldSpan / Math.max(0.001, camera.far - camera.near);

  fx.composer.render();
}

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), log: $('log'), progress: $('progress'), progressText: $('progressText'),
  vrmInput: $('vrmInput'), vrmName: $('vrmName'), vrmInfo: $('vrmInfo'),
  bodyFolder: $('bodyFolder'), faceFolder: $('faceFolder'), bodyCount: $('bodyCount'), faceCount: $('faceCount'),
  bodySelect: $('bodySelect'), faceSelect: $('faceSelect'), bodyFps: $('bodyFps'), faceFps: $('faceFps'),
  faceMode: $('faceMode'), outputFpsMode: $('outputFpsMode'), customFpsWrap: $('customFpsWrap'), customFps: $('customFps'),
  sizeSelect: $('sizeSelect'), bodyStrength: $('bodyStrength'), faceStrength: $('faceStrength'),
  individualFrames: $('individualFrames'), atlasFrames: $('atlasFrames'), lockRoot: $('lockRoot'), posterize: $('posterize'),
  analyzeBtn: $('analyzeBtn'), renderBtn: $('renderBtn'), batchBtn: $('batchBtn'),
  renderCanvas: $('renderCanvas'), workCanvas: $('workCanvas'), dropHint: $('dropHint'),
  bodyVideo: $('bodyVideo'), faceVideo: $('faceVideo'),
};

let bodyFiles = [];
let faceFiles = [];
let currentVrm = null;
let currentVrmFile = null;
let currentMotion = null;
let poseLandmarker = null;
let faceLandmarker = null;
let handLandmarker = null;
let visionReady = false;
let bodyTimestampBase = 0;
let faceTimestampBase = 0;
let previewView = 'front';
let modelFrame = { center: new THREE.Vector3(0, 1, 0), height: 2, width: 1, depth: 1 };

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
const renderer = new THREE.WebGLRenderer({
  canvas: els.renderCanvas,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(1);
renderer.setSize(768, 768, false);

const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 2.0);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.8);
key.position.set(2.5, 4.5, 3.5);
scene.add(key);
const fill = new THREE.DirectionalLight(0xcdd8ff, 1.2);
fill.position.set(-3, 2.5, 2);
scene.add(fill);

function setStatus(text, bad = false) {
  els.status.textContent = text;
  els.status.style.color = bad ? '#ff7788' : '';
}
function log(text) {
  const now = new Date().toLocaleTimeString();
  els.log.textContent += `[${now}] ${text}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}
function setProgress(value, text) {
  els.progress.value = Math.max(0, Math.min(1, value));
  els.progressText.textContent = text;
}
function clamp(v, a = 0, b = 1) { return Math.max(a, Math.min(b, v)); }
function safeName(name) {
  return (name || 'clip').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'clip';
}
function stem(file) { return safeName(file?.name || ''); }
function isVideo(file) { return !!file && (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name)); }
function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function initVision() {
  if (visionReady) return;
  setStatus('Chargement MediaPipe...');
  log('Chargement des modeles de tracking MediaPipe. Les videos restent traitees localement dans le navigateur.');
  const vision = await FilesetResolver.forVisionTasks(MP_WASM);

  const makePose = async (delegate) => PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate },
    // IMAGE (pas VIDEO) : le mode VIDEO de MediaPipe applique un suivi/lissage
    // temporel interne entre frames qui ecrase les mouvements rapides (bras
    // qui monte en ~0.3s). On analyse chaque frame independamment et on
    // laisse notre propre One Euro Filter geren le jitter, avec un lissage
    // qu'on controle et qu'on peut ajuster.
    runningMode: 'IMAGE',
    numPoses: 1,
    minPoseDetectionConfidence: 0.45,
    minPosePresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  });
  const makeFace = async (delegate) => FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
    runningMode: 'IMAGE',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.45,
    minFacePresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  });
  const makeHand = async (delegate) => HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate },
    runningMode: 'IMAGE',
    numHands: 2,
    minHandDetectionConfidence: 0.4,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });

  try {
    [poseLandmarker, faceLandmarker, handLandmarker] = await Promise.all([makePose('GPU'), makeFace('GPU'), makeHand('GPU')]);
    log('MediaPipe initialise avec acceleration GPU.');
  } catch (gpuError) {
    log(`GPU indisponible (${gpuError.message || gpuError}). Passage CPU.`);
    [poseLandmarker, faceLandmarker, handLandmarker] = await Promise.all([makePose('CPU'), makeFace('CPU'), makeHand('CPU')]);
  }
  visionReady = true;
  setStatus('MediaPipe pret');
}

function clearVrm() {
  if (!currentVrm) return;
  scene.remove(currentVrm.scene);
  currentVrm = null;
  currentVrmFile = null;
  currentMotion = null;
  els.renderBtn.disabled = true;
  renderScene();
}

async function loadVrm(file) {
  clearVrm();
  if (!file) return;
  setStatus('Chargement VRM...');
  const url = URL.createObjectURL(file);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm?.humanoid) throw new Error('Le fichier ne contient pas de humanoid VRM exploitable.');
    currentVrm = vrm;
    currentVrmFile = file;
    VRMUtils.rotateVRM0(currentVrm);
    currentVrm.humanoid.resetNormalizedPose();
    currentVrm.expressionManager?.resetValues();
    scene.add(currentVrm.scene);
    currentVrm.scene.traverse((obj) => {
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const m of mats) {
        if (m?.isMToonMaterial) {
          m.shadingToonyFactor = THREE.MathUtils.clamp((m.shadingToonyFactor ?? 0.9) + 0.08, 0, 1);
          m.needsUpdate = true;
        }
      }
    });
    computeModelFrame();
    currentVrm.humanoid.resetNormalizedPose();
    limbRestDirs = computeLimbRestDirs();
    setView(previewView);
    renderScene();
    els.dropHint.style.display = 'none';
    els.vrmName.textContent = file.name;
    const required = ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'];
    const missing = required.filter((b) => !currentVrm.humanoid.getNormalizedBoneNode(b));
    const expr = currentVrm.expressionManager ? Object.keys(currentVrm.expressionManager.expressionMap) : [];
    els.vrmInfo.textContent = `Bones essentiels: ${missing.length ? 'manquants: ' + missing.join(', ') : 'OK'} | Expressions: ${expr.length ? expr.join(', ') : 'aucune'}`;
    log(`VRM charge: ${file.name}. ${missing.length ? `Attention: bones manquants ${missing.join(', ')}` : 'Squelette humanoide valide.'}`);
    setStatus('VRM pret');
  } catch (e) {
    clearVrm();
    els.dropHint.style.display = '';
    setStatus('Erreur VRM', true);
    log(`ERREUR VRM: ${e.stack || e.message || e}`);
    throw e;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function computeModelFrame() {
  currentVrm.humanoid.resetNormalizedPose();
  currentVrm.update(0);
  currentVrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(currentVrm.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  modelFrame = {
    center,
    height: Math.max(size.y, 0.5),
    width: Math.max(size.x, 0.3),
    depth: Math.max(size.z, 0.3),
  };
}

const VIEW_AZIMUTH = { front: 0, threequarter: 35, side: 90, back: 180 };
function setView(name) {
  previewView = name;
  const az = THREE.MathUtils.degToRad(VIEW_AZIMUTH[name] ?? 0);
  const c = modelFrame.center;
  const radius = Math.max(modelFrame.height * 2.2, 3);
  camera.position.set(c.x + Math.sin(az) * radius, c.y, c.z + Math.cos(az) * radius);
  camera.up.set(0, 1, 0);
  camera.lookAt(c);
  updateOrtho();
  renderScene();
}
function updateOrtho() {
  const w = renderer.domElement.width || 768;
  const h = renderer.domElement.height || 768;
  const aspect = w / h;
  const vertical = modelFrame.height * 1.16;
  const horizontalNeed = Math.max(modelFrame.width, modelFrame.depth) * 1.35;
  const halfH = Math.max(vertical / 2, (horizontalNeed / aspect) / 2);
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.left = -halfH * aspect;
  camera.right = halfH * aspect;
  camera.near = 0.01;
  camera.far = Math.max(modelFrame.height * 10, 50);
  camera.updateProjectionMatrix();
}
function renderScene(dt = 0) {
  if (currentVrm) currentVrm.update(dt);
  renderer.render(scene, camera);
}

function updateFileLists() {
  bodyFiles = [...els.bodyFolder.files].filter(isVideo);
  faceFiles = [...els.faceFolder.files].filter(isVideo);
  els.bodyCount.textContent = `${bodyFiles.length} video${bodyFiles.length > 1 ? 's' : ''}`;
  els.faceCount.textContent = `${faceFiles.length} video${faceFiles.length > 1 ? 's' : ''}`;

  els.bodySelect.innerHTML = '';
  bodyFiles.forEach((f, i) => {
    const o = document.createElement('option'); o.value = String(i); o.textContent = f.webkitRelativePath || f.name; els.bodySelect.appendChild(o);
  });
  els.faceSelect.innerHTML = '<option value="">Neutre</option>';
  faceFiles.forEach((f, i) => {
    const o = document.createElement('option'); o.value = String(i); o.textContent = f.webkitRelativePath || f.name; els.faceSelect.appendChild(o);
  });
  autoPairFace();
}
function autoPairFace() {
  const body = bodyFiles[Number(els.bodySelect.value || 0)];
  if (!body) return;
  const target = stem(body).toLowerCase();
  let index = faceFiles.findIndex((f) => stem(f).toLowerCase() === target);
  if (index < 0) index = faceFiles.findIndex((f) => ['default', 'neutral', 'neutre'].includes(stem(f).toLowerCase()));
  els.faceSelect.value = index >= 0 ? String(index) : '';
}

async function attachVideo(video, file) {
  if (video._url) URL.revokeObjectURL(video._url);
  const url = URL.createObjectURL(file);
  video._url = url;
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`Impossible de lire ${file.name}`)); };
    const cleanup = () => { video.removeEventListener('loadedmetadata', ok); video.removeEventListener('error', bad); };
    video.addEventListener('loadedmetadata', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    video.load();
  });
}

async function seekVideo(video, t) {
  const target = clamp(t, 0, Math.max(0, video.duration - 0.0005));
  if (Math.abs(video.currentTime - target) < 0.00025 && video.readyState >= 2) return;
  await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Erreur de decodage video.')); };
    const cleanup = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = target;
  });
}

function snapFps(raw) {
  const common = [12, 15, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
  let best = raw, err = Infinity;
  for (const f of common) {
    const e = Math.abs(raw - f) / f;
    if (e < err) { err = e; best = f; }
  }
  return err < 0.025 ? best : Math.round(raw * 1000) / 1000;
}

async function estimateFps(video) {
  if (!('requestVideoFrameCallback' in video)) return 30;
  video.pause();
  await seekVideo(video, 0);
  const times = [];
  return new Promise(async (resolve) => {
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      video.pause();
      const diffs = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 0.0001) diffs.push(d);
      }
      diffs.sort((a, b) => a - b);
      const median = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 1 / 30;
      await seekVideo(video, 0);
      resolve(snapFps(1 / median));
    };
    const cb = (_now, meta) => {
      if (finished) return;
      times.push(meta.mediaTime);
      if (times.length >= 24 || meta.mediaTime >= Math.min(1.0, video.duration - 0.005)) finish();
      else video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    try { await video.play(); } catch { resolve(30); }
    setTimeout(finish, 2500);
  });
}

function clonePlain(v) {
  if (v == null) return null;
  return JSON.parse(JSON.stringify(v));
}
// Paires gauche/droite du topology MediaPipe Pose (33 points). Kalidokit est
// concu pour un usage "miroir webcam" (VTuber) : son cote "Right"/"Left" en
// sortie depend du LABEL qu'il assigne lui-meme a chaque index d'entree fixe
// (11/13/... -> "Right"). Notre video est un enregistrement normal (pas une
// webcam en mode miroir). Un simple echange d'index casse les calculs qui
// referencent les DEUX cotes a la fois (ex: hanches via lm[23]/lm[24], ou le
// terme Y de calcArms qui lit l'epaule opposee) : teste, ca fait tourner tout
// le corps a l'envers. Le miroir geometrique complet et correct est : nier X
// (reflexion) PUIS echanger les index gauche/droite -- exactement ce que fait
// un logiciel d'animation pour "miroiter" une pose sans casser sa coherence
// interne (verifie a la main que le vecteur hanche redevient identique a
// l'original apres cette double operation).
const POSE_MIRROR_PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
function mirrorLandmarks(lm) {
  if (!lm) return lm;
  const negated = lm.map((p) => (p ? { ...p, x: -p.x } : p));
  const out = negated.slice();
  for (const [a, b] of POSE_MIRROR_PAIRS) { out[a] = negated[b]; out[b] = negated[a]; }
  return out;
}

function categoriesToMap(cats) {
  const out = {};
  for (const c of cats || []) out[c.categoryName || c.displayName || String(c.index)] = Number(c.score || 0);
  return out;
}

// One Euro Filter (Casiez et al.) : lisse le tremblement MediaPipe frame a
// frame sans ajouter de lag visible sur les mouvements rapides (contrairement
// a une simple moyenne mobile). minCutoff = lissage au repos, beta = reactivite
// pendant le mouvement.
class OneEuroFilter {
  constructor(minCutoff = 1.2, beta = 0.03, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.tPrev == null) { this.tPrev = t; this.xPrev = x; return x; }
    const dt = Math.max(1e-4, t - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }
}

// Kalidokit calcule l'elevation du bras (Vector.findRotation, decomposition
// en angles 2D par plan Z-X/Z-Y/X-Y) qui s'est averee quasi insensible a
// l'elevation reelle pour cette geometrie de bras (verifie : deux poses tres
// differentes -bras leve vs bras baisse- donnent des rotations Kalidokit
// presque identiques). On remplace la composante d'elevation (axe Z du bone
// VRM, calibre empiriquement sur ce modele : 0=T-pose horizontal, -PI/2=leve,
// +PI/2=baisse) par un calcul trigonometrique direct depuis les positions 3D
// epaule/coude, insensible a ce probleme.
function computeElevationZ(shoulder, elbow) {
  if (!shoulder || !elbow) return null;
  const dy = elbow.y - shoulder.y; // coordonnees MediaPipe : y croissant vers le bas
  const dx = Math.hypot(elbow.x - shoulder.x, elbow.z - shoulder.z);
  return Math.atan2(dy, Math.max(dx, 1e-4));
}
// --- IK 3D par visee directe (remplace le fitting Euler de Kalidokit pour
// les bras ET les jambes : le solveur de Kalidokit s'est avere insensible a
// l'elevation et incapable de representer correctement les articulations
// pliees sur ce squelette). Principe standard de retargeting : pour chaque
// os, calcule la rotation qui amene sa direction de repos (mesuree une fois,
// en T-pose) vers la direction cible (mesuree depuis les landmarks 3D),
// exprimee dans l'espace local du parent. Fonctionne os par os dans l'ordre
// de la hierarchie (upperArm avant lowerArm, upperLeg avant lowerLeg) car
// chaque os depend de la rotation deja appliquee de son parent.
let limbRestDirs = null;
const LIMB_CHAIN = [
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
];
// Doigts : Proximal->Intermediate et Intermediate->Distal ont un enfant VRM
// mesurable (segment suivant). Distal n'a pas d'os "bout du doigt" -> pas de
// direction de repos mesurable pour lui-meme ; on la copiera de Intermediate
// juste apres (doigt quasi droit au repos, approximation raisonnable).
const FINGER_LM_BASE = { Thumb: 1, Index: 5, Middle: 9, Ring: 13, Little: 17 };
for (const side of ['left', 'right']) {
  for (const digit of FINGER_DIGITS) {
    LIMB_CHAIN.push([`${side}${digit}Proximal`, `${side}${digit}Intermediate`]);
    LIMB_CHAIN.push([`${side}${digit}Intermediate`, `${side}${digit}Distal`]);
  }
}
function computeLimbRestDirs() {
  const dirs = {};
  scene.updateMatrixWorld(true);
  for (const [boneName, childName] of LIMB_CHAIN) {
    const bone = getBone(boneName);
    const child = getBone(childName);
    if (!bone || !child) continue;
    const boneWorld = new THREE.Vector3();
    const childWorld = new THREE.Vector3();
    bone.getWorldPosition(boneWorld);
    child.getWorldPosition(childWorld);
    const worldDir = childWorld.sub(boneWorld).normalize();
    const parentQuat = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentQuat);
    dirs[boneName] = worldDir.applyQuaternion(parentQuat.invert()).normalize();
  }
  for (const side of ['left', 'right']) {
    for (const digit of FINGER_DIGITS) {
      const distalName = `${side}${digit}Distal`;
      const intermediateName = `${side}${digit}Intermediate`;
      if (!dirs[distalName] && dirs[intermediateName]) dirs[distalName] = dirs[intermediateName].clone();
    }
  }
  return dirs;
}
function mediapipeDir(a, b) {
  if (!a || !b) return null;
  // MediaPipe : y croissant vers le bas -> on inverse pour l'espace Y-up de three.js.
  // MediaPipe : z plus petit (negatif) = plus proche de la camera source ; la camera
  // "front" de la scene est placee sur +Z et regarde vers -Z, donc plus proche de la
  // camera = +Z cote scene -> on inverse aussi z, sinon les bras qui avancent vers la
  // camera source finissent bascules derriere le torse dans le rendu.
  return new THREE.Vector3(b.x - a.x, -(b.y - a.y), -(b.z - a.z)).normalize();
}
function computeLimbIKRotation(boneName, targetWorldDir) {
  const bone = getBone(boneName);
  const restDir = limbRestDirs?.[boneName];
  if (!bone || !restDir || !targetWorldDir) return null;
  const parentQuat = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentQuat);
  const parentQuatInv = parentQuat.clone().invert();
  const targetLocal = targetWorldDir.clone().applyQuaternion(parentQuatInv).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(restDir, targetLocal);
  bone.quaternion.copy(q);
  bone.updateMatrixWorld(true);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { x: e.x, y: e.y, z: e.z, rotationOrder: 'XYZ' };
}
// Applique l'IK bras+jambes directement sur les bones VRM (etat live) et
// retourne les rotations Euler correspondantes pour stockage/serialisation
// dans le rig. lm3d ICI est le landmark BRUT (non-mirrore) : convention
// MediaPipe standard, 11/13/15/23/25/27 = epaule/coude/poignet/hanche/
// genou/cheville GAUCHE du sujet, 12/14/16/24/26/28 = DROITE. Pas besoin de
// miroir ici (contrairement a Kalidokit, concu pour une webcam selfie) --
// notre IK calcule directement depuis la geometrie 3D reelle.
function ikLimbsFromLandmarks(lm3d, rig) {
  if (!lm3d || !limbRestDirs) return {};
  // Repartir d'une pose neutre : la chaine de parente (spine/chest/hips) doit
  // etre dans un etat CONNU avant de mesurer les quaternions parent pour l'IK.
  resetVrmPose();
  // Puis reappliquer hips/spine/chest (meme poids que applyBodyFrame a
  // strength=1) AVANT de calculer l'IK des membres : les bras/jambes sont
  // enfants de chest/hips dans la hierarchie VRM, donc si le buste ou le
  // bassin est tourne (pose 3/4, hanches pivotees) et qu'on calcule l'IK par
  // rapport a un parent suppose en T-pose, la rotation reelle du parent se
  // recompose avec notre rotation locale au rendu final -> le bras/la jambe
  // finit tourne(e) d'un angle supplementaire (parfois jusqu'a passer devant/
  // derriere le torse). Corrige le 22/08 suite a un bras qui passait derriere
  // le corps sur une pose buste tourne alors qu'il etait devant sur la photo.
  if (rig) {
    setBoneRotation('hips', rig.Hips?.rotation, 0.7);
    const hasChest = !!getBone('chest');
    setBoneRotation('spine', rig.Spine, hasChest ? 0.45 : 0.7);
    if (hasChest) setBoneRotation('chest', rig.Spine, 0.25);
  }
  // getWorldQuaternion() lit matrixWorld tel quel (pas de recalcul auto) :
  // il faut forcer la propagation hips->spine->chest->epaules avant que
  // computeLimbIKRotation() n'aille lire l'orientation reelle des parents.
  scene.updateMatrixWorld(true);
  const rUpperArm = mediapipeDir(lm3d[12], lm3d[14]);
  const rLowerArm = mediapipeDir(lm3d[14], lm3d[16]);
  const lUpperArm = mediapipeDir(lm3d[11], lm3d[13]);
  const lLowerArm = mediapipeDir(lm3d[13], lm3d[15]);
  const rUpperLeg = mediapipeDir(lm3d[24], lm3d[26]);
  const rLowerLeg = mediapipeDir(lm3d[26], lm3d[28]);
  const lUpperLeg = mediapipeDir(lm3d[23], lm3d[25]);
  const lLowerLeg = mediapipeDir(lm3d[25], lm3d[27]);
  const out = {};
  const add = (key, boneName, dir) => { const r = computeLimbIKRotation(boneName, dir); if (r) out[key] = r; };
  add('RightUpperArm', 'rightUpperArm', rUpperArm);
  add('RightLowerArm', 'rightLowerArm', rLowerArm);
  add('LeftUpperArm', 'leftUpperArm', lUpperArm);
  add('LeftLowerArm', 'leftLowerArm', lLowerArm);
  add('RightUpperLeg', 'rightUpperLeg', rUpperLeg);
  add('RightLowerLeg', 'rightLowerLeg', rLowerLeg);
  add('LeftUpperLeg', 'leftUpperLeg', lUpperLeg);
  add('LeftLowerLeg', 'leftLowerLeg', lLowerLeg);
  return out;
}
function fixLimbsIK(rig, lm3d) {
  if (!rig || !lm3d) return rig;
  const ik = ikLimbsFromLandmarks(lm3d, rig);
  Object.assign(rig, ik);
  return rig;
}
// Meme IK que les bras/jambes, appliquee aux doigts. handLandmarksBySide =
// { left: [21 landmarks 3D] | null, right: [...] | null }, deja associes a
// leur cote anatomique reel (handedness MediaPipe brute, cf solveHands).
function ikFingersFromLandmarks(handLandmarksBySide, rig) {
  if (!handLandmarksBySide || !limbRestDirs) return {};
  const out = {};
  for (const side of ['left', 'right']) {
    const lm = handLandmarksBySide[side];
    if (!lm) continue;
    // Meme raison que pour hips/spine/chest dans ikLimbsFromLandmarks : les
    // doigts sont enfants de la main, donc si le poignet est tourne/plie
    // (rig.RightHand/LeftHand, pose par solveHands) il faut l'appliquer AVANT
    // de calculer l'IK des doigts, sinon leur rotation locale est calculee
    // par rapport a un poignet suppose neutre et se retrouve fausse au rendu.
    const Side = side === 'left' ? 'Left' : 'Right';
    setBoneRotation(`${side}Hand`, rig?.[`${Side}Hand`], 1);
    getBone(`${side}Hand`)?.updateMatrixWorld(true);
    for (const digit of FINGER_DIGITS) {
      const base = FINGER_LM_BASE[digit];
      const segs = [
        [`${side}${digit}Proximal`, lm[base], lm[base + 1]],
        [`${side}${digit}Intermediate`, lm[base + 1], lm[base + 2]],
        [`${side}${digit}Distal`, lm[base + 2], lm[base + 3]],
      ];
      for (const [boneName, a, b] of segs) {
        const dir = mediapipeDir(a, b);
        const rot = computeLimbIKRotation(boneName, dir);
        if (rot) out[`${Side}${boneName.slice(side.length)}`] = rot;
      }
    }
  }
  return out;
}
function fixFingersIK(rig, handLandmarksBySide) {
  if (!rig || !handLandmarksBySide) return rig;
  Object.assign(rig, ikFingersFromLandmarks(handLandmarksBySide, rig));
  return rig;
}

function collectNumericLeafPaths(obj, prefix, out) {
  for (const k in obj) {
    const v = obj[k];
    if (v == null) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out.push(path);
    else if (typeof v === 'object') collectNumericLeafPaths(v, path, out);
  }
}
function getAtPath(obj, path) {
  let o = obj;
  for (const k of path.split('.')) { if (o == null) return undefined; o = o[k]; }
  return o;
}
function setAtPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}
// Lisse en place une serie temporelle d'objets imbriques (rig Kalidokit ou
// map de blendshapes) : un filtre One Euro independant par "feuille" numerique.
function smoothFrameSeries(frames, getObj) {
  const sample = frames.map(getObj).find((o) => o);
  if (!sample) return;
  const paths = [];
  collectNumericLeafPaths(sample, '', paths);
  for (const path of paths) {
    const filt = new OneEuroFilter();
    for (const f of frames) {
      const obj = getObj(f);
      if (!obj) continue;
      const v = getAtPath(obj, path);
      if (typeof v !== 'number') continue;
      setAtPath(obj, path, filt.filter(v, f.time));
    }
  }
}

// Sur une source basse resolution (ex video de danse 256x144), une main ne
// fait que 10-20px dans l'image complete : le Hand Landmarker retourne des
// landmarks incoherents (confirme visuellement, blob sans forme de main
// reconnaissable, pas de vrais doigts). Technique standard : recadrer une
// zone carree autour du poignet (taille ~ longueur de l'avant-bras, donnee
// par Pose Landmarker) et l'agrandir avant de lancer la detection -> le
// modele voit une main bien plus grande, detection nettement plus fiable.
const HAND_CROP_SIZE = 224;
let handCropCanvas = null;
function sourceSize(el) {
  return { w: el.videoWidth || el.naturalWidth || el.width, h: el.videoHeight || el.naturalHeight || el.height };
}
// lmRaw = poseResult.landmarks[0] BRUT (non-mirrore, coordonnees image
// normalisees) : convention MediaPipe standard, 13/15 = coude/poignet
// GAUCHE du sujet, 14/16 = DROITE (meme convention que le reste de l'IK).
function handCropRect(lmRaw, side, srcW, srcH) {
  const elbow = lmRaw?.[side === 'left' ? 13 : 14];
  const wrist = lmRaw?.[side === 'left' ? 15 : 16];
  if (!elbow || !wrist) return null;
  const ex = elbow.x * srcW, ey = elbow.y * srcH;
  const wx = wrist.x * srcW, wy = wrist.y * srcH;
  const forearmLen = Math.hypot(wx - ex, wy - ey);
  if (!(forearmLen > 0.5)) return null;
  const size = Math.min(Math.max(forearmLen * 1.8, 40), Math.max(srcW, srcH));
  // Decale le centre du carre un peu au-dela du poignet (vers la main,
  // pas vers le coude) pour bien cadrer les doigts plutot que l'avant-bras.
  const cx = wx + (wx - ex) * 0.25;
  const cy = wy + (wy - ey) * 0.25;
  return { cx, cy, size };
}
function detectHandsCropped(source, lmRaw) {
  const out = { landmarks: [], worldLandmarks: [], handedness: [] };
  if (!lmRaw || !handLandmarker) return out;
  const { w: srcW, h: srcH } = sourceSize(source);
  if (!srcW || !srcH) return out;
  if (!handCropCanvas) handCropCanvas = document.createElement('canvas');
  handCropCanvas.width = HAND_CROP_SIZE;
  handCropCanvas.height = HAND_CROP_SIZE;
  const ctx = handCropCanvas.getContext('2d');
  for (const side of ['left', 'right']) {
    const rect = handCropRect(lmRaw, side, srcW, srcH);
    if (!rect) continue;
    const half = rect.size / 2;
    const sx = Math.min(Math.max(rect.cx - half, 0), Math.max(srcW - rect.size, 0));
    const sy = Math.min(Math.max(rect.cy - half, 0), Math.max(srcH - rect.size, 0));
    const sSize = Math.min(rect.size, srcW, srcH);
    if (!(sSize > 1)) continue;
    ctx.clearRect(0, 0, HAND_CROP_SIZE, HAND_CROP_SIZE);
    ctx.drawImage(source, sx, sy, sSize, sSize, 0, 0, HAND_CROP_SIZE, HAND_CROP_SIZE);
    const r = handLandmarker.detect(handCropCanvas);
    if (!r.landmarks?.length) continue;
    out.landmarks.push(r.landmarks[0]);
    out.worldLandmarks.push(r.worldLandmarks[0]);
    // Cote deja connu (c'est nous qui avons recadre ce poignet) : bien plus
    // fiable que le classifieur handedness de MediaPipe sur un petit crop
    // ambigu. Label ecrit dans la convention "brute" (inversee) que
    // solveHands/handLandmarksBySideFrom attendent deja et corrigent en
    // interne (cf leurs commentaires) -> aucun changement necessaire cote
    // consommateur.
    out.handedness.push([{ categoryName: side === 'left' ? 'Right' : 'Left' }]);
  }
  return out;
}

function handLandmarksBySideFrom(handResult) {
  const out = { left: null, right: null };
  const list = handResult?.worldLandmarks || [];
  for (let h = 0; h < list.length; h++) {
    const reported = handResult.handedness?.[h]?.[0]?.categoryName;
    // Meme correction que solveHands (cf commentaire ci-dessous) : MediaPipe
    // suppose une image miroir (selfie), notre source ne l'est pas, donc le
    // label handedness brut est invers. Sans cette inversion, les
    // landmarks de la main droite finissaient assignes aux bones de la main
    // gauche (et vice versa) -> doigts recroquevilles/pouce dans le mauvais
    // sens, incoherent avec l'anatomie reelle du bone cible.
    if (reported === 'Left') out.right = list[h];
    else if (reported === 'Right') out.left = list[h];
  }
  return out;
}
function solveHands(handResult) {
  const out = {};
  const landmarksList = handResult?.landmarks || [];
  for (let h = 0; h < landmarksList.length; h++) {
    const reported = handResult.handedness?.[h]?.[0]?.categoryName;
    if (reported !== 'Left' && reported !== 'Right') continue;
    // MediaPipe calcule la handedness en supposant une image miroir (selfie),
    // notre video ne l'est pas : geometrie de la main inchangee (pas de
    // cross-reference gauche/droite comme pour Pose), seul le label -> signe
    // d'inversion de Kalidokit a besoin d'etre corrige.
    const side = reported === 'Left' ? 'Right' : 'Left';
    try {
      const solved = KalidoHand.solve(landmarksList[h], side);
      if (!solved) continue;
      for (const digit of FINGER_DIGITS) {
        for (const segment of FINGER_SEGMENTS) {
          const key = `${side}${digit}${segment}`;
          if (solved[key]) out[key] = solved[key];
        }
      }
    } catch (e) {
      log(`Kalidokit hand (${side}): ${e.message || e}`);
    }
  }
  return out;
}

async function analyzeBodyVideo(file, fpsOverride = 0, progressStart = 0, progressScale = 0.5) {
  await attachVideo(els.bodyVideo, file);
  const video = els.bodyVideo;
  let fps = Number(fpsOverride) > 0 ? Number(fpsOverride) : await estimateFps(video);
  fps = clamp(fps, 1, 240);
  const duration = video.duration;
  const count = Math.max(1, Math.round(duration * fps));
  const frames = [];
  let previous = null;
  let misses = 0;
  log(`BODY ${file.name}: ${duration.toFixed(3)} s, ${fps.toFixed(3)} FPS, ${count} frames.`);

  for (let i = 0; i < count; i++) {
    const t = Math.min(i / fps, Math.max(0, duration - 0.0005));
    await seekVideo(video, t);
    const ts = bodyTimestampBase + Math.round(i * 1000 / fps);
    const result = poseLandmarker.detect(video);
    const lm2d = mirrorLandmarks(result.landmarks?.[0]);
    const lm3d = mirrorLandmarks(result.worldLandmarks?.[0]);
    let rig = null;
    if (lm2d?.length && lm3d?.length) {
      try {
        rig = KalidoPose.solve(lm3d, lm2d, { runtime: 'mediapipe', video, enableLegs: true });
        fixLimbsIK(rig, result.worldLandmarks?.[0]);
      } catch (e) {
        log(`Kalidokit body frame ${i}: ${e.message || e}`);
      }
    }
    const handResult = detectHandsCropped(video, result.landmarks?.[0]);
    const hands = solveHands(handResult);
    if (!rig) { misses++; rig = previous; }
    if (rig && Object.keys(hands).length) rig = { ...rig, ...hands };
    if (rig) fixFingersIK(rig, handLandmarksBySideFrom(handResult));
    if (rig) previous = rig;
    frames.push({ time: t, rig: clonePlain(rig) });
    if ((i & 3) === 0 || i === count - 1) {
      setProgress(progressStart + progressScale * ((i + 1) / count), `Analyse body ${i + 1}/${count}`);
      await nextFrame();
    }
  }
  bodyTimestampBase += Math.ceil(duration * 1000) + 1000;
  log(`BODY termine. Frames sans detection: ${misses}/${count}.`);
  return { fileName: file.name, duration, fps, count, frames, misses };
}

async function analyzeFaceVideo(file, fpsOverride = 0, progressStart = 0.5, progressScale = 0.5) {
  if (!file) return null;
  await attachVideo(els.faceVideo, file);
  const video = els.faceVideo;
  let fps = Number(fpsOverride) > 0 ? Number(fpsOverride) : await estimateFps(video);
  fps = clamp(fps, 1, 240);
  const duration = video.duration;
  const count = Math.max(1, Math.round(duration * fps));
  const frames = [];
  let previous = null;
  let misses = 0;
  log(`FACE ${file.name}: ${duration.toFixed(3)} s, ${fps.toFixed(3)} FPS, ${count} frames.`);

  for (let i = 0; i < count; i++) {
    const t = Math.min(i / fps, Math.max(0, duration - 0.0005));
    await seekVideo(video, t);
    const ts = faceTimestampBase + Math.round(i * 1000 / fps);
    const result = faceLandmarker.detect(video);
    const lms = result.faceLandmarks?.[0];
    let rig = null;
    if (lms?.length) {
      try {
        rig = KalidoFace.solve(lms, {
          runtime: 'mediapipe',
          video,
          imageSize: { width: video.videoWidth, height: video.videoHeight },
          smoothBlink: false,
          blinkSettings: [0.25, 0.75],
        });
      } catch (e) {
        log(`Kalidokit face frame ${i}: ${e.message || e}`);
      }
    }
    const blendshapes = categoriesToMap(result.faceBlendshapes?.[0]?.categories || result.faceBlendshapes?.[0] || []);
    if (!rig) { misses++; rig = previous?.rig || null; }
    const frame = { time: t, rig: clonePlain(rig), blendshapes };
    if (rig) previous = frame;
    frames.push(frame);
    if ((i & 3) === 0 || i === count - 1) {
      setProgress(progressStart + progressScale * ((i + 1) / count), `Analyse face ${i + 1}/${count}`);
      await nextFrame();
    }
  }
  faceTimestampBase += Math.ceil(duration * 1000) + 1000;
  log(`FACE termine. Frames sans detection: ${misses}/${count}.`);
  return { fileName: file.name, duration, fps, count, frames, misses };
}

function selectedBody() { return bodyFiles[Number(els.bodySelect.value || 0)] || null; }
function selectedFace() {
  if (els.faceSelect.value === '') return null;
  return faceFiles[Number(els.faceSelect.value)] || null;
}

async function analyzePair(bodyFile, faceFile, bodyFpsOverride = null, faceFpsOverride = null) {
  if (!bodyFile) throw new Error('Aucune video body selectionnee.');
  if (!currentVrm) throw new Error('Charge d abord un VRM.');
  els.renderBtn.disabled = true;
  currentMotion = null;
  setProgress(0, 'Initialisation du tracking');
  await initVision();
  const hasFace = !!faceFile;
  const body = await analyzeBodyVideo(bodyFile, bodyFpsOverride ?? Number(els.bodyFps.value), 0, hasFace ? 0.5 : 1);
  const face = hasFace ? await analyzeFaceVideo(faceFile, faceFpsOverride ?? Number(els.faceFps.value), 0.5, 0.5) : null;
  // Was defined but never wired in: removes MediaPipe's per-frame jitter (a real Euro Filter
  // pass, not just a moving average) before the rig data ever reaches rendering or interpolation.
  smoothFrameSeries(body.frames, (f) => f.rig);
  if (face) smoothFrameSeries(face.frames, (f) => f.rig);
  currentMotion = { body, face, bodyFile, faceFile };
  els.renderBtn.disabled = false;
  setProgress(1, 'Analyse terminee');
  log(`Clip pret: ${bodyFile.name}${faceFile ? ` + face ${faceFile.name}` : ' + face neutre'}.`);
  return currentMotion;
}

function getBone(name) {
  return currentVrm?.humanoid?.getNormalizedBoneNode(name) || null;
}
function setBoneRotation(name, rot, strength = 1, orderOverride = null) {
  if (!rot) return;
  const node = getBone(name);
  if (!node) return;
  const order = orderOverride || rot.rotationOrder || 'XYZ';
  const e = new THREE.Euler(
    Number(rot.x || 0) * strength,
    Number(rot.y || 0) * strength,
    Number(rot.z || 0) * strength,
    order,
  );
  node.quaternion.setFromEuler(e);
}

function applyBodyFrame(frame, strength = 1) {
  const r = frame?.rig;
  if (!r) return;
  setBoneRotation('hips', r.Hips?.rotation, 0.7 * strength);
  const hasChest = !!getBone('chest');
  setBoneRotation('spine', r.Spine, (hasChest ? 0.45 : 0.7) * strength);
  if (hasChest) setBoneRotation('chest', r.Spine, 0.25 * strength);

  // Kalidokit est concu pour un usage "miroir webcam" (VTuber) : il calcule
  // Note: le cote gauche/droite est corrige en amont (miroir des landmarks
  // MediaPipe avant Kalidokit, cf mirrorLandmarks dans analyzeBodyVideo) car
  // Kalidokit imbrique un signe d'inversion different selon le label Right/
  // Left qu'il produit lui-meme : swapper seulement l'affectation bone<-rig
  // ici cassait le sens de rotation (bras qui plient a l'envers).
  setBoneRotation('rightUpperArm', r.RightUpperArm, strength);
  setBoneRotation('rightLowerArm', r.RightLowerArm, strength);
  setBoneRotation('rightHand', r.RightHand, strength);
  setBoneRotation('leftUpperArm', r.LeftUpperArm, strength);
  setBoneRotation('leftLowerArm', r.LeftLowerArm, strength);
  setBoneRotation('leftHand', r.LeftHand, strength);
  setBoneRotation('rightUpperLeg', r.RightUpperLeg, strength);
  setBoneRotation('rightLowerLeg', r.RightLowerLeg, strength);
  setBoneRotation('leftUpperLeg', r.LeftUpperLeg, strength);
  setBoneRotation('leftLowerLeg', r.LeftLowerLeg, strength);

  for (const [side, Side] of [['left', 'Left'], ['right', 'Right']]) {
    for (const digit of FINGER_DIGITS) {
      for (const segment of FINGER_SEGMENTS) {
        const boneName = `${side}${digit}${segment}`;
        const rigKey = `${Side}${digit}${segment}`;
        setBoneRotation(boneName, r[rigKey], strength);
      }
    }
  }

  if (!els.lockRoot.checked && r.Hips?.position) {
    const p = r.Hips.position;
    const root = currentVrm.scene;
    root.position.x = modelFrame.center.x + Number(p.x || 0) * 0.35;
    root.position.y = Number(p.y || 0) * 0.15;
    root.position.z = Number(p.z || 0) * 0.15;
  } else {
    currentVrm.scene.position.set(0, 0, 0);
  }
}

function blendValue(map, key) {
  if (!map) return 0;
  if (key in map) return Number(map[key] || 0);
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === lower) return Number(v || 0);
  return 0;
}
function setExpr(name, value) {
  const m = currentVrm?.expressionManager;
  if (!m || !m.getExpression(name)) return false;
  m.setValue(name, clamp(value));
  return true;
}
function setFirstExpr(names, value) {
  for (const n of names) if (setExpr(n, value)) return true;
  return false;
}

function applyFaceFrame(frame, strength = 1) {
  const m = currentVrm?.expressionManager;
  if (m) m.resetValues();
  if (!frame) return;
  const r = frame.rig;
  if (r?.head) {
    setBoneRotation('neck', r.head, 0.25 * strength);
    setBoneRotation('head', r.head, 0.75 * strength);
  }

  if (r?.pupil) {
    const x = Number(r.pupil.x || 0) * 0.22 * strength;
    const y = Number(r.pupil.y || 0) * 0.18 * strength;
    const le = getBone('leftEye'); const re = getBone('rightEye');
    if (le) le.rotation.set(y, x, 0);
    if (re) re.rotation.set(y, x, 0);
  }

  if (m && r) {
    const blinkL = clamp((1 - Number(r.eye?.l ?? 1)) * strength);
    const blinkR = clamp((1 - Number(r.eye?.r ?? 1)) * strength);
    const leftDone = setExpr('blinkLeft', blinkL);
    const rightDone = setExpr('blinkRight', blinkR);
    if (!leftDone && !rightDone) setExpr('blink', (blinkL + blinkR) * 0.5);

    const s = r.mouth?.shape || {};
    setFirstExpr(['aa', 'a'], Number(s.A || 0) * strength);
    setFirstExpr(['ee', 'e'], Number(s.E || 0) * strength);
    setFirstExpr(['ih', 'i'], Number(s.I || 0) * strength);
    setFirstExpr(['oh', 'o'], Number(s.O || 0) * strength);
    setFirstExpr(['ou', 'u'], Number(s.U || 0) * strength);
  }

  const b = frame.blendshapes || {};
  if (m && Object.keys(b).length) {
    // If the VRM contains ARKit-like custom expression names, drive them directly.
    for (const [name, value] of Object.entries(b)) {
      if (m.getExpression(name)) m.setValue(name, clamp(Number(value) * strength));
    }

    // Fallback to the standard VRM emotion presets.
    const smile = (blendValue(b, 'mouthSmileLeft') + blendValue(b, 'mouthSmileRight')) * 0.5;
    const frown = (blendValue(b, 'mouthFrownLeft') + blendValue(b, 'mouthFrownRight')) * 0.5;
    const browDown = (blendValue(b, 'browDownLeft') + blendValue(b, 'browDownRight')) * 0.5;
    const innerUp = blendValue(b, 'browInnerUp');
    const wide = (blendValue(b, 'eyeWideLeft') + blendValue(b, 'eyeWideRight')) * 0.5;
    const jaw = blendValue(b, 'jawOpen');
    const sneer = (blendValue(b, 'noseSneerLeft') + blendValue(b, 'noseSneerRight')) * 0.5;

    setFirstExpr(['happy', 'joy'], clamp((smile - frown * 0.35) * 0.85 * strength));
    setFirstExpr(['angry'], clamp((browDown * 0.75 + sneer * 0.35 - smile * 0.2) * strength));
    setFirstExpr(['sad', 'sorrow'], clamp((frown * 0.75 + innerUp * 0.35) * strength));
    setFirstExpr(['surprised'], clamp((wide * 0.55 + jaw * 0.55) * strength));
  }

  m?.update();
}

function resetVrmPose() {
  if (!currentVrm) return;
  currentVrm.humanoid.resetNormalizedPose();
  currentVrm.expressionManager?.resetValues();
  currentVrm.scene.position.set(0, 0, 0);
}

// Linear blend of every numeric leaf two frame objects share (same per-leaf walk as
// smoothFrameSeries) — non-numeric fields (rotationOrder strings, etc.) come from frame A.
// Adjacent tracked frames are ~40ms apart at 25 FPS, so per-bone Euler deltas stay small
// enough that linear blending doesn't need quaternion SLERP or angle-wrap handling.
function blendFrames(a, b, alpha) {
  const out = clonePlain(a);
  const paths = [];
  collectNumericLeafPaths(a, '', paths);
  for (const path of paths) {
    const va = getAtPath(a, path);
    const vb = getAtPath(b, path);
    if (typeof va === 'number' && typeof vb === 'number') setAtPath(out, path, va + (vb - va) * alpha);
  }
  return out;
}

// Interpolates between the two nearest tracked frames instead of snapping to whichever is
// closest. Nearest-neighbor sampling is why a higher output FPS (--fps-mode custom) used to
// just repeat tracked poses instead of producing real in-between motion, and why played-back
// clips looked steppy even at the source FPS — this is per-frame numeric interpolation of the
// rig data, rendered fresh through the normal pipeline, so it carries none of the ghosting risk
// that interpolating already-rendered pixels would.
function nearestFrame(clip, t, mode = 'clamp', bodyDuration = null) {
  if (!clip?.frames?.length) return null;
  let tt = t;
  if (mode === 'loop') {
    tt = clip.duration > 0 ? ((t % clip.duration) + clip.duration) % clip.duration : 0;
  } else if (mode === 'stretch' && bodyDuration > 0) {
    tt = clamp(t / bodyDuration, 0, 1) * clip.duration;
  } else {
    tt = clamp(t, 0, clip.duration);
  }
  const fIdx = clamp(tt * clip.fps, 0, clip.frames.length - 1);
  const i0 = Math.floor(fIdx);
  const i1 = Math.min(i0 + 1, clip.frames.length - 1);
  const alpha = fIdx - i0;
  if (alpha < 1e-6 || i0 === i1) return clip.frames[i0];
  return blendFrames(clip.frames[i0], clip.frames[i1], alpha);
}

function resolveOutputFps(motion) {
  const mode = els.outputFpsMode.value;
  if (mode === 'body') return motion.body.fps;
  if (mode === 'custom') return clamp(Number(els.customFps.value) || 30, 1, 240);
  return Math.max(motion.body.fps, motion.face?.fps || 0, 1);
}

function posterizeCanvas(canvas, levels = 8) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const step = 255 / Math.max(2, levels - 1);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = Math.round(d[i] / step) * step;
    d[i + 1] = Math.round(d[i + 1] / step) * step;
    d[i + 2] = Math.round(d[i + 2] / step) * step;
  }
  ctx.putImageData(img, 0, 0);
}

async function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG encode failed')), 'image/png'));
}
async function writeBlob(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}
async function writeText(dir, name, text) {
  return writeBlob(dir, name, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}
async function childDir(parent, name) { return parent.getDirectoryHandle(safeName(name), { create: true }); }

function copyRenderToWork(size) {
  const c = els.workCanvas;
  c.width = size; c.height = size;
  const ctx = c.getContext('2d', { alpha: true, willReadFrequently: els.posterize.checked });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(renderer.domElement, 0, 0, size, size);
  if (els.posterize.checked) posterizeCanvas(c, 8);
  return c;
}

async function writeMotionJson(clipDir, motion) {
  const compactBody = {
    format: 'HellCorpBodyMotionV1',
    source: motion.body.fileName,
    fps: motion.body.fps,
    duration: motion.body.duration,
    frames: motion.body.frames,
  };
  await writeText(clipDir, 'body_motion.json', JSON.stringify(compactBody));
  if (motion.face) {
    const compactFace = {
      format: 'HellCorpFaceMotionV1',
      source: motion.face.fileName,
      fps: motion.face.fps,
      duration: motion.face.duration,
      frames: motion.face.frames,
    };
    await writeText(clipDir, 'face_motion.json', JSON.stringify(compactFace));
  }
}

async function renderMotionToDirectory(rootHandle, motion, clipLabel) {
  const charDir = await childDir(rootHandle, stem(currentVrmFile));
  const clipDir = await childDir(charDir, clipLabel);
  await writeMotionJson(clipDir, motion);

  const views = [...document.querySelectorAll('.viewExport:checked')].map((x) => x.value);
  if (!views.length) throw new Error('Selectionne au moins une vue.');
  const size = Number(els.sizeSelect.value) || 512;
  const fps = resolveOutputFps(motion);
  const duration = motion.body.duration;
  const count = Math.max(1, Math.round(duration * fps));
  const dt = 1 / fps;
  const bodyStrength = Number(els.bodyStrength.value) || 1;
  const faceStrength = Number(els.faceStrength.value) || 1;
  const faceMode = els.faceMode.value;
  const exportFrames = els.individualFrames.checked;
  const exportAtlas = els.atlasFrames.checked;
  const total = count * views.length;
  let done = 0;

  const renderSize = Math.round(size * supersampleFor(size));
  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  setupPostFX(renderSize);

  const topManifest = {
    format: 'HellCorpSpriteSetV1',
    character: stem(currentVrmFile),
    body_source: motion.body.fileName,
    face_source: motion.face?.fileName || null,
    fps,
    frame_count: count,
    duration,
    frame_size: [size, size],
    views,
    alpha: true,
  };
  await writeText(clipDir, 'clip.json', JSON.stringify(topManifest, null, 2));

  for (const view of views) {
    const viewDir = await childDir(clipDir, view);
    const framesDir = exportFrames ? await childDir(viewDir, 'frames') : null;
    const atlasDir = exportAtlas ? await childDir(viewDir, 'atlases') : null;
    const atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = size * 8; atlasCanvas.height = size * 8;
    const atlasCtx = atlasCanvas.getContext('2d');
    let atlasPage = 0;
    let atlasSlots = 0;
    const atlasFrames = [];
    const atlasPages = [];

    setView(view);
    for (let i = 0; i < count; i++) {
      const t = i / fps;
      resetVrmPose();
      const bodyFrame = nearestFrame(motion.body, t, 'clamp', duration);
      const faceFrame = nearestFrame(motion.face, t, faceMode, duration);
      applyBodyFrame(bodyFrame, bodyStrength);
      applyFaceFrame(faceFrame, faceStrength);
      renderScenePostFX(dt, renderSize);
      const frameCanvas = copyRenderToWork(size);

      if (framesDir) {
        const blob = await canvasBlob(frameCanvas);
        await writeBlob(framesDir, `frame_${String(i).padStart(6, '0')}.png`, blob);
      }

      if (atlasDir) {
        const slot = atlasSlots;
        const x = (slot % 8) * size;
        const y = Math.floor(slot / 8) * size;
        atlasCtx.drawImage(frameCanvas, x, y, size, size);
        atlasFrames.push({ frame: i, time: t, page: atlasPage, x, y, w: size, h: size });
        atlasSlots++;
        if (atlasSlots === 64 || i === count - 1) {
          const name = `atlas_${String(atlasPage).padStart(3, '0')}.png`;
          await writeBlob(atlasDir, name, await canvasBlob(atlasCanvas));
          atlasPages.push({ page: atlasPage, file: `atlases/${name}` });
          atlasPage++;
          atlasSlots = 0;
          atlasCtx.clearRect(0, 0, atlasCanvas.width, atlasCanvas.height);
        }
      }

      done++;
      if ((i & 1) === 0 || i === count - 1) {
        setProgress(done / total, `Rendu ${view}: ${i + 1}/${count} | total ${done}/${total}`);
        await nextFrame();
      }
    }

    if (atlasDir) {
      const manifest = {
        format: 'HellCorpAtlasV1',
        view,
        fps,
        frame_count: count,
        frame_size: [size, size],
        grid: [8, 8],
        pages: atlasPages,
        frames: atlasFrames,
      };
      await writeText(viewDir, 'atlas_manifest.json', JSON.stringify(manifest, null, 2));
    }
  }

  renderer.setSize(768, 768, false);
  resetVrmPose();
  setView(previewView);
  renderScene();
  setProgress(1, `Rendu termine: ${clipLabel}`);
  log(`EXPORT termine: ${clipLabel}, ${count} frames x ${views.length} vues a ${fps.toFixed(3)} FPS.`);
}

async function chooseOutputDirectory() {
  if (!window.showDirectoryPicker) {
    throw new Error('Le navigateur ne permet pas l ecriture de dossiers. Lance l application avec start.bat/start.sh dans Chrome ou Edge.');
  }
  return window.showDirectoryPicker({ mode: 'readwrite', id: 'hellcorp-motion-output' });
}

async function renderSelected() {
  if (!currentMotion) throw new Error('Analyse d abord le clip.');
  const dir = await chooseOutputDirectory();
  await renderMotionToDirectory(dir, currentMotion, stem(currentMotion.bodyFile));
}

function findFaceForBody(body) {
  const target = stem(body).toLowerCase();
  let f = faceFiles.find((x) => stem(x).toLowerCase() === target);
  if (!f) f = faceFiles.find((x) => ['default', 'neutral', 'neutre'].includes(stem(x).toLowerCase()));
  return f || null;
}

async function batchAll() {
  if (!currentVrm) throw new Error('Charge d abord un VRM.');
  if (!bodyFiles.length) throw new Error('Le dossier body ne contient aucune video.');
  const dir = await chooseOutputDirectory();
  await initVision();
  log(`BATCH demarre: ${bodyFiles.length} clips body.`);
  for (let i = 0; i < bodyFiles.length; i++) {
    const body = bodyFiles[i];
    const face = findFaceForBody(body);
    log(`BATCH ${i + 1}/${bodyFiles.length}: ${body.name} + ${face?.name || 'face neutre'}`);
    setProgress(0, `Batch ${i + 1}/${bodyFiles.length}: analyse`);
    const motion = await analyzePair(body, face, Number(els.bodyFps.value), Number(els.faceFps.value));
    setProgress(0, `Batch ${i + 1}/${bodyFiles.length}: rendu`);
    await renderMotionToDirectory(dir, motion, stem(body));
  }
  setProgress(1, `Batch termine: ${bodyFiles.length} clips`);
  log('BATCH termine.');
}

async function guarded(fn) {
  const buttons = [els.analyzeBtn, els.renderBtn, els.batchBtn];
  const states = buttons.map((b) => b.disabled);
  buttons.forEach((b) => b.disabled = true);
  try {
    await fn();
    setStatus('Pret');
  } catch (e) {
    console.error(e);
    setStatus('Erreur', true);
    log(`ERREUR: ${e.message || e}`);
  } finally {
    buttons.forEach((b, i) => b.disabled = states[i]);
    els.renderBtn.disabled = !currentMotion;
  }
}

els.vrmInput.addEventListener('change', () => guarded(async () => loadVrm(els.vrmInput.files[0])));
els.bodyFolder.addEventListener('change', updateFileLists);
els.faceFolder.addEventListener('change', updateFileLists);
els.bodySelect.addEventListener('change', autoPairFace);
els.outputFpsMode.addEventListener('change', () => els.customFpsWrap.classList.toggle('hidden', els.outputFpsMode.value !== 'custom'));
els.analyzeBtn.addEventListener('click', () => guarded(async () => analyzePair(selectedBody(), selectedFace())));
els.renderBtn.addEventListener('click', () => guarded(renderSelected));
els.batchBtn.addEventListener('click', () => guarded(batchAll));

document.querySelectorAll('button.view').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('button.view').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  setView(btn.dataset.view);
}));

window.addEventListener('beforeunload', () => {
  if (els.bodyVideo._url) URL.revokeObjectURL(els.bodyVideo._url);
  if (els.faceVideo._url) URL.revokeObjectURL(els.faceVideo._url);
  poseLandmarker?.close?.();
  faceLandmarker?.close?.();
  handLandmarker?.close?.();
});

renderer.render(scene, camera);
setStatus('Pret - charge un VRM');
log('HellCorp Motion Studio V1 charge. Premiere analyse: connexion Internet requise pour charger Three.js, three-vrm et MediaPipe.');
if (!window.showDirectoryPicker) {
  setStatus('Navigateur non supporte', true);
  log('ATTENTION: ce navigateur ne supporte pas l ecriture de dossiers (File System Access API). Ouvre http://127.0.0.1:8765/index.html dans Chrome ou Edge, sinon Rendre les sprites/Batch echoueront.');
}

// DEBUG: teste la capture+retargeting sur une PHOTO statique (pas une video).
// Retire apres diagnostic.
window.__testStaticImage = async (dataUrl, view = 'front', size = 512) => {
  await initVision();
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });
  const poseResult = poseLandmarker.detect(img);
  const lm2d = mirrorLandmarks(poseResult.landmarks?.[0]);
  const lm3d = mirrorLandmarks(poseResult.worldLandmarks?.[0]);
  let rig = null;
  if (lm2d?.length && lm3d?.length) {
    rig = KalidoPose.solve(lm3d, lm2d, { runtime: 'mediapipe', video: img, enableLegs: true });
    fixLimbsIK(rig, poseResult.worldLandmarks?.[0]);
  }
  const handResult = detectHandsCropped(img, poseResult.landmarks?.[0]);
  const hands = solveHands(handResult);
  if (rig && Object.keys(hands).length) rig = { ...rig, ...hands };
  if (rig) fixFingersIK(rig, handLandmarksBySideFrom(handResult));

  resetVrmPose();
  applyBodyFrame({ time: 0, rig }, 1);
  setView(view);
  const renderSize = Math.round(size * supersampleFor(size));
  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  renderScenePostFX(0, renderSize);
  const frameCanvas = copyRenderToWork(size);
  return { renderDataUrl: frameCanvas.toDataURL('image/png'), hadRig: !!rig };
};



function authoredWrap01(v) {
  return ((Number(v || 0) % 1) + 1) % 1;
}

function authoredSmoothstep(t) {
  t = clamp(Number(t || 0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Cyclic support interval. start > end means the interval crosses phase 1 -> 0.
function authoredSupportWeight(phase, interval, fade = 0.06) {
  if (!Array.isArray(interval) || interval.length < 2) return 0;
  const start = authoredWrap01(interval[0]);
  const end = authoredWrap01(interval[1]);
  const p = authoredWrap01(phase);
  let span = authoredWrap01(end - start);
  if (span < 1e-6) span = 1;
  const d = authoredWrap01(p - start);
  if (d > span) return 0;
  const f = Math.max(1e-4, Math.min(Number(fade || 0.06), span * 0.45));
  const enter = authoredSmoothstep(d / f);
  const leave = authoredSmoothstep((span - d) / f);
  return Math.min(enter, leave);
}

function authoredIntervalsWeight(phase, intervals, fade) {
  let w = 0;
  for (const interval of intervals || []) {
    w = Math.max(w, authoredSupportWeight(phase, interval, fade));
  }
  return w;
}

function authoredWorldPosition(boneName) {
  const bone = getBone(boneName);
  if (!bone) return null;
  const p = new THREE.Vector3();
  bone.getWorldPosition(p);
  return p;
}

class AuthoredFootLockV3 {
  constructor(config = {}) {
    this.config = config || {};
    this.anchors = { left: null, right: null };
  }

  reset() {
    this.anchors.left = null;
    this.anchors.right = null;
  }

  weight(side, phase) {
    const intervals = this.config?.[side]?.support || [];
    return authoredIntervalsWeight(phase, intervals, Number(this.config.fade ?? 0.055));
  }

  apply(phase) {
    if (this.config?.enabled === false || !currentVrm) return;

    currentVrm.scene.updateMatrixWorld(true);
    const samples = [];

    for (const side of ['left', 'right']) {
      const weight = this.weight(side, phase);
      const boneName = this.config?.[side]?.bone || `${side}Foot`;
      const pos = authoredWorldPosition(boneName);

      if (weight > 0.02 && !this.anchors[side] && pos) this.anchors[side] = pos.clone();
      if (weight <= 0.002) this.anchors[side] = null;

      if (weight > 0 && pos && this.anchors[side]) {
        samples.push({ weight, delta: this.anchors[side].clone().sub(pos) });
      }
    }

    if (!samples.length) return;

    let total = 0;
    const correction = new THREE.Vector3();
    for (const sample of samples) {
      correction.addScaledVector(sample.delta, sample.weight);
      total += sample.weight;
    }
    if (total > 1e-6) correction.multiplyScalar(1 / total);

    const xzStrength = Number(this.config.xzStrength ?? 0.98);
    const yStrength = Number(this.config.yStrength ?? 0.80);
    const maxCorrection = Number(this.config.maxCorrection ?? 0.14);

    correction.x = clamp(correction.x * xzStrength, -maxCorrection, maxCorrection);
    correction.y = clamp(correction.y * yStrength, -maxCorrection, maxCorrection);
    correction.z = clamp(correction.z * xzStrength, -maxCorrection, maxCorrection);

    // The authored pelvis/root may move freely, but the support ankle is kept
    // in world space. This removes the marionette/string effect without
    // freezing the swing leg or removing the organic pelvis motion.
    currentVrm.scene.position.add(correction);
    currentVrm.scene.updateMatrixWorld(true);
  }
}

function applyAuthoredPoseV3(pose) {
  resetVrmPose();
  for (const [boneName, rot] of Object.entries(pose?.bones || {})) {
    setBoneRotation(boneName, rot, 1);
  }
  if (pose?.root) {
    currentVrm.scene.position.set(
      Number(pose.root.x || 0),
      Number(pose.root.y || 0),
      Number(pose.root.z || 0),
    );
  }

  if (pose?.eyes) {
    const x = Number(pose.eyes.x || 0);
    const y = Number(pose.eyes.y || 0);
    const le = getBone('leftEye');
    const re = getBone('rightEye');
    if (le) le.rotation.set(y, x, 0);
    if (re) re.rotation.set(y, x, 0);
  }

  const em = currentVrm?.expressionManager;
  if (em) {
    em.resetValues();
    const blink = clamp(Number(pose?.expressions?.blink || 0));
    const leftDone = setExpr('blinkLeft', blink);
    const rightDone = setExpr('blinkRight', blink);
    if (!leftDone && !rightDone) setExpr('blink', blink);

    const happy = clamp(Number(pose?.expressions?.happy || 0));
    setFirstExpr(['happy', 'joy'], happy);
    const relaxed = clamp(Number(pose?.expressions?.relaxed || 0));
    setFirstExpr(['relaxed'], relaxed);
    const mouthOpen = clamp(Number(pose?.expressions?.mouthOpen || 0));
    if (mouthOpen > 0) setFirstExpr(['aa', 'a'], mouthOpen);
    em.update();
  }

  currentVrm.scene.updateMatrixWorld(true);
}

window.__renderAuthoredClip = async (clip, profile, options = {}) => {
  if (!currentVrm) throw new Error('Load a VRM before authored rendering.');

  const fps = Number(options.fps || clip?.fps || 30);
  const cycles = Math.max(1, Number(options.cycles || 1));
  const size = Math.max(64, Number(options.size || 512));
  const view = options.view || 'front';
  const outputName = safeName(options.outputName || `${profile?.name || 'character'}_${clip?.name || 'clip'}_${view}`);
  const preRollFrames = Math.max(0, Number(options.preRollFrames ?? 18));
  const runtime = createAuthoredRuntime(clip, profile, { fps });
  const audit = auditAuthoredRuntime(runtime);
  const count = runtime.framesPerCycle * cycles;
  const dt = 1 / fps;
  const layers = { ...(profile?.layers || {}), ...(clip?.layers || {}) };
  const footLock = new AuthoredFootLockV3(layers.footLock || { enabled: false });

  if (audit.warnings?.length) log(`AUTHORED V3 audit warnings: ${audit.warnings.join(' | ')}`);
  else log(`AUTHORED V3 audit OK: seam=${audit.boneLoopDelta.toFixed(4)}, maxStep=${audit.maxAngularStep.toFixed(4)} rad.`);

  const root = await navigator.storage.getDirectory();
  const outDir = await childDir(root, outputName);
  const framesDir = await childDir(outDir, 'frames');
  const renderSize = Math.round(size * supersampleFor(size));

  renderer.setSize(renderSize, renderSize, false);
  updateOrtho();
  setupPostFX(renderSize);
  setView(view);
  els.posterize.checked = false;

  // Deterministic preroll settles spring bones and also acquires the support
  // foot anchor before exported frame zero.
  footLock.reset();
  for (let i = -preRollFrames; i < 0; i++) {
    const pose = runtime.frame(i);
    applyAuthoredPoseV3(pose);
    footLock.apply(pose.phase);
    renderScenePostFX(dt, renderSize);
  }

  for (let i = 0; i < count; i++) {
    const pose = runtime.frame(i);
    applyAuthoredPoseV3(pose);
    footLock.apply(pose.phase);
    renderScenePostFX(dt, renderSize);
    const frameCanvas = copyRenderToWork(size);
    await writeBlob(framesDir, `frame_${String(i).padStart(6, '0')}.png`, await canvasBlob(frameCanvas));
    if ((i & 1) === 0 || i === count - 1) {
      setProgress((i + 1) / count, `Authored V3 ${i + 1}/${count}`);
      await nextFrame();
    }
  }

  const manifest = {
    format: 'HellCorpAuthoredRenderV2',
    character: profile?.name || stem(currentVrmFile),
    vrm: currentVrmFile?.name || null,
    clip: clip?.name || 'authored_clip',
    fps,
    duration: runtime.duration,
    frames_per_cycle: runtime.framesPerCycle,
    cycles,
    frame_count: count,
    frame_size: [size, size],
    view,
    output_name: outputName,
    foot_lock: layers.footLock || null,
    summary: authoredClipSummary(clip, profile),
    quality_audit: audit,
  };
  await writeText(outDir, 'manifest.json', JSON.stringify(manifest, null, 2));

  renderer.setSize(768, 768, false);
  footLock.reset();
  resetVrmPose();
  setView(previewView);
  renderScene();
  setProgress(1, `Authored V3 complete: ${outputName}`);
  log(`AUTHORED V3 complete: ${outputName}, ${count} frames at ${fps} FPS.`);
  return manifest;
};
