const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { resolveContract } = require("./contracts");
const { STATS, clamp, sentimentPhrases, applyDecay, TONES, toneReaction, requirementsMet } = require("./relationships");
const { NPC_ACTIONS } = require("./npc_actions");
const gameTime = require("./game_time");

const app = express();
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: "10mb" }));
app.use(
  session({
    secret: process.env.HELLCORP_SESSION_SECRET || "hellcorp-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  if (req.path.endsWith(".html")) return res.redirect("/login.html");
  return res.status(401).json({ error: "not authenticated" });
}

// --- Auth ---

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "not authenticated" });
  res.json({ username: req.session.username });
});

// --- Map data (walls + sprites) ---

app.get("/api/maps/:name", requireAuth, (req, res) => {
  const map = db.prepare("SELECT * FROM maps WHERE name = ?").get(req.params.name);
  if (!map) return res.status(404).json({ error: "unknown map" });

  const walls = db.prepare("SELECT id, x, y, w, h FROM walls WHERE map_id = ?").all(map.id);
  const sprites = db
    .prepare(
      `SELECT id, asset_file, x, y, scale, z_index, blocking, rotation, flip_h, is_floor,
              hitbox_x, hitbox_y, hitbox_w, hitbox_h, hitbox_mask, hitbox_mask_cols, hitbox_mask_rows
       FROM map_sprites WHERE map_id = ?`
    )
    .all(map.id);

  const baseNpcs = db
    .prepare(
      `SELECT map_npcs.id, character_key, x, y, facing, avatar_file, name, title, accent_color
       FROM map_npcs JOIN characters ON characters.key = map_npcs.character_key
       WHERE map_id = ?`
    )
    .all(map.id);

  // The editor authors each NPC's home/base placement and must round-trip it unchanged —
  // ?base=1 skips the schedule overlay so a save from there can never clobber the base
  // position with wherever the live schedule happens to have them standing right now.
  const npcs = req.query.base
    ? baseNpcs.map((n) => ({ ...n, action_key: "idle", action: resolveAction(n.character_key, "idle"), present: true }))
    : (() => {
        const { hour } = gameTime.currentTime(db);
        return baseNpcs.map((n) => applyScheduleToNpc(n, hour));
      })();

  res.json({ background_file: map.background_file, walls, sprites, npcs });
});

// Overlays a character's current schedule block (if any) onto their base map placement —
// no schedule at all means "always here, idle", which keeps existing placements working
// unchanged. `action` carries the animation style so the client doesn't need another fetch.
function applyScheduleToNpc(n, hour) {
  const blocks = db.prepare("SELECT * FROM npc_schedules WHERE character_key = ? ORDER BY start_hour").all(n.character_key);
  const active = blocks.find((b) => gameTime.hourInRange(hour, b.start_hour, b.end_hour));

  const actionKey = active ? active.action_key : "idle";
  const action = resolveAction(n.character_key, actionKey);

  return {
    ...n,
    x: active ? active.x : n.x,
    y: active ? active.y : n.y,
    action_key: actionKey,
    action,
    present: action.style !== "none",
  };
}

// The catalog entry for an action, with this character's animation overrides (if any) layered
// on top — only the fields a row actually sets are overridden, everything else keeps the base.
function resolveAction(characterKey, actionKey) {
  const base = NPC_ACTIONS[actionKey] || NPC_ACTIONS.idle;
  const override = db
    .prepare("SELECT bob_amp, bob_hz, tilt_deg, scale_y FROM npc_animation_overrides WHERE character_key = ? AND action_key = ?")
    .get(characterKey, actionKey);
  if (!override) return base;

  const merged = { ...base };
  if (override.bob_amp != null) merged.bobAmp = override.bob_amp;
  if (override.bob_hz != null) merged.bobHz = override.bob_hz;
  if (override.tilt_deg != null) merged.tiltDeg = override.tilt_deg;
  if (override.scale_y != null) merged.scaleY = override.scale_y;
  return merged;
}

const ALLOWED_BACKGROUNDS = new Set(["office.png", null]);

app.put("/api/maps/:name/background", requireAuth, (req, res) => {
  const map = db.prepare("SELECT * FROM maps WHERE name = ?").get(req.params.name);
  if (!map) return res.status(404).json({ error: "unknown map" });

  const file = req.body?.file ?? null;
  if (!ALLOWED_BACKGROUNDS.has(file)) return res.status(400).json({ error: "unknown background" });

  db.prepare("UPDATE maps SET background_file = ? WHERE id = ?").run(file, map.id);
  res.json({ ok: true, background_file: file });
});

