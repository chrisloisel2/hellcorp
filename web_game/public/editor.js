const MAP_NAME = "office_floor";
const canvas = document.getElementById("editor");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  redraw();
}
window.addEventListener("resize", resizeCanvas);

// Panning: the map can be much bigger than the screen, so the view can scroll around it
// (WASD / arrow keys, mouse wheel) instead of being stuck showing only the initial corner.
let viewOffsetX = 0;
let viewOffsetY = 0;
function recenterView() {
  viewOffsetX = -canvas.width / 2;
  viewOffsetY = -canvas.height / 2;
  redraw();
}
document.getElementById("recenter-btn").addEventListener("click", recenterView);

function isTypingTarget(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

const panKeys = new Set();
const PAN_KEY_NAMES = ["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"];
window.addEventListener("keydown", (e) => {
  if (isTypingTarget(document.activeElement)) return;
  const k = e.key.toLowerCase();
  if (PAN_KEY_NAMES.includes(k)) {
    panKeys.add(k);
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => panKeys.delete(e.key.toLowerCase()));

const PAN_SPEED = 700; // px/sec
let lastPanTime = performance.now();
function panLoop(now) {
  const dt = (now - lastPanTime) / 1000;
  lastPanTime = now;
  let dx = 0;
  let dy = 0;
  if (panKeys.has("arrowup") || panKeys.has("w")) dy -= 1;
  if (panKeys.has("arrowdown") || panKeys.has("s")) dy += 1;
  if (panKeys.has("arrowleft") || panKeys.has("a")) dx -= 1;
  if (panKeys.has("arrowright") || panKeys.has("d")) dx += 1;
  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    viewOffsetX += (dx / len) * PAN_SPEED * dt;
    viewOffsetY += (dy / len) * PAN_SPEED * dt;
    redraw();
  }
  requestAnimationFrame(panLoop);
}
requestAnimationFrame(panLoop);

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    viewOffsetX += e.deltaX;
    viewOffsetY += e.deltaY;
    redraw();
  },
  { passive: false }
);

const background = new Image();
let hasBackground = false;
background.onload = redraw;

const imgCache = new Map();
function getImg(assetPath) {
  if (!imgCache.has(assetPath)) {
    const img = new Image();
    img.src = `assets/${assetPath}`;
    img.onload = redraw;
    imgCache.set(assetPath, img);
  }
  return imgCache.get(assetPath);
}

const manifests = { tiles: [], furniture: [], newset: [] }; // [{id, file, width, height}]
let assetDims = new Map(); // "category/file" -> {width, height}

let walls = []; // {x, y, w, h}
let sprites = []; // {asset_file, x, y, scale, z_index, blocking}
let npcs = []; // {character_key, x, y, facing, avatar_file, name}
let characterRoster = []; // from /api/characters
let selectedCharacterKey = null;
let npcFlipLeft = false;
const NPC_DRAW_HEIGHT = 130; // matches the player's default height in game.js

let mode = "wall";
let currentCategory = "tiles";
let selectedAssetPath = null;
let blockingEnabled = false;
let currentRotation = 0;
let currentFlipH = false;

// "fit": force the image into exactly one grid cell (for floor tiles, so they interlock).
// "native": keep the asset's real proportions relative to the 128x64 reference — a desk or
// building naturally spans several cells instead of being squashed into one.
const CATEGORY_DEFAULT_SIZEMODE = { tiles: "fit", furniture: "native", newset: "native" };
// Calibrated from each sheet's own "128x64" legend diamond where available; 1 = use raw pixels.
const NATIVE_SCALE = { tiles: 1, furniture: 1, newset: 128 / 120 };
let sizeMode = "fit";
let scaleMultiplier = 1;

// The grid is an isometric diamond lattice, not a square grid — a diamond tile only
// interlocks with its neighbours if placement follows the iso basis vectors below.
// Standard 2:1 dimetric convention (128x64 cell, ~26.565° screen angle — equivalent to an
// orthographic camera at 45° yaw / 30° pitch): tan(angle) = cellH / cellW = 0.5.
let cellW = 128;
let cellH = 64;
const originX = 0;
const originY = 0;

let selected = null; // {type: 'wall'|'sprite', index}
let dragStart = null;
let dragCurrent = null;

const hintEl = document.getElementById("hint");
const statusEl = document.getElementById("status");
const deleteBtn = document.getElementById("delete-selected");
const spriteOptionsEl = document.getElementById("sprite-options");
const orientationOptionsEl = document.getElementById("orientation-options");
const blockingToggle = document.getElementById("blocking-toggle");
const cellWInput = document.getElementById("cell-w");
const cellHInput = document.getElementById("cell-h");
const rotateBtn = document.getElementById("rotate-btn");
const rotateValEl = document.getElementById("rotate-val");
const flipToggle = document.getElementById("flip-toggle");
const scaleMultInput = document.getElementById("scale-mult");
const scaleMultValEl = document.getElementById("scale-mult-val");
const hitboxPanelEl = document.getElementById("hitbox-panel");
const hbX = document.getElementById("hb-x");
const hbY = document.getElementById("hb-y");
const hbW = document.getElementById("hb-w");
const hbH = document.getElementById("hb-h");
const hbResetBtn = document.getElementById("hb-reset");
const hbOpenModalBtn = document.getElementById("hb-open-modal");
const npcOptionsEl = document.getElementById("npc-options");
const npcFlipToggle = document.getElementById("npc-flip-toggle");

