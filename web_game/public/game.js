const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const MAP_NAME = "office_floor";

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

const background = new Image();
let hasBackground = false;

const sprite = new Image();
sprite.src = "assets/character_lucy.png";

// A fixed world spawn point — not tied to canvas size, so it stays correct regardless of
// the player's window size now that the camera pans over a world that can be bigger than it.
const player = {
  x: 0,
  y: 0,
  drawHeight: 130,
  drawWidth: 0,
  speed: 260, // px/sec
  facing: 1,
  moving: false,
};

// The world can be bigger than the screen; the camera follows the player instead of
// the map being clamped to whatever the browser window happens to be.
const camera = { x: 0, y: 0 };
function updateCamera() {
  camera.x = player.x - canvas.width / 2;
  camera.y = player.y - canvas.height / 2;
}

function applyPlayerHeight(height) {
  player.drawHeight = height;
  if (sprite.naturalWidth > 0) {
    const scale = player.drawHeight / sprite.naturalHeight;
    player.drawWidth = sprite.naturalWidth * scale;
  }
}

sprite.onload = () => applyPlayerHeight(player.drawHeight);

let walls = [];
let mapSprites = []; // { asset_file, x, y, scale, z_index, img }
let npcs = []; // { character_key, x, y, facing, avatar_file, name, title, accent_color, img }

const NPC_DRAW_HEIGHT = 130; // same reference height as the player, see editor.js
const INTERACT_RADIUS = 110;
let nearbyNpc = null;
let dialogueOpen = false;

// --- Experimental: real walk-cycle frames from HellCorp Motion Studio (VRM + mocap), first
// test wired for Lucy only, front view only, and currently also driving the player's own
// sprite while they move (see drawPlayer) so it's actually visible without needing to force
// an NPC's schedule. This replaces the procedural bob/tilt fake-walk with genuine per-frame
// motion. Once validated, this hardcoded map should become a real per-character/per-pose
// asset lookup (probably driven by the `characters` table) instead of a special case here.
const WALK_ATLASES = {
  lucy: { src: "characters/lucy/world/walk_front_atlas.png", cols: 8, cellSize: 512, frameCount: 28, fps: 10 },
};
const walkAtlasImages = {};
Object.entries(WALK_ATLASES).forEach(([key, cfg]) => {
  const img = new Image();
  img.onload = () => { cfg.bbox = computeAtlasBBox(img, cfg); };
  img.src = `assets/${cfg.src}`;
  walkAtlasImages[key] = img;
});