app.put("/api/maps/:name/walls", requireAuth, (req, res) => {
  const map = db.prepare("SELECT * FROM maps WHERE name = ?").get(req.params.name);
  if (!map) return res.status(404).json({ error: "unknown map" });

  const walls = Array.isArray(req.body) ? req.body : [];
  const replace = db.transaction((items) => {
    db.prepare("DELETE FROM walls WHERE map_id = ?").run(map.id);
    const insert = db.prepare("INSERT INTO walls (map_id, x, y, w, h) VALUES (?, ?, ?, ?, ?)");
    for (const w of items) insert.run(map.id, w.x, w.y, w.w, w.h);
  });
  replace(walls);

  res.json({ ok: true, count: walls.length });
});

app.put("/api/maps/:name/sprites", requireAuth, (req, res) => {
  const map = db.prepare("SELECT * FROM maps WHERE name = ?").get(req.params.name);
  if (!map) return res.status(404).json({ error: "unknown map" });

  const sprites = Array.isArray(req.body) ? req.body : [];
  const replace = db.transaction((items) => {
    db.prepare("DELETE FROM map_sprites WHERE map_id = ?").run(map.id);
    const insert = db.prepare(
      `INSERT INTO map_sprites
        (map_id, asset_file, x, y, scale, z_index, blocking, rotation, flip_h, is_floor,
         hitbox_x, hitbox_y, hitbox_w, hitbox_h, hitbox_mask, hitbox_mask_cols, hitbox_mask_rows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of items) {
      insert.run(
        map.id,
        s.asset_file,
        s.x,
        s.y,
        s.scale || 1,
        s.z_index || 0,
        s.blocking ? 1 : 0,
        s.rotation || 0,
        s.flip_h ? 1 : 0,
        s.is_floor ? 1 : 0,
        s.hitbox_x ?? null,
        s.hitbox_y ?? null,
        s.hitbox_w ?? null,
        s.hitbox_h ?? null,
        s.hitbox_mask ?? null,
        s.hitbox_mask_cols ?? null,
        s.hitbox_mask_rows ?? null
      );
    }
  });
  replace(sprites);

  res.json({ ok: true, count: sprites.length });
});

app.put("/api/maps/:name/npcs", requireAuth, (req, res) => {
  const map = db.prepare("SELECT * FROM maps WHERE name = ?").get(req.params.name);
  if (!map) return res.status(404).json({ error: "unknown map" });

  const npcs = Array.isArray(req.body) ? req.body : [];
  const replace = db.transaction((items) => {
    db.prepare("DELETE FROM map_npcs WHERE map_id = ?").run(map.id);
    const insert = db.prepare("INSERT INTO map_npcs (map_id, character_key, x, y, facing) VALUES (?, ?, ?, ?, ?)");
    for (const n of items) insert.run(map.id, n.character_key, n.x, n.y, n.facing || 1);
  });
  replace(npcs);

  res.json({ ok: true, count: npcs.length });
});

// --- Game clock & NPC schedules ---

app.get("/api/time", requireAuth, (req, res) => {
  res.json(gameTime.fullState(db));
});

app.put("/api/time", requireAuth, (req, res) => {
  const { hour, day, time_scale_seconds_per_hour, paused } = req.body || {};
  res.json(gameTime.setTime(db, { hour, day, time_scale_seconds_per_hour, paused }));
});

app.get("/api/npc-actions", requireAuth, (req, res) => {
  res.json(
    Object.entries(NPC_ACTIONS).map(([key, action]) => ({ key, ...action }))
  );
});

app.get("/api/characters/:key/schedule", requireAuth, (req, res) => {
  const character = db.prepare("SELECT key FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });

  const blocks = db
    .prepare("SELECT id, start_hour, end_hour, action_key, x, y FROM npc_schedules WHERE character_key = ? ORDER BY start_hour")
    .all(character.key);
  res.json(blocks);
});

app.put("/api/characters/:key/schedule", requireAuth, (req, res) => {
  const character = db.prepare("SELECT key FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });

  const blocks = Array.isArray(req.body) ? req.body : [];
  for (const b of blocks) {
    if (!NPC_ACTIONS[b.action_key]) return res.status(400).json({ error: `unknown action_key: ${b.action_key}` });
  }

  const replace = db.transaction((items) => {
    db.prepare("DELETE FROM npc_schedules WHERE character_key = ?").run(character.key);
    const insert = db.prepare(
      "INSERT INTO npc_schedules (character_key, start_hour, end_hour, action_key, x, y) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const b of items) insert.run(character.key, b.start_hour, b.end_hour, b.action_key, b.x, b.y);
  });
  replace(blocks);

  res.json({ ok: true, count: blocks.length });
});

// Per-character animation tuning, layered over the catalog defaults in npc_actions.js —
// a row here only ever overrides the fields it actually sets (null = "use the catalog value").
app.get("/api/characters/:key/animations", requireAuth, (req, res) => {
  const character = db.prepare("SELECT key FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });

  const overrides = db
    .prepare("SELECT action_key, bob_amp, bob_hz, tilt_deg, scale_y FROM npc_animation_overrides WHERE character_key = ?")
    .all(character.key);
  const overridesByKey = Object.fromEntries(overrides.map((o) => [o.action_key, o]));

  const merged = Object.entries(NPC_ACTIONS).map(([key, base]) => {
    const o = overridesByKey[key];
    return {
      key,
      label: base.label,
      style: base.style,
      bob_amp: o?.bob_amp ?? base.bobAmp ?? null,
      bob_hz: o?.bob_hz ?? base.bobHz ?? null,
      tilt_deg: o?.tilt_deg ?? base.tiltDeg ?? null,
      scale_y: o?.scale_y ?? base.scaleY ?? null,
      is_override: !!o,
    };
  });
  res.json(merged);
});

app.put("/api/characters/:key/animations/:action_key", requireAuth, (req, res) => {
  const character = db.prepare("SELECT key FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });
  if (!NPC_ACTIONS[req.params.action_key]) return res.status(400).json({ error: "unknown action_key" });

  const { bob_amp, bob_hz, tilt_deg, scale_y } = req.body || {};
  db.prepare(
    `INSERT INTO npc_animation_overrides (character_key, action_key, bob_amp, bob_hz, tilt_deg, scale_y)
     VALUES (@character_key, @action_key, @bob_amp, @bob_hz, @tilt_deg, @scale_y)
     ON CONFLICT(character_key, action_key) DO UPDATE SET
       bob_amp = excluded.bob_amp, bob_hz = excluded.bob_hz, tilt_deg = excluded.tilt_deg, scale_y = excluded.scale_y`
  ).run({
    character_key: character.key,
    action_key: req.params.action_key,
    bob_amp: bob_amp ?? null,
    bob_hz: bob_hz ?? null,
    tilt_deg: tilt_deg ?? null,
    scale_y: scale_y ?? null,
  });

  res.json({ ok: true });
});

app.delete("/api/characters/:key/animations/:action_key", requireAuth, (req, res) => {
  db.prepare("DELETE FROM npc_animation_overrides WHERE character_key = ? AND action_key = ?").run(req.params.key, req.params.action_key);
  res.json({ ok: true });
});

// --- Day Shift: GameState, employees, contracts ---

function parseEmployee(row) {
  return { ...row, stats: JSON.parse(row.stats), traits: JSON.parse(row.traits) };
}

function parseContract(row) {
  const now = Date.now();
  const completesAt = row.completes_at ? new Date(row.completes_at).getTime() : null;
  return {
    ...row,
    requirements: JSON.parse(row.requirements),
    assigned_employee_ids: row.assigned_employee_ids ? JSON.parse(row.assigned_employee_ids) : [],
    remaining_seconds:
      row.status === "active" && completesAt ? Math.max(0, Math.round((completesAt - now) / 1000)) : null,
    ready_to_collect: row.status === "active" && completesAt ? now >= completesAt : false,
  };
}

function busyEmployeeIds() {
  const rows = db.prepare("SELECT assigned_employee_ids FROM contracts WHERE status = 'active'").all();
  const busy = new Set();
  for (const r of rows) {
    if (!r.assigned_employee_ids) continue;
    for (const id of JSON.parse(r.assigned_employee_ids)) busy.add(id);
  }
  return busy;
}

app.get("/api/state", requireAuth, (req, res) => {
  const state = db.prepare("SELECT * FROM game_state WHERE id = 1").get();
  const employeeCount = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE hired = 1").get().n;
  const availableCount = db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE status = 'available'").get().n;
  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE status = 'active'").get().n;
  const readyToCollect = db
    .prepare("SELECT id, completes_at FROM contracts WHERE status = 'active'")
    .all()
    .filter((c) => new Date(c.completes_at).getTime() <= Date.now()).length;
  const candidateCount = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE hired = 0").get().n;

  res.json({
    ...state,
    employee_count: employeeCount,
    contracts_available: availableCount,
    contracts_active: activeCount,
    contracts_ready_to_collect: readyToCollect,
    candidates_available: candidateCount,
  });
});

app.put("/api/state/character-height", requireAuth, (req, res) => {
  const height = Number(req.body?.height);
  if (!Number.isFinite(height) || height < 40 || height > 400) {
    return res.status(400).json({ error: "height must be between 40 and 400" });
  }
  db.prepare("UPDATE game_state SET character_height = ? WHERE id = 1").run(height);
  res.json({ ok: true, character_height: height });
});

app.get("/api/employees", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM employees WHERE hired = 1 ORDER BY is_major DESC, name").all();
  const busy = busyEmployeeIds();
  res.json(rows.map(parseEmployee).map((e) => ({ ...e, busy: busy.has(e.id) })));
});

app.get("/api/recruits", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM employees WHERE hired = 0 ORDER BY is_major DESC, hire_cost").all();
  res.json(rows.map(parseEmployee));
});

app.post("/api/recruits/:id/hire", requireAuth, (req, res) => {
  const candidate = db.prepare("SELECT * FROM employees WHERE id = ? AND hired = 0").get(req.params.id);
  if (!candidate) return res.status(404).json({ error: "unknown candidate" });

  const state = db.prepare("SELECT * FROM game_state WHERE id = 1").get();
  if (state.capital < candidate.hire_cost) return res.status(400).json({ error: "insufficient capital" });

  const hire = db.transaction(() => {
    db.prepare("UPDATE game_state SET capital = capital - ? WHERE id = 1").run(candidate.hire_cost);
    db.prepare("UPDATE employees SET hired = 1 WHERE id = ?").run(candidate.id);
  });
  hire();
  advanceQuests("hire_employee", {});

  res.json({ ok: true });
});

app.get("/api/contracts", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM contracts ORDER BY status, duration_seconds").all();
  res.json(rows.map(parseContract));
});

app.post("/api/contracts/:id/start", requireAuth, (req, res) => {
  const contract = db.prepare("SELECT * FROM contracts WHERE id = ?").get(req.params.id);
  if (!contract) return res.status(404).json({ error: "unknown contract" });
  if (contract.status !== "available") return res.status(400).json({ error: "contract not available" });

  const employeeIds = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
  if (employeeIds.length === 0) return res.status(400).json({ error: "select at least one employee" });

  const busy = busyEmployeeIds();
  const placeholders = employeeIds.map(() => "?").join(",");
  const employees = db
    .prepare(`SELECT * FROM employees WHERE id IN (${placeholders}) AND hired = 1`)
    .all(...employeeIds);
  if (employees.length !== employeeIds.length) return res.status(400).json({ error: "invalid employee selection" });
  if (employees.some((e) => busy.has(e.id))) return res.status(400).json({ error: "employee already assigned" });

  const startedAt = new Date();
  const completesAt = new Date(startedAt.getTime() + contract.duration_seconds * 1000);

  db.prepare(
    "UPDATE contracts SET status = 'active', assigned_employee_ids = ?, started_at = ?, completes_at = ? WHERE id = ?"
  ).run(JSON.stringify(employeeIds), startedAt.toISOString(), completesAt.toISOString(), contract.id);

  res.json({ ok: true, completes_at: completesAt.toISOString() });
});

app.post("/api/contracts/:id/collect", requireAuth, (req, res) => {
  const contract = db.prepare("SELECT * FROM contracts WHERE id = ?").get(req.params.id);
  if (!contract) return res.status(404).json({ error: "unknown contract" });
  if (contract.status !== "active") return res.status(400).json({ error: "contract not active" });
  if (new Date(contract.completes_at).getTime() > Date.now()) {
    return res.status(400).json({ error: "contract not finished yet" });
  }

  const employeeIds = JSON.parse(contract.assigned_employee_ids);
  const placeholders = employeeIds.map(() => "?").join(",");
  const employees = db.prepare(`SELECT * FROM employees WHERE id IN (${placeholders})`).all(...employeeIds);

  const result = resolveContract(contract, employees);

  const collect = db.transaction(() => {
    db.prepare(
      "UPDATE contracts SET status = 'completed', outcome = ?, actual_reward_money = ?, actual_reward_reputation = ? WHERE id = ?"
    ).run(result.success ? "success" : "failure", result.actualMoney, result.actualReputation, contract.id);

    db.prepare("UPDATE game_state SET capital = capital + ?, reputation = reputation + ? WHERE id = 1").run(
      result.actualMoney,
      result.actualReputation
    );

    const stressDelta = result.success ? 10 : 20;
    const updateEmployee = db.prepare(
      "UPDATE employees SET fatigue = MIN(100, fatigue + 25), motivation = MAX(0, motivation - 5), stress = MIN(100, stress + ?) WHERE id = ?"
    );
    for (const id of employeeIds) updateEmployee.run(stressDelta, id);
  });
  collect();
  advanceQuests("complete_contract", {});

  res.json({ ok: true, ...result });
});

// --- Messaging: relationships, last-interaction decay, Event Director ---

function getFlagSet() {
  const rows = db.prepare("SELECT key FROM flags WHERE value = 1").all();
  return new Set(rows.map((r) => r.key));
}

function setFlag(key) {
  db.prepare("INSERT INTO flags (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = 1").run(key);
}

// --- Quests: single-player quest log, progress driven by real game actions (not by dialogue
// choices like the Event Director — see the hooks calling advanceQuests() throughout this file). ---

function unlockEligibleQuests() {
  const flagSet = getFlagSet();
  const locked = db.prepare("SELECT * FROM quests WHERE status = 'locked'").all();
  for (const q of locked) {
    const requirements = JSON.parse(q.requirements);
    const flagsOk = !requirements.flags || requirements.flags.every((f) => flagSet.has(f));
    if (flagsOk) {
      db.prepare("UPDATE quests SET status = 'active', unlocked_at = datetime('now') WHERE id = ?").run(q.id);
    }
  }
}

function applyQuestRewards(q) {
  db.prepare("UPDATE game_state SET capital = capital + ?, reputation = reputation + ? WHERE id = 1").run(
    q.reward_money,
    q.reward_reputation
  );
  for (const flag of JSON.parse(q.set_flags_on_complete || "[]")) setFlag(flag);
}

function questTargetMatches(objectiveType, target, context) {
  switch (objectiveType) {
    case "talk_to_npc":
      return !target.character_key || target.character_key === context.character_key;
    case "complete_contract":
      return true;
    case "hire_employee":
      return true;
    case "complete_event":
      return !target.event_key || target.event_key === context.event_key;
    default:
      return false;
  }
}

// Called right after a real player action (opening a dialogue, collecting a contract, hiring
// someone, resolving a story choice) — every matching active quest advances by one step.
function advanceQuests(objectiveType, context) {
  unlockEligibleQuests();
  const active = db.prepare("SELECT * FROM quests WHERE status = 'active' AND objective_type = ?").all(objectiveType);
  for (const q of active) {
    const target = JSON.parse(q.objective_target || "{}");
    if (!questTargetMatches(objectiveType, target, context)) continue;

    const newCount = Math.min(q.objective_count, q.progress_count + 1);
    const completed = newCount >= q.objective_count;
    db.prepare("UPDATE quests SET progress_count = ?, status = ?, completed_at = ? WHERE id = ?").run(
      newCount,
      completed ? "completed" : "active",
      completed ? new Date().toISOString() : null,
      q.id
    );
    if (completed) applyQuestRewards(db.prepare("SELECT * FROM quests WHERE id = ?").get(q.id));
  }
}

// reach_stat quests aren't triggered by a one-off action — checked lazily whenever the
// character list is fetched, same lazy-poll pattern as relationship decay.
function checkStatQuests() {
  unlockEligibleQuests();
  const active = db.prepare("SELECT * FROM quests WHERE status = 'active' AND objective_type = 'reach_stat'").all();
  for (const q of active) {
    const target = JSON.parse(q.objective_target);
    const character = db.prepare("SELECT * FROM characters WHERE key = ?").get(target.character_key);
    if (!character) continue;
    if (target.min != null && character[target.stat] < target.min) continue;
    if (target.max != null && character[target.stat] > target.max) continue;

    db.prepare("UPDATE quests SET progress_count = objective_count, status = 'completed', completed_at = datetime('now') WHERE id = ?").run(q.id);
    applyQuestRewards(db.prepare("SELECT * FROM quests WHERE id = ?").get(q.id));
  }
}

app.get("/api/quests", requireAuth, (req, res) => {
  unlockEligibleQuests();
  checkStatQuests();

  const quests = db
    .prepare(
      `SELECT * FROM quests WHERE status != 'locked'
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 WHEN 'failed' THEN 2 END, id`
    )
    .all();
  res.json(
    quests.map((q) => ({
      ...q,
      objective_target: JSON.parse(q.objective_target),
      requirements: JSON.parse(q.requirements),
      set_flags_on_complete: JSON.parse(q.set_flags_on_complete),
    }))
  );
});

app.post("/api/quests/:key/abandon", requireAuth, (req, res) => {
  const quest = db.prepare("SELECT * FROM quests WHERE key = ?").get(req.params.key);
  if (!quest) return res.status(404).json({ error: "unknown quest" });
  if (quest.status !== "active") return res.status(400).json({ error: "quest is not active" });

  db.prepare("UPDATE quests SET status = 'failed' WHERE id = ?").run(quest.id);
  res.json({ ok: true });
});

function persistDecay(character) {
  const decay = applyDecay(character);
  if (!decay) return character;
  db.prepare("UPDATE characters SET affinity = ?, trust = ?, last_decay_at = ? WHERE key = ?").run(
    decay.affinity,
    decay.trust,
    decay.last_decay_at,
    character.key
  );
  return { ...character, affinity: decay.affinity, trust: decay.trust, last_decay_at: decay.last_decay_at };
}

function syncEventsForCharacter(character) {
  const flagSet = getFlagSet();
  const events = db
    .prepare("SELECT * FROM events WHERE character_key = ? AND status != 'completed' AND triggered_at IS NULL")
    .all(character.key);

  for (const ev of events) {
    const requirements = JSON.parse(ev.requirements);
    if (!requirementsMet(requirements, character, flagSet)) continue;

    db.prepare(
      "INSERT INTO messages (character_key, sender, kind, body, event_id, read, created_at) VALUES (?, 'character', 'event', ?, ?, 0, datetime('now'))"
    ).run(character.key, ev.body, ev.id);
    db.prepare("UPDATE events SET triggered_at = datetime('now') WHERE id = ?").run(ev.id);
  }
}

function characterSummary(character) {
  const lastMessage = db
    .prepare("SELECT * FROM messages WHERE character_key = ? ORDER BY created_at DESC LIMIT 1")
    .get(character.key);
  const unread = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE character_key = ? AND sender = 'character' AND read = 0")
    .get(character.key).n;

  return {
    key: character.key,
    name: character.name,
    title: character.title,
    avatar_file: character.avatar_file,
    accent_color: character.accent_color,
    sentiment: sentimentPhrases(character),
    last_interaction_at: character.last_interaction_at,
    last_message: lastMessage ? { body: lastMessage.body, sender: lastMessage.sender, created_at: lastMessage.created_at } : null,
    unread,
  };
}

app.get("/api/characters", requireAuth, (req, res) => {
  let characters = db.prepare("SELECT * FROM characters").all();
  characters = characters.map((c) => {
    const decayed = persistDecay(c);
    syncEventsForCharacter(decayed);
    return decayed;
  });
  checkStatQuests();

  const summaries = characters.map(characterSummary).sort((a, b) => {
    const at = a.last_message ? new Date(a.last_message.created_at).getTime() : 0;
    const bt = b.last_message ? new Date(b.last_message.created_at).getTime() : 0;
    return bt - at;
  });
  res.json(summaries);
});

const AVAILABLE_AVATARS = ["lucy.png", "malphas.png", "morrigan.png", "raven.png"];

app.get("/api/avatars", requireAuth, (req, res) => {
  res.json(AVAILABLE_AVATARS);
});

app.post("/api/characters", requireAuth, (req, res) => {
  const { key, name, title, avatar_file, accent_color, flavor } = req.body || {};
  if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) {
    return res.status(400).json({ error: "key must be lowercase letters/digits/underscore, starting with a letter" });
  }
  if (!name || !title || !accent_color) return res.status(400).json({ error: "name, title and accent_color are required" });
  if (!AVAILABLE_AVATARS.includes(avatar_file)) return res.status(400).json({ error: "unknown avatar_file" });

  const existing = db.prepare("SELECT key FROM characters WHERE key = ?").get(key);
  if (existing) return res.status(409).json({ error: "a character with this key already exists" });

  db.prepare(
    "INSERT INTO characters (key, name, title, avatar_file, accent_color, flavor) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, name, title, avatar_file, accent_color, flavor || null);

  res.json(db.prepare("SELECT * FROM characters WHERE key = ?").get(key));
});

app.delete("/api/characters/:key", requireAuth, (req, res) => {
  const character = db.prepare("SELECT key FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });

  // SQLite FKs aren't enforced here (no PRAGMA foreign_keys=ON), so every table that references
  // character_key has to be cleaned up by hand instead of relying on ON DELETE CASCADE.
  const wipe = db.transaction((key) => {
    db.prepare("DELETE FROM map_npcs WHERE character_key = ?").run(key);
    db.prepare("DELETE FROM npc_schedules WHERE character_key = ?").run(key);
    db.prepare("DELETE FROM npc_animation_overrides WHERE character_key = ?").run(key);
    db.prepare("DELETE FROM messages WHERE character_key = ?").run(key);
    db.prepare("DELETE FROM events WHERE character_key = ?").run(key);
    db.prepare("DELETE FROM memories WHERE character_key = ?").run(key);
    db.prepare("DELETE FROM characters WHERE key = ?").run(key);
  });
  wipe(character.key);

  res.json({ ok: true });
});

app.get("/api/characters/:key/messages", requireAuth, (req, res) => {
  let character = db.prepare("SELECT * FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });

  character = persistDecay(character);
  syncEventsForCharacter(character);
  advanceQuests("talk_to_npc", { character_key: character.key });

  db.prepare("UPDATE messages SET read = 1 WHERE character_key = ? AND sender = 'character'").run(character.key);

  const messages = db
    .prepare("SELECT * FROM messages WHERE character_key = ? ORDER BY created_at ASC")
    .all(character.key);

  const events = db
    .prepare("SELECT * FROM events WHERE character_key = ? AND triggered_at IS NOT NULL")
    .all(character.key)
    .map((e) => ({
      id: e.id,
      key: e.key,
      title: e.title,
      body: e.body,
      choices: JSON.parse(e.choices).map((c) => ({ id: c.id, label: c.label })),
      status: e.status,
      completed_choice_id: e.completed_choice_id,
    }));

  const memories = db.prepare("SELECT key, title, unlocked_at FROM memories WHERE character_key = ?").all(character.key);

  res.json({
    character: { ...character, sentiment: sentimentPhrases(character) },
    messages,
    events,
    memories,
  });
});

app.post("/api/characters/:key/reply", requireAuth, (req, res) => {
  let character = db.prepare("SELECT * FROM characters WHERE key = ?").get(req.params.key);
  if (!character) return res.status(404).json({ error: "unknown character" });

  const tone = req.body?.tone;
  if (!TONES[tone]) return res.status(400).json({ error: "unknown tone" });

  character = persistDecay(character);

  const effects = TONES[tone].effects;
  const updates = {};
  for (const stat of STATS) updates[stat] = clamp(character[stat] + (effects[stat] || 0));

  const reactionBody = toneReaction(character.key, tone, { ...character, ...updates });

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE characters SET ${STATS.map((s) => `${s} = @${s}`).join(", ")}, last_interaction_at = @now, last_decay_at = @now WHERE key = @key`
    ).run({ ...updates, now, key: character.key });

    db.prepare("INSERT INTO messages (character_key, sender, kind, body, read, created_at) VALUES (?, 'player', 'chat', ?, 1, ?)").run(
      character.key,
      TONES[tone].playerLine,
      now
    );
    db.prepare("INSERT INTO messages (character_key, sender, kind, body, read, created_at) VALUES (?, 'character', 'chat', ?, 0, datetime('now', '+1 second'))").run(
      character.key,
      reactionBody
    );
  });
  apply();

  const updatedCharacter = db.prepare("SELECT * FROM characters WHERE key = ?").get(character.key);
  res.json({ ok: true, character: { ...updatedCharacter, sentiment: sentimentPhrases(updatedCharacter) } });
});