const HINTS = {
  wall: "Clique-glisse pour dessiner un mur invisible, aligné sur la grille (rectangle de collision, sans visuel).",
  sprite: "Choisis une tuile ou un meuble, coche \"Mur\" si elle doit bloquer le passage, puis clique une case du losange pour la remplir.",
  npc: "Choisis un personnage puis clique une case pour le placer dans la map.",
  select: "Clique sur un mur, une tuile, un meuble ou un PNJ pour le sélectionner, puis supprime-le.",
};

// --- Isometric lattice: diamond tiles interlock along (colW, 0) and (colW/2, rowH/2) ---

function isoToScreen(col, row) {
  return {
    x: originX + (col - row) * (cellW / 2),
    y: originY + (col + row) * (cellH / 2),
  };
}

function screenToIso(x, y) {
  const dx = x - originX;
  const dy = y - originY;
  return {
    col: dx / cellW + dy / cellH,
    row: dy / cellH - dx / cellW,
  };
}

function setMode(next) {
  mode = next;
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  hintEl.textContent = HINTS[mode];
  spriteOptionsEl.hidden = mode !== "sprite";
  orientationOptionsEl.hidden = mode === "wall" || mode === "npc";
  selected = null;
  deleteBtn.disabled = true;
  syncOrientationUI();
  syncHitboxUI();
  syncNpcUI();
  redraw();
}

// The palette stays visible only while actively placing NPCs; once one is selected for editing
// (flip only, for now) we just show the flip toggle, not the whole character picker again.
function syncNpcUI() {
  const target = mode === "select" && selected?.type === "npc" ? npcs[selected.index] : null;
  npcOptionsEl.hidden = !(mode === "npc" || target);
  document.getElementById("npc-palette").style.display = mode === "npc" ? "" : "none";
  npcFlipToggle.checked = target ? target.facing === -1 : npcFlipLeft;
}

// The hitbox panel only makes sense once something is actually selected.
function syncHitboxUI() {
  if (mode !== "select" || !selected || selected.type === "npc") {
    hitboxPanelEl.hidden = true;
    return;
  }
  hitboxPanelEl.hidden = false;

  if (selected.type === "wall") {
    const w = walls[selected.index];
    hbX.value = Math.round(w.x);
    hbY.value = Math.round(w.y);
    hbW.value = Math.round(w.w);
    hbH.value = Math.round(w.h);
    hbResetBtn.hidden = true;
    hbOpenModalBtn.hidden = true;
  } else {
    const s = sprites[selected.index];
    const box = hitboxOf(s);
    hbX.value = Math.round(box.left - s.x);
    hbY.value = Math.round(box.top - s.y);
    hbW.value = Math.round(box.w);
    hbH.value = Math.round(box.h);
    hbResetBtn.hidden = false;
    hbOpenModalBtn.hidden = false;
  }
}

function applyHitboxInputs() {
  if (!selected) return;
  if (selected.type === "wall") {
    const w = walls[selected.index];
    w.x = parseFloat(hbX.value) || 0;
    w.y = parseFloat(hbY.value) || 0;
    w.w = Math.max(1, parseFloat(hbW.value) || 1);
    w.h = Math.max(1, parseFloat(hbH.value) || 1);
  } else {
    const s = sprites[selected.index];
    s.hitbox_x = parseFloat(hbX.value) || 0;
    s.hitbox_y = parseFloat(hbY.value) || 0;
    s.hitbox_w = Math.max(1, parseFloat(hbW.value) || 1);
    s.hitbox_h = Math.max(1, parseFloat(hbH.value) || 1);
  }
  redraw();
}

[hbX, hbY, hbW, hbH].forEach((input) => input.addEventListener("input", applyHitboxInputs));

hbResetBtn.addEventListener("click", () => {
  if (!selected || selected.type !== "sprite") return;
  const s = sprites[selected.index];
  s.hitbox_x = null;
  s.hitbox_y = null;
  s.hitbox_w = null;
  s.hitbox_h = null;
  s.hitbox_mask = null;
  s.hitbox_mask_cols = null;
  s.hitbox_mask_rows = null;
  syncHitboxUI();
  redraw();
});

// --- Hitbox modal: draw the collision box directly over the sprite's own pixels ---

const modalOverlayEl = document.getElementById("hitbox-modal-overlay");
const modalCanvas = document.getElementById("modal-canvas");
const modalCtx = modalCanvas.getContext("2d");
const modalSpriteNameEl = document.getElementById("modal-sprite-name");
const modalSmartBtn = document.getElementById("modal-smart");
const modalFullBtn = document.getElementById("modal-full");
const modalClearBtn = document.getElementById("modal-clear");
const modalCancelBtn = document.getElementById("modal-cancel");
const modalSaveBtn = document.getElementById("modal-save");

