const ACTION_COLORS = {
  absent: "#333333",
  idle: "#5a5a5a",
  marcher: "#3ce2e2",
  travailler: "#e2b23c",
  pause: "#3ce26b",
  dormir: "#6b3ce2",
};
const FALLBACK_COLOR = "#8a5cff";

let characters = [];
let actionsCatalog = []; // [{key, label, style, ...}]
let actionsByKey = {};
let currentCharacterKey = null;
let scheduleBlocks = []; // {start_hour, end_hour, action_key, x, y}
let clockState = { hour: 9, day: 1, time_scale_seconds_per_hour: 30, paused: false };

let activeSubpanel = "schedule";
let animOverrides = []; // merged catalog+override, from /api/characters/:key/animations
let currentAnimActionKey = "idle";
let availableAvatars = [];

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function text(tag, className, content) {
  const node = el(tag, className);
  node.textContent = content;
  return node;
}

function formatHour(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

async function loadWhoAmI() {
  const res = await fetch("/api/me");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  const data = await res.json();
  document.getElementById("whoami").textContent = data.username;
}

// --- Clock ---

async function loadClock({ syncInputs } = { syncInputs: false }) {
  const res = await fetch("/api/time");
  if (!res.ok) return;
  clockState = await res.json();

  document.getElementById("clock-day").textContent = clockState.day;
  document.getElementById("clock-hour").textContent = formatHour(clockState.hour);
  document.getElementById("clock-paused-badge").hidden = !clockState.paused;
  document.getElementById("clock-pause-btn").textContent = clockState.paused ? "Reprendre" : "Mettre en pause";

  if (syncInputs) {
    document.getElementById("clock-hour-input").value = clockState.hour;
    document.getElementById("clock-day-input").value = clockState.day;
    document.getElementById("clock-scale-input").value = clockState.time_scale_seconds_per_hour;
  }

  renderTimeline(); // the "now" cursor depends on clockState.hour
}

document.getElementById("clock-apply-btn").addEventListener("click", async () => {
  const hour = parseFloat(document.getElementById("clock-hour-input").value);
  const day = parseInt(document.getElementById("clock-day-input").value, 10);
  const time_scale_seconds_per_hour = parseFloat(document.getElementById("clock-scale-input").value);
  await fetch("/api/time", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hour, day, time_scale_seconds_per_hour }),
  });
  await loadClock({ syncInputs: true });
});

document.getElementById("clock-pause-btn").addEventListener("click", async () => {
  await fetch("/api/time", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused: !clockState.paused }),
  });
  await loadClock({ syncInputs: true });
});

setInterval(() => loadClock({ syncInputs: false }), 2000);

// --- Characters & actions catalog ---

async function loadActions() {
  const res = await fetch("/api/npc-actions");
  actionsCatalog = await res.json();
  actionsByKey = Object.fromEntries(actionsCatalog.map((a) => [a.key, a]));
  renderLegend();
}

function renderLegend() {
  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  actionsCatalog.forEach((a) => {
    const item = el("div", "legend-item");
    const swatch = el("span", "legend-swatch");
    swatch.style.background = ACTION_COLORS[a.key] || FALLBACK_COLOR;
    item.appendChild(swatch);
    item.appendChild(text("span", null, a.label));
    legend.appendChild(item);
  });
}

async function loadCharacters() {
  const res = await fetch("/api/characters");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  characters = await res.json();
  renderCharacterTabs();

  const stillExists = characters.some((c) => c.key === currentCharacterKey);
  if (stillExists) {
    selectCharacter(currentCharacterKey);
  } else if (characters.length > 0) {
    selectCharacter(characters[0].key);
  } else {
    currentCharacterKey = null;
    scheduleBlocks = [];
    animOverrides = [];
    renderScheduleList();
    renderTimeline();
  }
}

function renderCharacterTabs() {
  const wrap = document.getElementById("character-tabs");
  wrap.innerHTML = "";
  characters.forEach((c) => {
    const tab = el("div", "char-tab");
    if (c.key === currentCharacterKey) tab.classList.add("active");
    const img = document.createElement("img");
    img.src = `assets/avatars/${c.avatar_file}`;
    tab.appendChild(img);
    tab.appendChild(text("span", null, c.name));
    tab.addEventListener("click", () => selectCharacter(c.key));
    wrap.appendChild(tab);
  });
}