// Each cell has a lot of transparent margin around the character (Motion Studio frames every
// pose with headroom so raised arms etc. never clip), so drawing a raw cell at the target
// height makes her look tiny. Scan every frame's alpha channel once on load and keep the union
// of their opaque bounding boxes — one stable crop rect shared by all frames, so height reads
// correctly on screen and her feet don't jitter frame to frame from differing per-frame crops.
function computeAtlasBBox(img, cfg) {
  const cell = cfg.cellSize;
  const off = document.createElement("canvas");
  off.width = cell;
  off.height = cell;
  const octx = off.getContext("2d");
  let minX = cell, minY = cell, maxX = -1, maxY = -1;
  for (let i = 0; i < cfg.frameCount; i++) {
    const col = i % cfg.cols;
    const row = Math.floor(i / cfg.cols);
    octx.clearRect(0, 0, cell, cell);
    octx.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell, cell);
    const data = octx.getImageData(0, 0, cell, cell).data;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        if (data[(y * cell + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, w: cell, h: cell }; // fully transparent atlas — fall back to the raw cell
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Draws one character's current walk-cycle frame, cropped to its shared bbox and scaled to a
// target height `h`. Assumes the caller has already translated to the character's world
// position; `feetY` is where the character's feet should land relative to that origin (0 for
// the NPC convention where the translate origin already IS the feet, drawHeight/2 for the
// player's center-anchored convention).
function drawAtlasFrame(atlasImg, cfg, animT, h, feetY) {
  const bbox = cfg.bbox || { x: 0, y: 0, w: cfg.cellSize, h: cfg.cellSize };
  const frame = Math.floor(animT * cfg.fps) % cfg.frameCount;
  const col = frame % cfg.cols;
  const row = Math.floor(frame / cfg.cols);
  const cell = cfg.cellSize;
  const scale = h / bbox.h;
  const w = bbox.w * scale;
  ctx.drawImage(
    atlasImg,
    col * cell + bbox.x, row * cell + bbox.y, bbox.w, bbox.h,
    -w / 2, feetY - h, w, h
  );
}

// Shared by loadMap() and refreshNpcs() so a freshly-appearing NPC is built the same way
// regardless of which one first saw it.
function makeNpc(n) {
  const img = new Image();
  img.src = `assets/avatars/${n.avatar_file}`;
  return { ...n, img, renderX: n.x, renderY: n.y, walking: false };
}

async function loadMap() {
  const res = await fetch(`/api/maps/${MAP_NAME}`);
  if (res.status === 401) {
    window.location.href = "/login.html";
    return;
  }
  const data = await res.json();
  walls = data.walls || [];

  hasBackground = !!data.background_file;
  if (hasBackground) background.src = `assets/${data.background_file}`;

  mapSprites = (data.sprites || []).map((s) => {
    const img = new Image();
    img.src = `assets/${s.asset_file}`;
    return { ...s, img };
  });

  npcs = (data.npcs || []).map(makeNpc);
}

// Every collision box (auto full-image or mask-based) is ultimately derived from each sprite's
// *loaded* natural width/height — before that, hitboxOf()/spriteFullBox() have nothing to work
// with. Resolves once every sprite image has settled (loaded or failed), so the nav grid built
// right after can see furniture whose image hadn't arrived yet at the very first boot-time pass.
function waitForSpriteImages() {
  return Promise.all(
    mapSprites.map(
      (s) =>
        s.img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              s.img.onload = resolve;
              s.img.onerror = resolve;
            })
    )
  );
}

// Re-fetches the map's NPC block (positions/actions only change on schedule-block boundaries,
// game-time-hours apart) so the game world reflects the Gestion PNJ schedule without a reload.
async function refreshNpcs() {
  const res = await fetch(`/api/maps/${MAP_NAME}`);
  if (!res.ok) return;
  const data = await res.json();
  const fresh = data.npcs || [];

  const byKey = new Map(npcs.map((n) => [n.character_key, n]));
  const freshKeys = new Set(fresh.map((f) => f.character_key));
  npcs = npcs.filter((n) => freshKeys.has(n.character_key));

  fresh.forEach((f) => {
    const existing = byKey.get(f.character_key);
    if (!existing) {
      npcs.push(makeNpc(f));
      return;
    }
    applyNpcUpdate(existing, f);
  });
}

// --- NPC pathfinding: a coarse walkable grid over the map's own collision data (walls +
// blocking sprites), so a scheduled NPC actually walks around furniture instead of sliding
// through it in a straight line. Built lazily/once, extended on demand if a point falls
// outside the current bounds (e.g. a schedule places someone far from the furnished area). ---

let navGrid = null; // { cellSize, minCol, maxCol, minRow, maxRow, blocked: Set<"col,row"> }
const NAV_CELL_SIZE = 48;

// A fixed reference humanoid footprint for NPC pathfinding — same shallow-feet-band shape as
// playerRect()/PLAYER_FOOT_DEPTH, but deliberately NOT tied to player.drawWidth/drawHeight.
// Those are (a) not yet loaded this early at boot (a real race that produced a broken,
// too-small grid) and (b) live-adjustable by the player via the "Taille" slider, which must
// never silently invalidate every NPC's path.
const NAV_HALF_WIDTH = 40;
const NAV_BOTTOM_REACH = 90; // reference distance from an NPC's anchor (center, like the player) down to their feet
const NAV_FOOT_DEPTH = 32; // matches PLAYER_FOOT_DEPTH

function navRect(x, y) {
  const feetY = y + NAV_BOTTOM_REACH;
  return { left: x - NAV_HALF_WIDTH, right: x + NAV_HALF_WIDTH, top: feetY - NAV_FOOT_DEPTH, bottom: feetY };
}

function navWorldToCell(x, y) {
  return { col: Math.floor(x / navGrid.cellSize), row: Math.floor(y / navGrid.cellSize) };
}
function navCellCenter(col, row) {
  return { x: col * navGrid.cellSize + navGrid.cellSize / 2, y: row * navGrid.cellSize + navGrid.cellSize / 2 };
}
function navKey(col, row) {
  return `${col},${row}`;
}

function buildNavGrid(extraPoints) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  walls.forEach((w) => {
    consider(w.x, w.y);
    consider(w.x + w.w, w.y + w.h);
  });
  mapSprites.forEach((s) => {
    if (!s.blocking) return;
    const b = hitboxOf(s);
    consider(b.x, b.y);
    consider(b.x + b.w, b.y + b.h);
  });
  (extraPoints || []).forEach((p) => consider(p.x, p.y));
  if (!isFinite(minX)) {
    minX = minY = -500;
    maxX = maxY = 500;
  }
  const PAD = 250;
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;

  const cellSize = NAV_CELL_SIZE;
  const minCol = Math.floor(minX / cellSize);
  const maxCol = Math.ceil(maxX / cellSize);
  const minRow = Math.floor(minY / cellSize);
  const maxRow = Math.ceil(maxY / cellSize);

  const blocked = new Set();
  for (let col = minCol; col <= maxCol; col++) {
    for (let row = minRow; row <= maxRow; row++) {
      const c = col * cellSize + cellSize / 2;
      const r = row * cellSize + cellSize / 2;
      if (rectBlocked(navRect(c, r))) blocked.add(`${col},${row}`);
    }
  }
  navGrid = { cellSize, minCol, maxCol, minRow, maxRow, blocked };
}