let modalSpriteIndex = null;
let modalImg = null;
let modalZoom = 1;
let modalCols = 0;
let modalRows = 0;
let modalCellPx = 1; // native image pixels per paintable cell
let modalPaint = []; // flat row-major boolean array, length cols*rows
let modalPainting = false;
let modalPaintValue = true; // true = paint, false = erase, fixed for the duration of a drag

// Coarse-grained pixel painting: fine enough to trace a real silhouette, coarse enough to
// paint/erase in a couple of strokes instead of pixel-by-pixel.
function computeMaskGrid(naturalWidth, naturalHeight) {
  const TARGET_CELLS_ACROSS_LONG_SIDE = 28;
  const cellPx = Math.max(2, Math.round(Math.max(naturalWidth, naturalHeight) / TARGET_CELLS_ACROSS_LONG_SIDE));
  return {
    cellPx,
    cols: Math.max(1, Math.ceil(naturalWidth / cellPx)),
    rows: Math.max(1, Math.ceil(naturalHeight / cellPx)),
  };
}

function openHitboxModal(index) {
  const s = sprites[index];
  const img = getImg(s.asset_file);
  if (!img.complete || img.naturalWidth === 0) return; // not loaded yet, ignore the click

  modalSpriteIndex = index;
  modalImg = img;
  modalZoom = Math.max(0.5, Math.min(8, 560 / Math.max(img.naturalWidth, img.naturalHeight)));

  const grid = computeMaskGrid(img.naturalWidth, img.naturalHeight);
  modalCols = grid.cols;
  modalRows = grid.rows;
  modalCellPx = grid.cellPx;
  modalCanvas.width = modalCols * modalCellPx * modalZoom;
  modalCanvas.height = modalRows * modalCellPx * modalZoom;
  modalSpriteNameEl.textContent = s.asset_file.split("/").pop();

  if (s.hitbox_mask && s.hitbox_mask_cols === modalCols && s.hitbox_mask_rows === modalRows) {
    modalPaint = s.hitbox_mask.split("").map((c) => c === "1");
  } else if (s.hitbox_w != null && s.hitbox_h != null) {
    // no mask yet, but there's a legacy rectangle hitbox — paint the cells it covers as a
    // sensible starting point instead of throwing that adjustment away
    const localX = s.hitbox_x / s.scale + img.naturalWidth / 2;
    const localY = s.hitbox_y / s.scale + img.naturalHeight;
    const localW = s.hitbox_w / s.scale;
    const localH = s.hitbox_h / s.scale;
    modalPaint = new Array(modalCols * modalRows).fill(false);
    for (let row = 0; row < modalRows; row++) {
      for (let col = 0; col < modalCols; col++) {
        const cx = (col + 0.5) * modalCellPx;
        const cy = (row + 0.5) * modalCellPx;
        if (cx >= localX && cx <= localX + localW && cy >= localY && cy <= localY + localH) {
          modalPaint[row * modalCols + col] = true;
        }
      }
    }
  } else {
    modalPaint = new Array(modalCols * modalRows).fill(true); // brand new — matches the old "whole image" default
  }

  modalOverlayEl.hidden = false;
  drawModal();
}

function drawModal() {
  const cellDisplay = modalCellPx * modalZoom;
  modalCtx.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
  modalCtx.drawImage(modalImg, 0, 0, modalImg.naturalWidth * modalZoom, modalImg.naturalHeight * modalZoom);

  for (let row = 0; row < modalRows; row++) {
    for (let col = 0; col < modalCols; col++) {
      if (!modalPaint[row * modalCols + col]) continue;
      modalCtx.fillStyle = "rgba(226, 60, 60, 0.45)";
      modalCtx.fillRect(col * cellDisplay, row * cellDisplay, cellDisplay, cellDisplay);
    }
  }

  modalCtx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  modalCtx.lineWidth = 1;
  for (let col = 0; col <= modalCols; col++) {
    modalCtx.beginPath();
    modalCtx.moveTo(col * cellDisplay + 0.5, 0);
    modalCtx.lineTo(col * cellDisplay + 0.5, modalRows * cellDisplay);
    modalCtx.stroke();
  }
  for (let row = 0; row <= modalRows; row++) {
    modalCtx.beginPath();
    modalCtx.moveTo(0, row * cellDisplay + 0.5);
    modalCtx.lineTo(modalCols * cellDisplay, row * cellDisplay + 0.5);
    modalCtx.stroke();
  }
}

function paintCellAt(e) {
  const cellDisplay = modalCellPx * modalZoom;
  const col = Math.floor(e.offsetX / cellDisplay);
  const row = Math.floor(e.offsetY / cellDisplay);
  if (col < 0 || col >= modalCols || row < 0 || row >= modalRows) return;
  modalPaint[row * modalCols + col] = modalPaintValue;
  drawModal();
}

modalCanvas.addEventListener("contextmenu", (e) => e.preventDefault()); // right-click erases instead of opening a menu

modalCanvas.addEventListener("mousedown", (e) => {
  modalPainting = true;
  modalPaintValue = e.button !== 2; // left click (or any non-right button) paints, right click erases
  paintCellAt(e);
});

modalCanvas.addEventListener("mousemove", (e) => {
  if (!modalPainting) return;
  paintCellAt(e);
});