async function selectCharacter(key) {
  currentCharacterKey = key;
  renderCharacterTabs();
  document.getElementById("schedule-status").textContent = "";

  const res = await fetch(`/api/characters/${key}/schedule`);
  scheduleBlocks = res.ok ? await res.json() : [];
  scheduleBlocks = scheduleBlocks.map((b) => ({ start_hour: b.start_hour, end_hour: b.end_hour, action_key: b.action_key, x: b.x, y: b.y }));

  renderScheduleList();
  renderTimeline();

  updateAnimPreviewImage();
  if (activeSubpanel === "animation") await loadAnimationPanel();
}

document.getElementById("delete-npc-btn").addEventListener("click", async () => {
  if (!currentCharacterKey) return;
  const c = characters.find((c) => c.key === currentCharacterKey);
  const ok = confirm(`Supprimer définitivement ${c?.name || currentCharacterKey} ? Son planning, ses messages et ses événements seront aussi effacés.`);
  if (!ok) return;

  await fetch(`/api/characters/${currentCharacterKey}`, { method: "DELETE" });
  currentCharacterKey = null;
  await loadCharacters();
});

// --- Sub-tabs: Planning / Animation ---

document.querySelectorAll(".sub-tab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    activeSubpanel = btn.dataset.panel;
    document.querySelectorAll(".sub-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("schedule-subpanel").hidden = activeSubpanel !== "schedule";
    document.getElementById("animation-subpanel").hidden = activeSubpanel !== "animation";
    if (activeSubpanel === "animation") await loadAnimationPanel();
  });
});

// --- New NPC creation ---

async function loadAvatars() {
  const res = await fetch("/api/avatars");
  availableAvatars = await res.json();
  const select = document.getElementById("new-npc-avatar");
  select.innerHTML = "";
  availableAvatars.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a.replace(".png", "");
    select.appendChild(opt);
  });
}

document.getElementById("new-npc-btn").addEventListener("click", () => {
  document.getElementById("new-npc-key").value = "";
  document.getElementById("new-npc-name").value = "";
  document.getElementById("new-npc-title").value = "";
  document.getElementById("new-npc-status").textContent = "";
  document.getElementById("new-npc-modal-overlay").hidden = false;
});

document.getElementById("new-npc-cancel-btn").addEventListener("click", () => {
  document.getElementById("new-npc-modal-overlay").hidden = true;
});

document.getElementById("new-npc-create-btn").addEventListener("click", async () => {
  const key = document.getElementById("new-npc-key").value.trim().toLowerCase();
  const name = document.getElementById("new-npc-name").value.trim();
  const title = document.getElementById("new-npc-title").value.trim();
  const avatar_file = document.getElementById("new-npc-avatar").value;
  const accent_color = document.getElementById("new-npc-color").value;
  const statusEl = document.getElementById("new-npc-status");

  const res = await fetch("/api/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, name, title, avatar_file, accent_color }),
  });
  const data = await res.json();
  if (!res.ok) {
    statusEl.textContent = data.error || "Erreur.";
    return;
  }

  document.getElementById("new-npc-modal-overlay").hidden = true;
  await loadCharacters();
  selectCharacter(key);
});

// --- Timeline (24h Gantt-style overview) ---

function renderTimeline() {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";

  scheduleBlocks.forEach((b) => {
    const color = ACTION_COLORS[b.action_key] || FALLBACK_COLOR;
    const label = actionsByKey[b.action_key]?.label || b.action_key;
    if (b.start_hour <= b.end_hour) {
      timeline.appendChild(timelineSegment(b.start_hour, b.end_hour, color, label));
    } else {
      // Wraps past midnight — render as two segments (start..24 and 0..end).
      timeline.appendChild(timelineSegment(b.start_hour, 24, color, label));
      timeline.appendChild(timelineSegment(0, b.end_hour, color, label));
    }
  });

  const cursor = el("div", "timeline-cursor");
  cursor.style.left = `${(clockState.hour / 24) * 100}%`;
  timeline.appendChild(cursor);
}

function timelineSegment(start, end, color, label) {
  const seg = el("div", "timeline-block");
  seg.style.left = `${(start / 24) * 100}%`;
  seg.style.width = `${((end - start) / 24) * 100}%`;
  seg.style.background = color;
  seg.title = label;
  seg.textContent = label;
  return seg;
}

// --- Schedule block list ---

function renderScheduleList() {
  const list = document.getElementById("schedule-list");
  list.innerHTML = "";
  scheduleBlocks.forEach((b, i) => list.appendChild(scheduleRow(b, i)));
}