function navOutOfBounds(x, y) {
  const { col, row } = navWorldToCell(x, y);
  return col < navGrid.minCol || col > navGrid.maxCol || row < navGrid.minRow || row > navGrid.maxRow;
}

function navHeuristic(a, b) {
  return Math.hypot(a.col - b.col, a.row - b.row);
}

// 8-directional A* with corner-cutting disallowed (a diagonal step is blocked if either of the
// two orthogonal cells it "cuts through" is blocked) — otherwise NPCs would clip table corners.
function findPath(fromX, fromY, toX, toY) {
  if (!navGrid || navOutOfBounds(fromX, fromY) || navOutOfBounds(toX, toY)) {
    buildNavGrid([{ x: fromX, y: fromY }, { x: toX, y: toY }]);
  }

  const start = navWorldToCell(fromX, fromY);
  const goal = navWorldToCell(toX, toY);
  if (navGrid.blocked.has(navKey(goal.col, goal.row))) return [{ x: toX, y: toY }]; // unreachable cell — walk straight as a fallback

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const startKey = navKey(start.col, start.row);
  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const open = new Map([[startKey, { col: start.col, row: start.row, f: navHeuristic(start, goal) }]]);
  const closed = new Set();

  let iterations = 0;
  const MAX_ITERATIONS = 5000;

  while (open.size > 0 && iterations++ < MAX_ITERATIONS) {
    let currentKey = null;
    let current = null;
    for (const [k, v] of open) {
      if (!current || v.f < current.f) {
        current = v;
        currentKey = k;
      }
    }
    open.delete(currentKey);
    closed.add(currentKey);

    if (current.col === goal.col && current.row === goal.row) {
      const path = [];
      let ck = currentKey;
      while (ck) {
        const [c, r] = ck.split(",").map(Number);
        path.unshift(navCellCenter(c, r));
        ck = cameFrom.get(ck);
      }
      path.push({ x: toX, y: toY }); // exact target, not just its cell's center
      return path.slice(1); // drop the starting cell (we're already there)
    }

    for (const [dc, dr] of DIRS) {
      const nc = current.col + dc;
      const nr = current.row + dr;
      // Cells outside the built grid were never checked against real geometry — treat them as
      // impassable rather than implicitly "open", or the search could wander into unvalidated
      // territory just past the padding.
      if (nc < navGrid.minCol || nc > navGrid.maxCol || nr < navGrid.minRow || nr > navGrid.maxRow) continue;
      const nk = navKey(nc, nr);
      if (closed.has(nk) || navGrid.blocked.has(nk)) continue;
      if (dc !== 0 && dr !== 0) {
        if (navGrid.blocked.has(navKey(current.col + dc, current.row)) || navGrid.blocked.has(navKey(current.col, current.row + dr))) continue;
      }
      const stepCost = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
      const g = gScore.get(currentKey) + stepCost;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        cameFrom.set(nk, currentKey);
        open.set(nk, { col: nc, row: nr, f: g + navHeuristic({ col: nc, row: nr }, goal) });
      }
    }
  }
  return [{ x: toX, y: toY }]; // no path found within budget — walk straight rather than freeze
}

const NPC_WALK_SPEED = 90; // px/s

// Merges a fresh server snapshot into an already-rendered NPC, starting a walk along a real
// pathfound route toward the new position if it moved while already present (a schedule block
// boundary was just crossed).
function applyNpcUpdate(existing, fresh) {
  const wasPresent = existing.present;
  const oldTargetX = existing.x;
  const oldTargetY = existing.y;
  const img = existing.img;
  const renderX = existing.renderX;
  const renderY = existing.renderY;

  Object.assign(existing, fresh);
  existing.img = img;

  if (!wasPresent || !fresh.present) {
    existing.renderX = fresh.x;
    existing.renderY = fresh.y;
    existing.walking = false;
    return;
  }

  existing.renderX = renderX;
  existing.renderY = renderY;
  const dist = Math.hypot(fresh.x - oldTargetX, fresh.y - oldTargetY);
  if (dist > 1) {
    existing.walkPath = findPath(renderX, renderY, fresh.x, fresh.y);
    existing.walkSegIndex = 0;
    existing.walking = true;
  }
}

function updateNpcRenderPositions(dt) {
  let remainingBudget = NPC_WALK_SPEED * dt;
  for (const n of npcs) {
    if (!n.walking) continue;
    let remaining = remainingBudget;
    while (remaining > 0 && n.walkSegIndex < n.walkPath.length) {
      const target = n.walkPath[n.walkSegIndex];
      const dx = target.x - n.renderX;
      const dy = target.y - n.renderY;
      const dist = Math.hypot(dx, dy);
      if (dist <= remaining) {
        n.renderX = target.x;
        n.renderY = target.y;
        remaining -= dist;
        n.walkSegIndex++;
      } else {
        n.renderX += (dx / dist) * remaining;
        n.renderY += (dy / dist) * remaining;
        remaining = 0;
      }
    }
    if (n.walkSegIndex >= n.walkPath.length) n.walking = false;
  }
}