window.addEventListener("mouseup", () => {
  modalPainting = false;
});

// The "smart" mask: paint exactly the cells that contain at least one non-transparent pixel,
// read straight from the image's own alpha channel — a real silhouette, not just a box.
function computeSmartMask() {
  const off = document.createElement("canvas");
  off.width = modalImg.naturalWidth;
  off.height = modalImg.naturalHeight;
  const offCtx = off.getContext("2d", { willReadFrequently: true });
  offCtx.drawImage(modalImg, 0, 0);
  const { data } = offCtx.getImageData(0, 0, off.width, off.height);

  const ALPHA_THRESHOLD = 10;
  const paint = new Array(modalCols * modalRows).fill(false);
  for (let row = 0; row < modalRows; row++) {
    const y0 = row * modalCellPx;
    const y1 = Math.min(off.height, y0 + modalCellPx);
    for (let col = 0; col < modalCols; col++) {
      const x0 = col * modalCellPx;
      const x1 = Math.min(off.width, x0 + modalCellPx);
      let filled = false;
      for (let y = y0; y < y1 && !filled; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * off.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
            filled = true;
            break;
          }
        }
      }
      paint[row * modalCols + col] = filled;
    }
  }
  return paint;
}

modalSmartBtn.addEventListener("click", () => {
  modalPaint = computeSmartMask();
  drawModal();
});

modalFullBtn.addEventListener("click", () => {
  modalPaint = new Array(modalCols * modalRows).fill(true);
  drawModal();
});

modalClearBtn.addEventListener("click", () => {
  modalPaint = new Array(modalCols * modalRows).fill(false);
  drawModal();
});

modalCancelBtn.addEventListener("click", () => {
  modalOverlayEl.hidden = true;
  modalSpriteIndex = null;
});