function scheduleRow(b, i) {
  const row = el("div", "schedule-row");

  const startField = el("div", "field");
  startField.appendChild(text("label", null, "Début (h)"));
  const startInput = document.createElement("input");
  startInput.type = "number";
  startInput.min = 0;
  startInput.max = 24;
  startInput.step = 0.25;
  startInput.value = b.start_hour;
  startInput.addEventListener("input", () => {
    b.start_hour = parseFloat(startInput.value) || 0;
    renderTimeline();
  });
  startField.appendChild(startInput);
  row.appendChild(startField);

  const endField = el("div", "field");
  endField.appendChild(text("label", null, "Fin (h)"));
  const endInput = document.createElement("input");
  endInput.type = "number";
  endInput.min = 0;
  endInput.max = 24;
  endInput.step = 0.25;
  endInput.value = b.end_hour;
  endInput.addEventListener("input", () => {
    b.end_hour = parseFloat(endInput.value) || 0;
    renderTimeline();
  });
  endField.appendChild(endInput);
  row.appendChild(endField);

  const actionField = el("div", "field");
  actionField.appendChild(text("label", null, "Action"));
  const select = document.createElement("select");
  actionsCatalog.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.key;
    opt.textContent = a.label;
    if (a.key === b.action_key) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    b.action_key = select.value;
    renderTimeline();
  });
  actionField.appendChild(select);
  row.appendChild(actionField);

  const posLabel = text("span", "pos-label", `x:${Math.round(b.x)} y:${Math.round(b.y)}`);
  row.appendChild(posLabel);

  const placeBtn = text("button", null, "Placer sur la carte");
  placeBtn.addEventListener("click", () => openPositionModal(i));
  row.appendChild(placeBtn);

  const removeBtn = text("button", "remove-btn", "Supprimer");
  removeBtn.addEventListener("click", () => {
    scheduleBlocks.splice(i, 1);
    renderScheduleList();
    renderTimeline();
  });
  row.appendChild(removeBtn);

  row.dataset.updatePos = "1";
  row._posLabel = posLabel;
  return row;
}

document.getElementById("add-block-btn").addEventListener("click", () => {
  const last = scheduleBlocks[scheduleBlocks.length - 1];
  scheduleBlocks.push({
    start_hour: last ? last.end_hour % 24 : 9,
    end_hour: last ? Math.min(24, (last.end_hour % 24) + 4) : 13,
    action_key: actionsCatalog[0]?.key || "idle",
    x: last ? last.x : 0,
    y: last ? last.y : 0,
  });
  renderScheduleList();
  renderTimeline();
});

document.getElementById("save-schedule-btn").addEventListener("click", async () => {
  if (!currentCharacterKey) return;
  const statusEl = document.getElementById("schedule-status");
  statusEl.textContent = "Sauvegarde...";

  const sorted = [...scheduleBlocks].sort((a, b) => a.start_hour - b.start_hour);
  const res = await fetch(`/api/characters/${currentCharacterKey}/schedule`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sorted),
  });
  if (res.ok) {
    scheduleBlocks = sorted;
    renderScheduleList();
    renderTimeline();
    statusEl.textContent = `Planning sauvegardé (${sorted.length} bloc(s)).`;
  } else {
    statusEl.textContent = "Erreur lors de la sauvegarde.";
  }
});

// --- Position picker modal ---

const posModalOverlay = document.getElementById("position-modal-overlay");
const posCanvas = document.getElementById("position-canvas");
const posCtx = posCanvas.getContext("2d");
const posTitleEl = document.getElementById("position-modal-title");

let posModalIndex = null;
let posBackground = new Image();
let posBackgroundLoaded = false;
let posViewOffsetX = 0;
let posViewOffsetY = 0;
let posPending = null; // {x, y} — not committed until "Valider"
let mapDataCache = null;

async function loadMapDataCache() {
  if (mapDataCache) return mapDataCache;
  const res = await fetch("/api/maps/office_floor?base=1"); // only need the background here, not the live schedule
  mapDataCache = await res.json();
  if (mapDataCache.background_file) {
    posBackground.src = `assets/${mapDataCache.background_file}`;
    posBackground.onload = () => { posBackgroundLoaded = true; drawPositionCanvas(); };
  }
  return mapDataCache;
}

async function openPositionModal(index) {
  posModalIndex = index;
  const b = scheduleBlocks[index];
  posTitleEl.textContent = `${characters.find((c) => c.key === currentCharacterKey)?.name || ""} — ${formatHour(b.start_hour)} → ${formatHour(b.end_hour)}`;
  posPending = { x: b.x, y: b.y };

  await loadMapDataCache();

  posViewOffsetX = b.x - posCanvas.width / 2;
  posViewOffsetY = b.y - posCanvas.height / 2;

  posModalOverlay.hidden = false;
  drawPositionCanvas();
}