async function loadWhoAmI() {
  const res = await fetch("/api/me");
  if (res.ok) {
    const data = await res.json();
    document.getElementById("whoami").textContent = data.username;
  }
}

async function loadCharacterHeight() {
  const res = await fetch("/api/state");
  if (!res.ok) return;
  const state = await res.json();
  applyPlayerHeight(state.character_height);
  const sizeInput = document.getElementById("character-size");
  if (sizeInput) sizeInput.value = state.character_height;
}

const sizeInput = document.getElementById("character-size");
if (sizeInput) {
  let saveTimeout = null;
  sizeInput.addEventListener("input", () => {
    applyPlayerHeight(parseFloat(sizeInput.value));
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      fetch("/api/state/character-height", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ height: player.drawHeight }),
      });
    }, 300);
  });
}

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

// Dofus-style footprint: only a shallow band right at the character's feet blocks movement,
// not the torso/head. The old box reached all the way up to drawHeight/4 above center (over
// half the sprite), so approaching a wall from the front stopped the player with a huge gap
// between their feet and the wall's base — collision was effectively being decided by the
// character's chest, not their feet. A fixed pixel depth (not a fraction of drawHeight) keeps
// the footprint stable as the player resizes their character via the "Taille" slider.
const PLAYER_FOOT_DEPTH = 32;

function playerRect(x, y) {
  const feetY = y + player.drawHeight / 2;
  return {
    left: x - player.drawWidth / 2,
    right: x + player.drawWidth / 2,
    top: feetY - PLAYER_FOOT_DEPTH,
    bottom: feetY,
  };
}

// A 90°/270° rotation swaps the on-screen footprint; flipping alone does not.
function effectiveSpriteDims(s) {
  const localW = s.img.naturalWidth * s.scale;
  const localH = s.img.naturalHeight * s.scale;
  const rotated = s.rotation === 90 || s.rotation === 270;
  return { w: rotated ? localH : localW, h: rotated ? localW : localH, localW, localH };
}

// A custom hitbox (set in the editor) overrides the auto box — useful when the visible
// silhouette is much bigger than what should actually block movement (e.g. a statue's base
// vs. its outstretched wings).
//
// The auto box itself is capped to one tile's worth of depth (matches the editor's 64px
// dimetric cell height, see cellH in editor.js) rather than the sprite's full pixel height.
// Wall/furniture art is drawn tall to show its vertical face, but only its base actually
// stands on a tile — using the full height as the hitbox made that collision box reach 2-3
// tile rows behind the sprite, so the player's head would "hit" the floor of the tile above
// well before their feet ever got near the object.
const AUTO_HITBOX_DEPTH = 64;

function hitboxOf(s) {
  if (s.hitbox_w != null && s.hitbox_h != null) {
    return { x: s.x + (s.hitbox_x || 0), y: s.y + (s.hitbox_y || 0), w: s.hitbox_w, h: s.hitbox_h };
  }
  const { w, h } = effectiveSpriteDims(s);
  const depth = Math.min(h, AUTO_HITBOX_DEPTH);
  return { x: s.x - w / 2, y: s.y - depth, w, h: depth };
}

// The whole-image world box the painted hitbox mask is laid over (rotation isn't applied to
// the mask — same simplification as the rectangle hitbox above).
function spriteFullBox(s) {
  const { w, h } = effectiveSpriteDims(s);
  return { x: s.x - w / 2, y: s.y - h, w, h };
}

function rectsOverlap(a, b) {
  return a.left < b.x + b.w && a.right > b.x && a.top < b.y + b.h && a.bottom > b.y;
}

// Painted per-cell hitbox: only the cells the player's rect overlaps are checked, so this
// stays cheap even for a fine grid.
function maskBlocksRect(s, r) {
  const box = spriteFullBox(s);
  const cellW = box.w / s.hitbox_mask_cols;
  const cellH = box.h / s.hitbox_mask_rows;
  const colStart = Math.max(0, Math.floor((r.left - box.x) / cellW));
  const colEnd = Math.min(s.hitbox_mask_cols - 1, Math.floor((r.right - box.x) / cellW));
  const rowStart = Math.max(0, Math.floor((r.top - box.y) / cellH));
  const rowEnd = Math.min(s.hitbox_mask_rows - 1, Math.floor((r.bottom - box.y) / cellH));
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      if (s.hitbox_mask[row * s.hitbox_mask_cols + col] === "1") return true;
    }
  }
  return false;
}