// Tight bounding box (in image-local pixels) of the painted cells — kept in hitbox_x/y/w/h
// too, purely so the inline numeric panel has something sensible to display.
function maskBoundingBoxLocal() {
  let minCol = modalCols, minRow = modalRows, maxCol = -1, maxRow = -1;
  for (let row = 0; row < modalRows; row++) {
    for (let col = 0; col < modalCols; col++) {
      if (!modalPaint[row * modalCols + col]) continue;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }
  if (maxCol < minCol) return null;
  const x = minCol * modalCellPx;
  const y = minRow * modalCellPx;
  const w = Math.min(modalImg.naturalWidth, (maxCol + 1) * modalCellPx) - x;
  const h = Math.min(modalImg.naturalHeight, (maxRow + 1) * modalCellPx) - y;
  return { x, y, w, h };
}

modalSaveBtn.addEventListener("click", () => {
  if (modalSpriteIndex == null) return;
  const s = sprites[modalSpriteIndex];
  s.hitbox_mask = modalPaint.map((v) => (v ? "1" : "0")).join("");
  s.hitbox_mask_cols = modalCols;
  s.hitbox_mask_rows = modalRows;

  const bbox = maskBoundingBoxLocal();
  if (bbox) {
    s.hitbox_x = (bbox.x - modalImg.naturalWidth / 2) * s.scale;
    s.hitbox_y = (bbox.y - modalImg.naturalHeight) * s.scale;
    s.hitbox_w = bbox.w * s.scale;
    s.hitbox_h = bbox.h * s.scale;
  }

  modalOverlayEl.hidden = true;
  modalSpriteIndex = null;
  syncHitboxUI();
  redraw();
});

hbOpenModalBtn.addEventListener("click", () => {
  if (!selected || selected.type !== "sprite") return;
  openHitboxModal(selected.index);
});

// The rotate/flip/size controls do double duty: in "sprite" mode they set the defaults for the
// NEXT placement; in "select" mode (with a sprite selected) they edit that sprite in place.
function syncOrientationUI() {
  const target = mode === "select" && selected?.type === "sprite" ? sprites[selected.index] : null;
  const rotation = target ? target.rotation : currentRotation;
  const flip = target ? target.flip_h : currentFlipH;
  rotateValEl.textContent = `${rotation}°`;
  flipToggle.checked = !!flip;

  const sm = target ? target.size_mode || "native" : sizeMode;
  const mult = target ? target.scale_multiplier || 1 : scaleMultiplier;
  document.querySelectorAll("[data-sizemode]").forEach((b) => b.classList.toggle("active", b.dataset.sizemode === sm));
  scaleMultInput.value = mult;
  scaleMultValEl.textContent = mult.toFixed(2);
}

// Combines the fit-to-cell / native-size base with the manual multiplier.
function computeScale(assetPath, dims, mode_, multiplier) {
  const category = assetPath.split("/")[0];
  const base = mode_ === "fit" ? fitScaleForCell(dims) : (NATIVE_SCALE[category] || 1);
  return base * multiplier;
}

rotateBtn.addEventListener("click", () => {
  if (mode === "select" && selected?.type === "sprite") {
    const s = sprites[selected.index];
    s.rotation = (s.rotation + 90) % 360;
  } else {
    currentRotation = (currentRotation + 90) % 360;
  }
  syncOrientationUI();
  redraw();
});

flipToggle.addEventListener("change", () => {
  if (mode === "select" && selected?.type === "sprite") {
    sprites[selected.index].flip_h = flipToggle.checked;
  } else {
    currentFlipH = flipToggle.checked;
  }
  redraw();
});

document.querySelectorAll("[data-sizemode]").forEach((b) => {
  b.addEventListener("click", () => {
    if (mode === "select" && selected?.type === "sprite") {
      const s = sprites[selected.index];
      s.size_mode = b.dataset.sizemode;
      s.is_floor = b.dataset.sizemode === "fit";
      s.scale_multiplier = s.scale_multiplier || 1;
      s.scale = computeScale(s.asset_file, assetDims.get(s.asset_file), s.size_mode, s.scale_multiplier);
      // the old hitbox no longer matches the new size — fall back to auto until re-adjusted
      s.hitbox_x = s.hitbox_y = s.hitbox_w = s.hitbox_h = null;
      s.hitbox_mask = s.hitbox_mask_cols = s.hitbox_mask_rows = null;
      syncHitboxUI();
    } else {
      sizeMode = b.dataset.sizemode;
    }
    syncOrientationUI();
    redraw();
  });
});

scaleMultInput.addEventListener("input", () => {
  const mult = parseFloat(scaleMultInput.value);
  if (mode === "select" && selected?.type === "sprite") {
    const s = sprites[selected.index];
    s.scale_multiplier = mult;
    s.size_mode = s.size_mode || "native";
    s.scale = computeScale(s.asset_file, assetDims.get(s.asset_file), s.size_mode, mult);
  } else {
    scaleMultiplier = mult;
  }
  scaleMultValEl.textContent = mult.toFixed(2);
  redraw();
});

npcFlipToggle.addEventListener("change", () => {
  const target = mode === "select" && selected?.type === "npc" ? npcs[selected.index] : null;
  if (target) target.facing = npcFlipToggle.checked ? -1 : 1;
  else npcFlipLeft = npcFlipToggle.checked;
  redraw();
});

document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

document.querySelectorAll("[data-category]").forEach((b) => {
  b.addEventListener("click", () => {
    currentCategory = b.dataset.category;
    document.querySelectorAll("[data-category]").forEach((el) => el.classList.toggle("active", el === b));
    selectedAssetPath = null;
    sizeMode = CATEGORY_DEFAULT_SIZEMODE[currentCategory] || "native";
    scaleMultiplier = 1;
    syncOrientationUI();
    renderPalette();
  });
});

blockingToggle.addEventListener("change", () => { blockingEnabled = blockingToggle.checked; });
cellWInput.addEventListener("input", () => {
  cellW = Math.max(8, parseFloat(cellWInput.value) || 128);
  redraw();
});
cellHInput.addEventListener("input", () => {
  cellH = Math.max(8, parseFloat(cellHInput.value) || 64);
  redraw();
});

// --- Background controls ---

document.querySelectorAll(".bg-btn").forEach((b) => {
  b.addEventListener("click", async () => {
    const file = b.dataset.bg || null;
    await fetch(`/api/maps/${MAP_NAME}/background`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    applyBackground(file);
  });
});

function applyBackground(file) {
  hasBackground = !!file;
  if (hasBackground) background.src = `assets/${file}`;
  document.querySelectorAll(".bg-btn").forEach((b) => b.classList.toggle("active", (b.dataset.bg || null) === file));
  redraw();
}

// --- Palette ---

async function loadPalette() {
  const [tilesRes, furnitureRes, newsetRes] = await Promise.all([
    fetch("assets/tiles/manifest.json"),
    fetch("assets/furniture/manifest.json"),
    fetch("assets/newset/manifest.json"),
  ]);
  manifests.tiles = (await tilesRes.json()).map((item) => ({ ...item, category: "tiles" }));
  manifests.furniture = (await furnitureRes.json()).map((item) => ({ ...item, category: "furniture" }));
  manifests.newset = (await newsetRes.json()).map((item) => ({ ...item, category: "newset" }));

  [...manifests.tiles, ...manifests.furniture, ...manifests.newset].forEach((item) => {
    assetDims.set(`${item.category}/${item.file}`, { width: item.width, height: item.height });
  });

  renderPalette();
}

function renderPalette() {
  const palette = document.getElementById("palette");
  palette.innerHTML = "";
  manifests[currentCategory].forEach((item) => {
    const assetPath = `${item.category}/${item.file}`;
    const div = document.createElement("div");
    div.className = "palette-item";
    if (assetPath === selectedAssetPath) div.classList.add("selected");
    const img = document.createElement("img");
    img.src = `assets/${assetPath}`;
    div.appendChild(img);
    div.addEventListener("click", () => {
      selectedAssetPath = assetPath;
      document.querySelectorAll(".palette-item").forEach((el) => el.classList.remove("selected"));
      div.classList.add("selected");
      if (mode !== "sprite") setMode("sprite");
    });
    palette.appendChild(div);
  });
}

// --- NPC roster & palette ---

async function loadCharacterRoster() {
  const res = await fetch("/api/characters");
  if (!res.ok) return;
  characterRoster = await res.json();
  characterRoster.forEach((c) => getImg(`avatars/${c.avatar_file}`));
  renderNpcPalette();
}

function renderNpcPalette() {
  const el = document.getElementById("npc-palette");
  el.innerHTML = "";
  characterRoster.forEach((c) => {
    const div = document.createElement("div");
    div.className = "palette-item npc-item";
    if (c.key === selectedCharacterKey) div.classList.add("selected");
    const img = document.createElement("img");
    img.src = `assets/avatars/${c.avatar_file}`;
    div.appendChild(img);
    const label = document.createElement("div");
    label.className = "palette-label";
    label.textContent = c.name;
    div.appendChild(label);
    div.addEventListener("click", () => {
      selectedCharacterKey = c.key;
      document.querySelectorAll("#npc-palette .palette-item").forEach((it) => it.classList.remove("selected"));
      div.classList.add("selected");
      if (mode !== "npc") setMode("npc");
    });
    el.appendChild(div);
  });
}

// The world-space bounding box for an NPC's avatar sprite, drawn at a fixed reference height
// (same convention as the player in game.js) rather than fit-to-cell like floor tiles.
function npcBox(n) {
  const img = getImg(`avatars/${n.avatar_file}`);
  const h = NPC_DRAW_HEIGHT;
  const w = img.naturalWidth > 0 ? (img.naturalWidth / img.naturalHeight) * h : h;
  return { left: n.x - w / 2, right: n.x + w / 2, top: n.y - h, bottom: n.y, w, h };
}

// --- Map data ---

async function loadMapData() {
  const res = await fetch(`/api/maps/${MAP_NAME}?base=1`); // base placements, not the live schedule-adjusted ones
  const data = await res.json();

  applyBackground(data.background_file || null);

  walls = (data.walls || []).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
  sprites = (data.sprites || []).map((s) => ({
    asset_file: s.asset_file,
    x: s.x,
    y: s.y,
    scale: s.scale,
    z_index: s.z_index,
    blocking: !!s.blocking,
    rotation: s.rotation || 0,
    flip_h: !!s.flip_h,
    is_floor: !!s.is_floor,
    hitbox_x: s.hitbox_x ?? null,
    hitbox_y: s.hitbox_y ?? null,
    hitbox_w: s.hitbox_w ?? null,
    hitbox_h: s.hitbox_h ?? null,
    hitbox_mask: s.hitbox_mask ?? null,
    hitbox_mask_cols: s.hitbox_mask_cols ?? null,
    hitbox_mask_rows: s.hitbox_mask_rows ?? null,
    size_mode: s.is_floor ? "fit" : "native", // editor-only metadata (not persisted); re-editing recomputes from here
    scale_multiplier: 1,
  }));
  sprites.forEach((s) => getImg(s.asset_file));

  npcs = (data.npcs || []).map((n) => ({
    character_key: n.character_key,
    x: n.x,
    y: n.y,
    facing: n.facing || 1,
    avatar_file: n.avatar_file,
    name: n.name,
  }));
  npcs.forEach((n) => getImg(`avatars/${n.avatar_file}`));

  redraw();
}

// A 90°/270° rotation swaps the on-screen footprint; flipping alone does not.
function spriteBox(s) {
  const dims = assetDims.get(s.asset_file) || { width: 0, height: 0 };
  const localW = dims.width * s.scale;
  const localH = dims.height * s.scale;
  const rotated = s.rotation === 90 || s.rotation === 270;
  const w = rotated ? localH : localW;
  const h = rotated ? localW : localH;
  return { left: s.x - w / 2, right: s.x + w / 2, top: s.y - h, bottom: s.y, w, h, localW, localH };
}

// The actual collision box — a custom override if one was set (via the hitbox panel),
// otherwise an auto box capped to one tile's depth (cellH) at the sprite's base, not its full
// image height. Matches game.js's hitboxOf(): wall/furniture art is drawn tall to show its
// vertical face, but only its base stands on a tile, so the auto box must not reach into the
// tile rows behind it (see game.js for the full explanation of the bug this avoids).
function hitboxOf(s) {
  if (s.hitbox_w != null && s.hitbox_h != null) {
    const left = s.x + (s.hitbox_x || 0);
    const top = s.y + (s.hitbox_y || 0);
    return { left, top, right: left + s.hitbox_w, bottom: top + s.hitbox_h, w: s.hitbox_w, h: s.hitbox_h };
  }
  const b = spriteBox(s);
  const depth = Math.min(b.h, cellH);
  return { left: b.left, top: b.bottom - depth, right: b.right, bottom: b.bottom, w: b.w, h: depth };
}

// Every item is scaled so its largest dimension fits exactly one grid cell — same size, same anchor for everything.
function fitScaleForCell(dims) {
  return Math.min(cellW / dims.width, cellH / dims.height);
}

function snapToLattice(x, y) {
  const iso = screenToIso(x, y);
  const col = Math.round(iso.col);
  const row = Math.round(iso.row);
  return { col, row, ...isoToScreen(col, row) };
}

canvas.addEventListener("mousedown", (e) => {
  const x = e.offsetX + viewOffsetX;
  const y = e.offsetY + viewOffsetY;

  if (mode === "wall") {
    const snapped = snapToLattice(x, y);
    dragStart = { x: snapped.x, y: snapped.y };
    dragCurrent = { x: snapped.x, y: snapped.y };
  } else if (mode === "sprite") {
    if (!selectedAssetPath) {
      statusEl.textContent = "Choisis d'abord une tuile ou un meuble dans la palette.";
      return;
    }
    const dims = assetDims.get(selectedAssetPath) || { width: cellW, height: cellH };
    const snapped = snapToLattice(x, y);
    sprites.push({
      asset_file: selectedAssetPath,
      x: snapped.x,
      y: snapped.y + cellH / 2, // bottom-anchor: from the diamond's center down to its bottom vertex
      scale: computeScale(selectedAssetPath, dims, sizeMode, scaleMultiplier),
      z_index: 0,
      blocking: blockingEnabled,
      rotation: currentRotation,
      flip_h: currentFlipH,
      is_floor: sizeMode === "fit",
      hitbox_x: null,
      hitbox_y: null,
      hitbox_w: null,
      hitbox_h: null,
      hitbox_mask: null,
      hitbox_mask_cols: null,
      hitbox_mask_rows: null,
      size_mode: sizeMode,
      scale_multiplier: scaleMultiplier,
    });
    redraw();
  } else if (mode === "npc") {
    if (!selectedCharacterKey) {
      statusEl.textContent = "Choisis d'abord un personnage dans la palette.";
      return;
    }
    const c = characterRoster.find((c) => c.key === selectedCharacterKey);
    if (!c) return;
    const snapped = snapToLattice(x, y);
    npcs.push({
      character_key: c.key,
      x: snapped.x,
      y: snapped.y + cellH / 2, // feet-anchored, same convention as sprites/player
      facing: npcFlipLeft ? -1 : 1,
      avatar_file: c.avatar_file,
      name: c.name,
    });
    redraw();
  } else if (mode === "select") {
    selected = null;
    for (let i = npcs.length - 1; i >= 0; i--) {
      const b = npcBox(npcs[i]);
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
        selected = { type: "npc", index: i };
        break;
      }
    }
    if (!selected) {
      for (let i = sprites.length - 1; i >= 0; i--) {
        const b = spriteBox(sprites[i]);
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
          selected = { type: "sprite", index: i };
          break;
        }
      }
    }
    if (!selected) {
      for (let i = walls.length - 1; i >= 0; i--) {
        const w = walls[i];
        if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) {
          selected = { type: "wall", index: i };
          break;
        }
      }
    }
    deleteBtn.disabled = !selected;
    syncOrientationUI();
    syncHitboxUI();
    syncNpcUI();
    redraw();
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (mode === "wall" && dragStart) {
    const snapped = snapToLattice(e.offsetX + viewOffsetX, e.offsetY + viewOffsetY);
    dragCurrent = { x: snapped.x, y: snapped.y };
    redraw();
  }
});