function drawPositionCanvas() {
  posCtx.fillStyle = "#2b2320";
  posCtx.fillRect(0, 0, posCanvas.width, posCanvas.height);

  posCtx.save();
  posCtx.translate(-posViewOffsetX, -posViewOffsetY);

  if (posBackgroundLoaded && posBackground.naturalWidth > 0) {
    posCtx.drawImage(posBackground, 0, 0, posBackground.naturalWidth, posBackground.naturalHeight);
  }

  // Other blocks for this character, as small context dots.
  scheduleBlocks.forEach((b, i) => {
    if (i === posModalIndex) return;
    posCtx.fillStyle = "rgba(255, 255, 255, 0.35)";
    posCtx.beginPath();
    posCtx.arc(b.x, b.y, 5, 0, Math.PI * 2);
    posCtx.fill();
  });

  // The pending (not-yet-saved) position for the block being edited.
  if (posPending) {
    posCtx.fillStyle = "#3ce2e2";
    posCtx.strokeStyle = "#0a4a4a";
    posCtx.lineWidth = 2;
    posCtx.beginPath();
    posCtx.arc(posPending.x, posPending.y, 9, 0, Math.PI * 2);
    posCtx.fill();
    posCtx.stroke();
  }

  posCtx.restore();
}

posCanvas.addEventListener("click", (e) => {
  posPending = { x: e.offsetX + posViewOffsetX, y: e.offsetY + posViewOffsetY };
  drawPositionCanvas();
});

posCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    posViewOffsetX += e.deltaX;
    posViewOffsetY += e.deltaY;
    drawPositionCanvas();
  },
  { passive: false }
);

const posPanKeys = new Set();
window.addEventListener("keydown", (e) => {
  if (posModalOverlay.hidden) return;
  const k = e.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
    posPanKeys.add(k);
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => posPanKeys.delete(e.key.toLowerCase()));

let posLastPanTime = performance.now();
function posPanLoop(now) {
  const dt = (now - posLastPanTime) / 1000;
  posLastPanTime = now;
  if (!posModalOverlay.hidden && posPanKeys.size > 0) {
    let dx = 0, dy = 0;
    if (posPanKeys.has("arrowup")) dy -= 1;
    if (posPanKeys.has("arrowdown")) dy += 1;
    if (posPanKeys.has("arrowleft")) dx -= 1;
    if (posPanKeys.has("arrowright")) dx += 1;
    const len = Math.hypot(dx, dy) || 1;
    posViewOffsetX += (dx / len) * 500 * dt;
    posViewOffsetY += (dy / len) * 500 * dt;
    drawPositionCanvas();
  }
  requestAnimationFrame(posPanLoop);
}
requestAnimationFrame(posPanLoop);

document.getElementById("position-cancel-btn").addEventListener("click", () => {
  posModalOverlay.hidden = true;
  posModalIndex = null;
});

document.getElementById("position-save-btn").addEventListener("click", () => {
  if (posModalIndex == null || !posPending) return;
  scheduleBlocks[posModalIndex].x = posPending.x;
  scheduleBlocks[posModalIndex].y = posPending.y;
  posModalOverlay.hidden = true;
  posModalIndex = null;
  renderScheduleList();
});

// --- Animation tuning + live preview ---
// Mirrors the exact drawing math used for the actual NPC render in game.js's drawNpc(), so
// what you see here is genuinely what you'll see in-game — same styles, same formulas.

function sliderRow(labelText, id, min, max, step, value) {
  const row = el("div", "anim-slider-row");
  row.appendChild(text("label", null, labelText));
  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  input.id = id;
  const val = text("span", "val", parseFloat(value).toFixed(2));
  input.addEventListener("input", () => {
    val.textContent = parseFloat(input.value).toFixed(2);
  });
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

function sliderValueOrNull(id) {
  const input = document.getElementById(id);
  return input ? parseFloat(input.value) : null;
}

function renderAnimSliders(entry) {
  const wrap = document.getElementById("anim-sliders");
  wrap.innerHTML = "";
  if (!entry || entry.style === "none") {
    wrap.appendChild(text("p", "hint", "Cette action n'affiche pas le PNJ (absent) — pas d'animation à régler."));
    return;
  }
  if (entry.style === "idle" || entry.style === "walk" || entry.style === "work") {
    wrap.appendChild(sliderRow("Amplitude (px)", "slider-bob-amp", 0, 20, 0.5, entry.bob_amp ?? 3));
    wrap.appendChild(sliderRow("Vitesse (Hz)", "slider-bob-hz", 0.1, 6, 0.1, entry.bob_hz ?? 1));
  }
  if (entry.style === "work") {
    wrap.appendChild(sliderRow("Inclinaison (°)", "slider-tilt-deg", 0, 15, 0.5, entry.tilt_deg ?? 0));
  }
  if (entry.style === "sit" || entry.style === "sleep") {
    wrap.appendChild(sliderRow("Tassement (échelle Y)", "slider-scale-y", 0.3, 1, 0.05, entry.scale_y ?? 0.85));
  }
}

function selectAnimAction(key) {
  currentAnimActionKey = key;
  document.getElementById("anim-action-select").value = key;
  const entry = animOverrides.find((a) => a.key === key);
  renderAnimSliders(entry);
  document.getElementById("anim-override-badge").hidden = !entry?.is_override;
  animPreviewStart = performance.now();
}

async function loadAnimationPanel() {
  if (!currentCharacterKey) return;
  const res = await fetch(`/api/characters/${currentCharacterKey}/animations`);
  animOverrides = res.ok ? await res.json() : [];

  const select = document.getElementById("anim-action-select");
  select.innerHTML = "";
  animOverrides.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.key;
    opt.textContent = a.label;
    select.appendChild(opt);
  });

  const keepKey = animOverrides.some((a) => a.key === currentAnimActionKey) ? currentAnimActionKey : "idle";
  selectAnimAction(keepKey);
}