// Shared by the player's own movement collision and the NPC nav grid below — each just passes
// a differently-sized clearance rect (the player's current, adjustable size vs. a fixed
// reference humanoid footprint for pathfinding).
function rectBlocked(r) {
  if (walls.some((w) => rectsOverlap(r, w))) return true;

  for (const s of mapSprites) {
    if (!s.blocking || !s.img.complete || s.img.naturalWidth === 0) continue;
    if (s.hitbox_mask) {
      if (rectsOverlap(r, spriteFullBox(s)) && maskBlocksRect(s, r)) return true;
    } else if (rectsOverlap(r, hitboxOf(s))) {
      return true;
    }
  }
  return false;
}

function collidesWithWalls(x, y) {
  return rectBlocked(playerRect(x, y));
}

function update(dt) {
  if (dialogueOpen) { player.moving = false; return; } // frozen while talking to an NPC

  let dx = 0;
  let dy = 0;

  if (keys.has("arrowup") || keys.has("z") || keys.has("w")) dy -= 1;
  if (keys.has("arrowdown") || keys.has("s")) dy += 1;
  if (keys.has("arrowleft") || keys.has("q") || keys.has("a")) dx -= 1;
  if (keys.has("arrowright") || keys.has("d")) dx += 1;

  player.moving = dx !== 0 || dy !== 0;
  if (!player.moving) return;

  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;
  if (dx !== 0) player.facing = dx > 0 ? 1 : -1;

  const stepX = dx * player.speed * dt;
  const stepY = dy * player.speed * dt;

  // Movement is bounded by wall collision only — the world is no longer clamped to
  // the size of the browser window now that the camera can pan over a bigger map.
  const nextX = player.x + stepX;
  if (!collidesWithWalls(nextX, player.y)) player.x = nextX;

  const nextY = player.y + stepY;
  if (!collidesWithWalls(player.x, nextY)) player.y = nextY;
}

function drawBackground() {
  // Anchored at world (0,0) at its native size, so it pans with the camera like everything else.
  if (hasBackground && background.complete && background.naturalWidth > 0) {
    ctx.drawImage(background, 0, 0, background.naturalWidth, background.naturalHeight);
  }
}

function drawMapSprite(s) {
  if (!s.img.complete || s.img.naturalWidth === 0) return;
  const { h, localW, localH } = effectiveSpriteDims(s);

  ctx.save();
  ctx.translate(s.x, s.y - h / 2); // rotate around the sprite's own center
  if (s.rotation) ctx.rotate((s.rotation * Math.PI) / 180);
  if (s.flip_h) ctx.scale(-1, 1);
  ctx.drawImage(s.img, -localW / 2, -localH / 2, localW, localH);
  ctx.restore();
}

// NPCs use a fixed reference height (like the player) rather than fit-to-cell — same
// convention as npcBox() in editor.js, so placements look identical in both views.
function npcDims(n) {
  const h = NPC_DRAW_HEIGHT;
  const w = n.img.naturalWidth > 0 ? (n.img.naturalWidth / n.img.naturalHeight) * h : h;
  return { w, h };
}

// Every action in the server's catalog (server/npc_actions.js) carries its own little
// animation "style" — this is the only place that interprets those styles into an actual
// drawing, so a new action just needs a case here plus an entry in the catalog.
function drawNpc(n, animT) {
  if (!n.present || !n.img.complete || n.img.naturalWidth === 0) return;
  const { w, h: baseH } = npcDims(n);
  const style = n.walking ? "walk" : n.action?.style || "idle";
  const anim = n.walking ? { bobAmp: 6, bobHz: 2.2 } : n.action || {};

  let h = baseH;
  let bobY = 0;
  let tiltRad = 0;

  if (style === "idle" || style === "walk") {
    bobY = Math.sin(animT * (anim.bobHz || 1) * Math.PI * 2) * (anim.bobAmp || 0);
  } else if (style === "work") {
    bobY = Math.sin(animT * (anim.bobHz || 1) * Math.PI * 2) * (anim.bobAmp || 0);
    tiltRad = (Math.sin(animT * (anim.bobHz || 1) * Math.PI * 2) * (anim.tiltDeg || 0) * Math.PI) / 180;
  } else if (style === "sit" || style === "sleep") {
    h = baseH * (anim.scaleY != null ? anim.scaleY : 1);
  }

  // Experimental: swap in the real mocap walk-cycle frames for whoever has one (see
  // WALK_ATLASES above), instead of just bobbing the static avatar up and down.
  const atlasCfg = WALK_ATLASES[n.character_key];
  const atlasImg = walkAtlasImages[n.character_key];
  const useAtlas = n.walking && atlasCfg && atlasImg && atlasImg.complete && atlasImg.naturalWidth > 0;

  ctx.save();
  ctx.translate(n.renderX, n.renderY + (useAtlas ? 0 : bobY));
  if (tiltRad) ctx.rotate(tiltRad);
  if (n.facing === -1) ctx.scale(-1, 1);
  if (useAtlas) {
    drawAtlasFrame(atlasImg, atlasCfg, animT, h, 0); // renderY is already the feet in the NPC convention
  } else {
    ctx.drawImage(n.img, -w / 2, -h, w, h);
  }
  ctx.restore();

  ctx.fillStyle = n === nearbyNpc ? "#ffd27a" : "#f2e9df";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(n.name || "", n.renderX, n.renderY - h - 6);

  if (anim.emoji && !n.walking) {
    ctx.font = "16px sans-serif";
    ctx.fillText(anim.emoji, n.renderX, n.renderY - h - 22);
  }
}