app.post("/api/events/:id/choice", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });
  if (event.status === "completed") return res.status(400).json({ error: "event already completed" });
  if (!event.triggered_at) return res.status(400).json({ error: "event not triggered yet" });

  const choices = JSON.parse(event.choices);
  const choice = choices.find((c) => c.id === req.body?.choice_id);
  if (!choice) return res.status(400).json({ error: "unknown choice" });

  let character = db.prepare("SELECT * FROM characters WHERE key = ?").get(event.character_key);
  character = persistDecay(character);

  const updates = {};
  for (const stat of STATS) updates[stat] = clamp(character[stat] + (choice.effects?.[stat] || 0));

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE characters SET ${STATS.map((s) => `${s} = @${s}`).join(", ")}, last_interaction_at = @now, last_decay_at = @now WHERE key = @key`
    ).run({ ...updates, now, key: character.key });

    db.prepare("INSERT INTO messages (character_key, sender, kind, body, read, created_at) VALUES (?, 'player', 'choice', ?, 1, ?)").run(
      character.key,
      choice.label,
      now
    );
    if (choice.reaction) {
      db.prepare(
        "INSERT INTO messages (character_key, sender, kind, body, event_id, read, created_at) VALUES (?, 'character', 'chat', ?, ?, 0, datetime('now', '+1 second'))"
      ).run(character.key, choice.reaction, event.id);
    }

    for (const flag of choice.set_flags || []) setFlag(flag);

    if (choice.unlock_memory) {
      db.prepare("INSERT OR IGNORE INTO memories (character_key, key, title) VALUES (?, ?, ?)").run(
        character.key,
        choice.unlock_memory.key,
        choice.unlock_memory.title
      );
    }

    db.prepare("UPDATE events SET status = 'completed', completed_choice_id = ?, completed_at = datetime('now') WHERE id = ?").run(
      choice.id,
      event.id
    );
  });
  apply();
  advanceQuests("complete_event", { event_key: event.key });

  const updatedCharacter = db.prepare("SELECT * FROM characters WHERE key = ?").get(character.key);
  res.json({
    ok: true,
    character: { ...updatedCharacter, sentiment: sentimentPhrases(updatedCharacter) },
    unlocked_memory: choice.unlock_memory || null,
  });
});

// --- Narrative / Event Director editor ---

function parseEvent(row) {
  return { ...row, requirements: JSON.parse(row.requirements), choices: JSON.parse(row.choices) };
}

function validateEventPayload(body) {
  const { character_key, title, requirements, body: eventBody, choices } = body || {};
  if (!character_key || !db.prepare("SELECT key FROM characters WHERE key = ?").get(character_key)) {
    return "unknown character_key";
  }
  if (!title || !eventBody) return "title and body are required";
  if (requirements != null && typeof requirements !== "object") return "requirements must be an object";
  if (!Array.isArray(choices) || choices.length === 0) return "at least one choice is required";

  const ids = new Set();
  for (const c of choices) {
    if (!c.id || !c.label) return "every choice needs an id and a label";
    if (ids.has(c.id)) return `duplicate choice id: ${c.id}`;
    ids.add(c.id);
    if (c.effects) {
      for (const stat of Object.keys(c.effects)) {
        if (!STATS.includes(stat)) return `unknown stat in effects: ${stat}`;
      }
    }
  }
  for (const key of Object.keys(requirements || {})) {
    if (key === "flags") continue;
    const stat = key.replace(/_min$|_max$/, "");
    if (!STATS.includes(stat)) return `unknown stat in requirements: ${key}`;
  }
  return null;
}

app.get("/api/story/events", requireAuth, (req, res) => {
  let query = "SELECT * FROM events";
  const params = [];
  if (req.query.character_key) {
    query += " WHERE character_key = ?";
    params.push(req.query.character_key);
  }
  query += " ORDER BY id DESC";
  res.json(db.prepare(query).all(...params).map(parseEvent));
});

app.post("/api/story/events", requireAuth, (req, res) => {
  const error = validateEventPayload(req.body);
  if (error) return res.status(400).json({ error });

  const { key, character_key, title, requirements, body, choices } = req.body;
  if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) {
    return res.status(400).json({ error: "key must be lowercase letters/digits/underscore, starting with a letter" });
  }
  if (db.prepare("SELECT id FROM events WHERE key = ?").get(key)) {
    return res.status(409).json({ error: "an event with this key already exists" });
  }

  const info = db
    .prepare("INSERT INTO events (key, character_key, title, requirements, body, choices) VALUES (?, ?, ?, ?, ?, ?)")
    .run(key, character_key, title, JSON.stringify(requirements || {}), body, JSON.stringify(choices));

  res.json(parseEvent(db.prepare("SELECT * FROM events WHERE id = ?").get(info.lastInsertRowid)));
});

app.put("/api/story/events/:id", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });

  const error = validateEventPayload(req.body);
  if (error) return res.status(400).json({ error });

  const { character_key, title, requirements, body, choices } = req.body;
  db.prepare("UPDATE events SET character_key = ?, title = ?, requirements = ?, body = ?, choices = ? WHERE id = ?").run(
    character_key,
    title,
    JSON.stringify(requirements || {}),
    body,
    JSON.stringify(choices),
    event.id
  );

  res.json(parseEvent(db.prepare("SELECT * FROM events WHERE id = ?").get(event.id)));
});

// Resets a triggered/completed event back to pending so a writer can re-test it without
// deleting and recreating the whole thing (or waiting for a fresh save file).
app.post("/api/story/events/:id/reset", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });

  db.prepare(
    "UPDATE events SET status = 'pending', triggered_at = NULL, completed_choice_id = NULL, completed_at = NULL WHERE id = ?"
  ).run(event.id);
  res.json(parseEvent(db.prepare("SELECT * FROM events WHERE id = ?").get(event.id)));
});

app.delete("/api/story/events/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/story/flags", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT key, value FROM flags ORDER BY key").all());
});

app.delete("/api/story/flags/:key", requireAuth, (req, res) => {
  db.prepare("DELETE FROM flags WHERE key = ?").run(req.params.key);
  res.json({ ok: true });
});

app.get("/api/story/memories", requireAuth, (req, res) => {
  let query = "SELECT character_key, key, title, unlocked_at FROM memories";
  const params = [];
  if (req.query.character_key) {
    query += " WHERE character_key = ?";
    params.push(req.query.character_key);
  }
  query += " ORDER BY unlocked_at DESC";
  res.json(db.prepare(query).all(...params));
});

app.delete("/api/story/memories/:character_key/:key", requireAuth, (req, res) => {
  db.prepare("DELETE FROM memories WHERE character_key = ? AND key = ?").run(req.params.character_key, req.params.key);
  res.json({ ok: true });
});

// --- Pages ---

app.get("/", (req, res) => res.redirect(req.session.userId ? "/game.html" : "/login.html"));
app.get("/game.html", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "game.html")));
app.get("/editor.html", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "editor.html")));
app.get("/dashboard.html", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "dashboard.html")));
app.get("/messages.html", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "messages.html")));
app.get("/npc_manager.html", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "npc_manager.html")));
app.get("/story_manager.html", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "story_manager.html")));

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`HellCorp web game running at http://localhost:${PORT}`);
});