document.getElementById("anim-action-select").addEventListener("change", (e) => selectAnimAction(e.target.value));

document.getElementById("anim-save-btn").addEventListener("click", async () => {
  if (!currentCharacterKey || !currentAnimActionKey) return;
  const statusEl = document.getElementById("animation-status");
  const body = {
    bob_amp: sliderValueOrNull("slider-bob-amp"),
    bob_hz: sliderValueOrNull("slider-bob-hz"),
    tilt_deg: sliderValueOrNull("slider-tilt-deg"),
    scale_y: sliderValueOrNull("slider-scale-y"),
  };
  const res = await fetch(`/api/characters/${currentCharacterKey}/animations/${currentAnimActionKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    statusEl.textContent = "Animation sauvegardée.";
    await loadAnimationPanel();
  } else {
    statusEl.textContent = "Erreur lors de la sauvegarde.";
  }
});

document.getElementById("anim-reset-btn").addEventListener("click", async () => {
  if (!currentCharacterKey || !currentAnimActionKey) return;
  await fetch(`/api/characters/${currentCharacterKey}/animations/${currentAnimActionKey}`, { method: "DELETE" });
  document.getElementById("animation-status").textContent = "Réinitialisé (valeur par défaut du catalogue).";
  await loadAnimationPanel();
});

const animPreviewImg = new Image();
let animPreviewStart = performance.now();

function updateAnimPreviewImage() {
  const c = characters.find((c) => c.key === currentCharacterKey);
  if (c) animPreviewImg.src = `assets/avatars/${c.avatar_file}`;
}

function drawAnimPreview(now) {
  const canvas = document.getElementById("anim-preview-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (activeSubpanel === "animation" && animPreviewImg.complete && animPreviewImg.naturalWidth > 0) {
    const t = (now - animPreviewStart) / 1000;
    const style = animOverrides.find((a) => a.key === currentAnimActionKey)?.style || "idle";
    const bobAmp = sliderValueOrNull("slider-bob-amp") || 0;
    const bobHz = sliderValueOrNull("slider-bob-hz") || 0;
    const tiltDeg = sliderValueOrNull("slider-tilt-deg") || 0;
    const scaleY = sliderValueOrNull("slider-scale-y");

    const baseH = 140;
    let h = baseH;
    let bobY = 0;
    let tiltRad = 0;
    if (style === "idle" || style === "walk") {
      bobY = Math.sin(t * bobHz * Math.PI * 2) * bobAmp;
    } else if (style === "work") {
      bobY = Math.sin(t * bobHz * Math.PI * 2) * bobAmp;
      tiltRad = (Math.sin(t * bobHz * Math.PI * 2) * tiltDeg * Math.PI) / 180;
    } else if (style === "sit" || style === "sleep") {
      h = baseH * (scaleY != null ? scaleY : 1);
    }
    const w = (animPreviewImg.naturalWidth / animPreviewImg.naturalHeight) * h;

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2 + 50 + bobY);
    if (tiltRad) ctx.rotate(tiltRad);
    ctx.drawImage(animPreviewImg, -w / 2, -h, w, h);
    ctx.restore();
  }

  requestAnimationFrame(drawAnimPreview);
}
requestAnimationFrame(drawAnimPreview);

// --- Boot ---

loadWhoAmI();
loadClock({ syncInputs: true });
loadAvatars();
loadActions().then(loadCharacters);