// The closest NPC within interaction range, or null — recomputed every frame so the prompt
// tracks the player walking in and out of range. Absent NPCs (off-schedule right now) can't
// be interacted with even if their world coordinates would otherwise be in range.
function updateNearbyNpc() {
  let best = null;
  let bestDist = INTERACT_RADIUS;
  for (const n of npcs) {
    if (!n.present) continue;
    const d = Math.hypot(player.x - n.renderX, player.y - n.renderY);
    if (d < bestDist) {
      best = n;
      bestDist = d;
    }
  }
  nearbyNpc = best;

  const prompt = document.getElementById("interact-prompt");
  if (nearbyNpc && !dialogueOpen) {
    prompt.textContent = `Appuie sur E pour parler à ${nearbyNpc.name}`;
    prompt.hidden = false;
  } else {
    prompt.hidden = true;
  }
}

// The player's own sprite while walking (see WALK_ATLASES) — same experiment as drawNpc's
// mocap frames, just driven by real keyboard movement instead of a schedule, so it's directly
// testable by walking around.
const PLAYER_WALK_ATLAS = "lucy";

function drawPlayer(animT) {
  if (!player.drawWidth) return;
  const atlasCfg = WALK_ATLASES[PLAYER_WALK_ATLAS];
  const atlasImg = walkAtlasImages[PLAYER_WALK_ATLAS];
  const useAtlas = player.moving && atlasCfg && atlasImg && atlasImg.complete && atlasImg.naturalWidth > 0;

  ctx.save();
  ctx.translate(player.x, player.y);
  if (player.facing === -1) ctx.scale(-1, 1);
  if (useAtlas) {
    drawAtlasFrame(atlasImg, atlasCfg, animT, player.drawHeight, player.drawHeight / 2);
  } else {
    ctx.drawImage(sprite, -player.drawWidth / 2, -player.drawHeight / 2, player.drawWidth, player.drawHeight);
  }
  ctx.restore();
}

function draw() {
  // Fill the whole viewport first (outside the camera transform) so there's no gap
  // wherever the world doesn't cover, e.g. past the edges of a smaller map.
  ctx.fillStyle = "#2b2320";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  drawBackground();

  // Floor tiles are flat ground decoration — draw them all first, underneath everything,
  // regardless of row. Otherwise a tile one row "in front" (a bigger y-sort key) can end up
  // drawn on top of a tall object or the character standing behind/on it, clipping them.
  mapSprites.filter((s) => s.is_floor).forEach((s) => drawMapSprite(s));

  const animT = performance.now() / 1000;
  const entities = [
    ...mapSprites.filter((s) => !s.is_floor).map((s) => ({ y: s.y, draw: () => drawMapSprite(s) })),
    ...npcs.filter((n) => n.present).map((n) => ({ y: n.renderY, draw: () => drawNpc(n, animT) })),
    { y: player.y + player.drawHeight / 2, draw: () => drawPlayer(animT) },
  ];
  entities.sort((a, b) => a.y - b.y);
  entities.forEach((e) => e.draw());

  ctx.restore();
}

// --- NPC dialogue overlay: reuses the same API and CSS classes as messages.html/js,
// just rendered as a single in-world modal instead of a full conversation-list page. ---

const STAT_LABELS = { affinity: "Affinité", trust: "Confiance", respect: "Respect", attraction: "Attraction", fear: "Peur", rivalry: "Rivalité" };
const TONE_LABELS = { chaleureux: "Chaleureux", professionnel: "Professionnel", distant: "Distant", taquin: "Taquin" };