window.addEventListener("mouseup", () => {
  if (mode === "wall" && dragStart && dragCurrent) {
    const x = Math.min(dragStart.x, dragCurrent.x);
    const y = Math.min(dragStart.y, dragCurrent.y);
    const w = Math.abs(dragCurrent.x - dragStart.x);
    const h = Math.abs(dragCurrent.y - dragStart.y);
    if (w >= 8 && h >= 8) walls.push({ x, y, w, h });
  }
  dragStart = null;
  dragCurrent = null;
  redraw();
});

deleteBtn.addEventListener("click", () => {
  if (!selected) return;
  if (selected.type === "wall") walls.splice(selected.index, 1);
  else if (selected.type === "npc") npcs.splice(selected.index, 1);
  else sprites.splice(selected.index, 1);
  selected = null;
  deleteBtn.disabled = true;
  syncOrientationUI();
  syncHitboxUI();
  syncNpcUI();
  redraw();
});

window.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && selected) {
    e.preventDefault();
    deleteBtn.click();
  }
});

document.getElementById("save").addEventListener("click", async () => {
  statusEl.textContent = "Sauvegarde...";
  const [r1, r2, r3] = await Promise.all([
    fetch(`/api/maps/${MAP_NAME}/walls`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(walls),
    }),
    fetch(`/api/maps/${MAP_NAME}/sprites`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sprites),
    }),
    fetch(`/api/maps/${MAP_NAME}/npcs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(npcs.map((n) => ({ character_key: n.character_key, x: n.x, y: n.y, facing: n.facing }))),
    }),
  ]);
  if (r1.ok && r2.ok && r3.ok) {
    const blockingCount = sprites.filter((s) => s.blocking).length;
    statusEl.textContent = `Sauvegardé (${walls.length} murs invisibles, ${sprites.length} sprites dont ${blockingCount} bloquants, ${npcs.length} PNJ).`;
  } else {
    statusEl.textContent = "Erreur lors de la sauvegarde.";
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

async function loadWhoAmI() {
  const res = await fetch("/api/me");
  if (res.ok) {
    const data = await res.json();
    document.getElementById("whoami").textContent = data.username;
  }
}

function drawGrid() {
  // Find the range of iso (col,row) whose diamonds could touch the canvas, from the 4 corners
  // of the currently visible (panned) viewport, in world space.
  const corners = [
    screenToIso(viewOffsetX, viewOffsetY),
    screenToIso(viewOffsetX + canvas.width, viewOffsetY),
    screenToIso(viewOffsetX, viewOffsetY + canvas.height),
    screenToIso(viewOffsetX + canvas.width, viewOffsetY + canvas.height),
  ];
  const colMin = Math.floor(Math.min(...corners.map((c) => c.col))) - 1;
  const colMax = Math.ceil(Math.max(...corners.map((c) => c.col))) + 1;
  const rowMin = Math.floor(Math.min(...corners.map((c) => c.row))) - 1;
  const rowMax = Math.ceil(Math.max(...corners.map((c) => c.row))) + 1;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  for (let col = colMin; col <= colMax; col++) {
    for (let row = rowMin; row <= rowMax; row++) {
      const { x: cx, y: cy } = isoToScreen(col, row);
      ctx.beginPath();
      ctx.moveTo(cx, cy - cellH / 2);
      ctx.lineTo(cx + cellW / 2, cy);
      ctx.lineTo(cx, cy + cellH / 2);
      ctx.lineTo(cx - cellW / 2, cy);
      ctx.closePath();
      ctx.stroke();
    }
  }
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#2b2320";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-viewOffsetX, -viewOffsetY);

  // Anchored at world (0,0) at its native size, so it pans with everything else.
  if (hasBackground && background.complete && background.naturalWidth > 0) {
    ctx.drawImage(background, 0, 0, background.naturalWidth, background.naturalHeight);
  }

  drawGrid();

  function drawOneSprite(s, i) {
    const img = getImg(s.asset_file);
    const b = spriteBox(s);
    if (img.complete && img.naturalWidth > 0) {
      ctx.save();
      ctx.translate(s.x, s.y - b.h / 2); // rotate around the sprite's own center
      if (s.rotation) ctx.rotate((s.rotation * Math.PI) / 180);
      if (s.flip_h) ctx.scale(-1, 1);
      ctx.drawImage(img, -b.localW / 2, -b.localH / 2, b.localW, b.localH);
      ctx.restore();

      if (s.blocking) {
        const hb = hitboxOf(s);
        ctx.strokeStyle = "rgba(226, 60, 60, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(hb.left, hb.top, hb.w, hb.h);
        ctx.setLineDash([]);
      }
    }
    if (selected && selected.type === "sprite" && selected.index === i) {
      ctx.strokeStyle = "#3ce2e2";
      ctx.lineWidth = 2;
      ctx.strokeRect(b.left, b.top, b.w, b.h);
    }
  }

  function drawOneNpc(n, i) {
    const img = getImg(`avatars/${n.avatar_file}`);
    const b = npcBox(n);
    if (img.complete && img.naturalWidth > 0) {
      ctx.save();
      if (n.facing === -1) {
        ctx.translate(n.x, 0);
        ctx.scale(-1, 1);
        ctx.translate(-n.x, 0);
      }
      ctx.drawImage(img, b.left, b.top, b.w, b.h);
      ctx.restore();
    }
    if (selected && selected.type === "npc" && selected.index === i) {
      ctx.strokeStyle = "#3ce2e2";
      ctx.lineWidth = 2;
      ctx.strokeRect(b.left, b.top, b.w, b.h);
    }
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(n.name || "", n.x, b.top - 4);
  }

  // Floor tiles are flat ground decoration — draw them first, underneath everything, so a
  // tile "in front" (a bigger row) never ends up drawn on top of a tall object or the player
  // standing behind/on it (that's the depth bug this split fixes). NPCs share the Y-sorted
  // layer with non-floor sprites since they're full-height characters, just like the player.
  const indexed = sprites.map((s, i) => ({ s, i }));
  indexed.filter(({ s }) => s.is_floor).forEach(({ s, i }) => drawOneSprite(s, i));
  const nonFloorEntities = [
    ...indexed.filter(({ s }) => !s.is_floor).map(({ s, i }) => ({ y: s.y, draw: () => drawOneSprite(s, i) })),
    ...npcs.map((n, i) => ({ y: n.y, draw: () => drawOneNpc(n, i) })),
  ];
  nonFloorEntities.sort((a, b) => a.y - b.y).forEach((e) => e.draw());

  walls.forEach((w, i) => {
    ctx.fillStyle = "rgba(226, 60, 60, 0.25)";
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = selected && selected.type === "wall" && selected.index === i ? "#3ce2e2" : "#e23c3c";
    ctx.lineWidth = 2;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  });

  if (mode === "wall" && dragStart && dragCurrent) {
    const x = Math.min(dragStart.x, dragCurrent.x);
    const y = Math.min(dragStart.y, dragCurrent.y);
    const w = Math.abs(dragCurrent.x - dragStart.x);
    const h = Math.abs(dragCurrent.y - dragStart.y);
    ctx.fillStyle = "rgba(226, 60, 60, 0.35)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#e23c3c";
    ctx.strokeRect(x, y, w, h);
  }

  ctx.restore();
}

resizeCanvas();
recenterView();
setMode("wall");
loadWhoAmI();
loadPalette();
loadCharacterRoster();
loadMapData();