function dlgEl(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function dlgText(tag, className, content) {
  const node = dlgEl(tag, className);
  node.textContent = content;
  return node;
}

function dialogueStatBars(character) {
  const wrap = document.getElementById("dlg-details");
  wrap.innerHTML = "";
  Object.keys(STAT_LABELS).forEach((stat) => {
    const row = dlgEl("div", "stat-row");
    row.appendChild(dlgText("span", "stat-label", STAT_LABELS[stat]));
    const track = dlgEl("div", "stat-track");
    const fill = dlgEl("div", "stat-fill");
    fill.style.width = `${character[stat]}%`;
    fill.style.setProperty("--accent", character.accent_color);
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(dlgText("span", null, character[stat]));
    wrap.appendChild(row);
  });
}

function dialogueMessageBubble(m) {
  if (m.kind === "event") {
    const card = dlgEl("div", "event-card");
    card.appendChild(dlgText("div", "event-tag", "Événement"));
    card.appendChild(dlgText("div", "event-body", m.body));
    return card;
  }
  const cls = m.sender === "player" ? (m.kind === "choice" ? "bubble choice" : "bubble player") : "bubble character";
  return dlgText("div", cls, m.body);
}

async function openDialogue(key) {
  const res = await fetch(`/api/characters/${key}/messages`);
  if (!res.ok) return;
  const data = await res.json();
  const { character, messages, events, memories } = data;

  dialogueOpen = true;
  document.getElementById("dialogue-overlay").hidden = false;
  document.getElementById("interact-prompt").hidden = true;

  document.getElementById("dlg-avatar").src = `assets/avatars/${character.avatar_file}`;
  document.getElementById("dlg-name").textContent = character.name;
  document.getElementById("dlg-title").textContent = character.title;
  document.querySelector(".dialogue-box").style.setProperty("--accent", character.accent_color);

  dialogueStatBars(character);

  const sentimentEl = document.getElementById("dlg-sentiment");
  sentimentEl.innerHTML = "";
  character.sentiment.forEach((line) => sentimentEl.appendChild(dlgText("div", null, line)));

  document.getElementById("dlg-memories").textContent =
    memories.length > 0 ? `${memories.length} souvenir(s) débloqué(s) : ${memories.map((m) => m.title).join(", ")}` : "";

  const scroll = document.getElementById("dlg-scroll");
  scroll.innerHTML = "";
  messages.forEach((m) => scroll.appendChild(dialogueMessageBubble(m)));
  scroll.scrollTop = scroll.scrollHeight;

  const replyBar = document.getElementById("dlg-replybar");
  replyBar.innerHTML = "";
  replyBar.classList.remove("event-choices");
  const pendingEvent = events.find((e) => e.status !== "completed");
  if (pendingEvent) {
    replyBar.classList.add("event-choices");
    pendingEvent.choices.forEach((choice) => {
      const btn = dlgText("button", null, choice.label);
      btn.addEventListener("click", () => sendDialogueChoice(pendingEvent.id, choice.id, key));
      replyBar.appendChild(btn);
    });
  } else {
    Object.entries(TONE_LABELS).forEach(([tone, label]) => {
      const btn = dlgText("button", null, label);
      btn.addEventListener("click", () => sendDialogueTone(key, tone));
      replyBar.appendChild(btn);
    });
  }
}

function closeDialogue() {
  dialogueOpen = false;
  document.getElementById("dialogue-overlay").hidden = true;
}

async function sendDialogueTone(key, tone) {
  await fetch(`/api/characters/${key}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tone }),
  });
  openDialogue(key);
}

async function sendDialogueChoice(eventId, choiceId, key) {
  await fetch(`/api/events/${eventId}/choice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choice_id: choiceId }),
  });
  openDialogue(key);
}

document.getElementById("dlg-close").addEventListener("click", closeDialogue);
document.getElementById("dlg-details-toggle").addEventListener("click", () => {
  document.getElementById("dlg-details").classList.toggle("open");
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dialogueOpen) {
    closeDialogue();
    return;
  }
  if ((e.key === "e" || e.key === "E") && !dialogueOpen && nearbyNpc) {
    openDialogue(nearbyNpc.character_key);
  }
});

let lastTime = performance.now();
function loop(now) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  update(dt);
  updateCamera();
  updateNpcRenderPositions(dt);
  updateNearbyNpc();
  draw();

  requestAnimationFrame(loop);
}

// Schedule blocks only ever change on the hour scale, so a coarse poll is plenty to catch a
// block boundary (or an admin edit from the Gestion PNJ window) without hammering the server.
setInterval(refreshNpcs, 5000);

// --- Quest tracker (top-right) ---
// "completed"/"failed" aren't real quest categories server-side (every quest has a gameplay
// category like "contracts"), they're view filters layered on top, same as the reference sheet.
const QUEST_FILTERS = [
  { key: "", label: "Tous" },
  { key: "main", label: "Principal" },
  { key: "contracts", label: "Contrats" },
  { key: "recruitment", label: "Recrutement" },
  { key: "relationships", label: "Relations" },
  { key: "completed", label: "Terminées" },
  { key: "failed", label: "Échouées" },
];

let quests = [];
let questFilter = "";
let questTrackerOpen = false;
const previousQuestStatuses = new Map(); // key -> last known status, to detect changes worth a toast

function questStatusIcon(status) {
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  return "⏳";
}

function questMatchesFilter(q) {
  if (questFilter === "") return true;
  if (questFilter === "completed") return q.status === "completed";
  if (questFilter === "failed") return q.status === "failed";
  return q.category === questFilter;
}

async function loadQuests({ silent }) {
  const res = await fetch("/api/quests");
  if (!res.ok) return;
  const fresh = await res.json();

  fresh.forEach((q) => {
    const prev = previousQuestStatuses.get(q.key);
    if (silent) {
      if (prev === undefined) showQuestToast("new", q);
      else if (prev !== q.status && (q.status === "completed" || q.status === "failed")) showQuestToast(q.status, q);
    }
    previousQuestStatuses.set(q.key, q.status);
  });

  quests = fresh;
  document.getElementById("quest-active-count").textContent = quests.filter((q) => q.status === "active").length;
  renderQuestList();
}

function renderQuestFilters() {
  const wrap = document.getElementById("quest-filters");
  wrap.innerHTML = "";
  QUEST_FILTERS.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "quest-filter-btn";
    if (f.key === questFilter) btn.classList.add("active");
    btn.textContent = f.label;
    btn.addEventListener("click", () => {
      questFilter = f.key;
      renderQuestFilters();
      renderQuestList();
    });
    wrap.appendChild(btn);
  });
}

function questCard(q) {
  const card = document.createElement("div");
  card.className = `quest-card status-${q.status}`;

  const titleRow = document.createElement("div");
  titleRow.className = "quest-card-title-row";
  const title = document.createElement("span");
  title.className = "quest-card-title";
  title.textContent = q.title;
  const icon = document.createElement("span");
  icon.className = "quest-card-status-icon";
  icon.textContent = questStatusIcon(q.status);
  titleRow.appendChild(title);
  titleRow.appendChild(icon);
  card.appendChild(titleRow);

  const desc = document.createElement("div");
  desc.className = "quest-card-desc";
  desc.textContent = q.description;
  card.appendChild(desc);

  const track = document.createElement("div");
  track.className = "quest-progress-track";
  const fill = document.createElement("div");
  fill.className = "quest-progress-fill";
  fill.style.width = `${Math.min(100, (q.progress_count / q.objective_count) * 100)}%`;
  track.appendChild(fill);
  card.appendChild(track);

  const footer = document.createElement("div");
  footer.className = "quest-card-footer";
  const progressText = document.createElement("span");
  progressText.textContent = `${q.progress_count} / ${q.objective_count}`;
  footer.appendChild(progressText);

  const reward = document.createElement("span");
  reward.className = "quest-reward";
  reward.textContent = `💰+${q.reward_money} 🌟+${q.reward_reputation}`;
  footer.appendChild(reward);

  if (q.status === "active") {
    const abandonBtn = document.createElement("button");
    abandonBtn.className = "quest-abandon-btn";
    abandonBtn.textContent = "Abandonner";
    abandonBtn.addEventListener("click", async () => {
      await fetch(`/api/quests/${q.key}/abandon`, { method: "POST" });
      await loadQuests({ silent: true });
    });
    footer.appendChild(abandonBtn);
  }
  card.appendChild(footer);

  return card;
}

function renderQuestList() {
  const list = document.getElementById("quest-list");
  list.innerHTML = "";
  const filtered = quests.filter(questMatchesFilter);
  if (filtered.length === 0) {
    const hint = document.createElement("p");
    hint.className = "quest-empty-hint";
    hint.textContent = "Aucune quête ici pour l'instant.";
    list.appendChild(hint);
    return;
  }
  filtered.forEach((q) => list.appendChild(questCard(q)));
}

function showQuestToast(kind, q) {
  const container = document.getElementById("quest-toast-container");
  const toast = document.createElement("div");
  toast.className = `quest-toast ${kind === "completed" ? "completed" : kind === "failed" ? "failed" : ""}`;
  const title = document.createElement("div");
  title.className = "quest-toast-title";
  title.textContent = kind === "completed" ? "Quête terminée !" : kind === "failed" ? "Quête abandonnée" : "Nouvelle quête !";
  const body = document.createElement("div");
  body.className = "quest-toast-body";
  body.textContent = q.title;
  toast.appendChild(title);
  toast.appendChild(body);
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

document.getElementById("quest-tracker-toggle").addEventListener("click", () => {
  questTrackerOpen = !questTrackerOpen;
  document.getElementById("quest-tracker-body").hidden = !questTrackerOpen;
  document.getElementById("quest-tracker").classList.toggle("open", questTrackerOpen);
});

renderQuestFilters();
loadQuests({ silent: false }); // seed known statuses quietly first — no toast flood for quests already active from a past session
setInterval(() => loadQuests({ silent: true }), 6000);

loadWhoAmI();
loadCharacterHeight();
loadMap().then(() => {
  buildNavGrid(); // quick provisional grid — walls plus whatever sprite images already happened to load
  requestAnimationFrame(loop); // don't block gameplay start on image loading
  waitForSpriteImages().then(buildNavGrid); // accurate rebuild once every sprite's real size is known
});
