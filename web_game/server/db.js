const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "hellcorp.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS maps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    background_file TEXT
  );

  CREATE TABLE IF NOT EXISTS walls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS map_sprites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    asset_file TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    scale REAL NOT NULL DEFAULT 1,
    z_index INTEGER NOT NULL DEFAULT 0,
    blocking INTEGER NOT NULL DEFAULT 0,
    rotation INTEGER NOT NULL DEFAULT 0,
    flip_h INTEGER NOT NULL DEFAULT 0,
    is_floor INTEGER NOT NULL DEFAULT 0,
    hitbox_x REAL,
    hitbox_y REAL,
    hitbox_w REAL,
    hitbox_h REAL,
    hitbox_mask TEXT,
    hitbox_mask_cols INTEGER,
    hitbox_mask_rows INTEGER
  );

  CREATE TABLE IF NOT EXISTS map_npcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    character_key TEXT NOT NULL REFERENCES characters(key),
    x REAL NOT NULL,
    y REAL NOT NULL,
    facing INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS game_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    capital REAL NOT NULL DEFAULT 42680,
    reputation INTEGER NOT NULL DEFAULT 18,
    revenue_per_hour REAL NOT NULL DEFAULT 1240,
    character_height REAL NOT NULL DEFAULT 130
  );

  CREATE TABLE IF NOT EXISTS npc_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_key TEXT NOT NULL REFERENCES characters(key),
    start_hour REAL NOT NULL,
    end_hour REAL NOT NULL,
    action_key TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL
  );

  -- Per-character tweaks on top of the base action animation (server/npc_actions.js) — e.g.
  -- Lucy's walk being bouncier than Malphas's. Absence of a row just means "use the catalog
  -- default", so this table can stay empty forever with zero behavior change.
  CREATE TABLE IF NOT EXISTS npc_animation_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_key TEXT NOT NULL REFERENCES characters(key),
    action_key TEXT NOT NULL,
    bob_amp REAL,
    bob_hz REAL,
    tilt_deg REAL,
    scale_y REAL,
    UNIQUE(character_key, action_key)
  );

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_major INTEGER NOT NULL DEFAULT 0,
    department TEXT NOT NULL,
    stats TEXT NOT NULL,
    traits TEXT NOT NULL,
    fatigue INTEGER NOT NULL DEFAULT 0,
    motivation INTEGER NOT NULL DEFAULT 70,
    stress INTEGER NOT NULL DEFAULT 0,
    hired INTEGER NOT NULL DEFAULT 0,
    hire_cost REAL NOT NULL DEFAULT 0,
    flavor TEXT
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    duration_tier TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    requirements TEXT NOT NULL,
    risk TEXT NOT NULL,
    reward_money REAL NOT NULL,
    reward_reputation INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    assigned_employee_ids TEXT,
    started_at TEXT,
    completes_at TEXT,
    outcome TEXT,
    actual_reward_money REAL,
    actual_reward_reputation INTEGER
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    avatar_file TEXT NOT NULL,
    accent_color TEXT NOT NULL,
    flavor TEXT,
    affinity INTEGER NOT NULL DEFAULT 30,
    trust INTEGER NOT NULL DEFAULT 30,
    respect INTEGER NOT NULL DEFAULT 30,
    attraction INTEGER NOT NULL DEFAULT 20,
    fear INTEGER NOT NULL DEFAULT 10,
    rivalry INTEGER NOT NULL DEFAULT 10,
    last_interaction_at TEXT,
    last_decay_at TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_key TEXT NOT NULL REFERENCES characters(key),
    sender TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    body TEXT NOT NULL,
    event_id INTEGER,
    read INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flags (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    character_key TEXT NOT NULL REFERENCES characters(key),
    title TEXT NOT NULL,
    requirements TEXT NOT NULL,
    body TEXT NOT NULL,
    choices TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    triggered_at TEXT,
    completed_choice_id TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_key TEXT NOT NULL REFERENCES characters(key),
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(character_key, key)
  );

  -- Single-player quest log: status/progress live directly on the quest row (no per-user
  -- junction table needed, same reasoning as game_state being a single row).
  CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'main',
    objective_type TEXT NOT NULL,
    objective_target TEXT NOT NULL DEFAULT '{}',
    objective_count INTEGER NOT NULL DEFAULT 1,
    progress_count INTEGER NOT NULL DEFAULT 0,
    reward_money REAL NOT NULL DEFAULT 0,
    reward_reputation INTEGER NOT NULL DEFAULT 0,
    requirements TEXT NOT NULL DEFAULT '{}',
    set_flags_on_complete TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'locked',
    unlocked_at TEXT,
    completed_at TEXT
  );
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("maps", "background_file", "TEXT");
ensureColumn("map_sprites", "blocking", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("map_sprites", "rotation", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("map_sprites", "flip_h", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("map_sprites", "is_floor", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("map_sprites", "hitbox_x", "REAL");
ensureColumn("map_sprites", "hitbox_y", "REAL");
ensureColumn("map_sprites", "hitbox_w", "REAL");
ensureColumn("map_sprites", "hitbox_h", "REAL");
ensureColumn("map_sprites", "hitbox_mask", "TEXT");
ensureColumn("map_sprites", "hitbox_mask_cols", "INTEGER");
ensureColumn("map_sprites", "hitbox_mask_rows", "INTEGER");
ensureColumn("game_state", "character_height", "REAL NOT NULL DEFAULT 130");
ensureColumn("game_state", "game_hour", "REAL NOT NULL DEFAULT 9");
ensureColumn("game_state", "game_day", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("game_state", "time_scale_seconds_per_hour", "REAL NOT NULL DEFAULT 30");
ensureColumn("game_state", "time_paused", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("game_state", "time_last_tick_at", "TEXT");

function ensureMap(name) {
  db.prepare("INSERT OR IGNORE INTO maps (name) VALUES (?)").run(name);
  return db.prepare("SELECT * FROM maps WHERE name = ?").get(name);
}

function ensureDefaultUser() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  if (existing.n > 0) return;

  const username = process.env.HELLCORP_ADMIN_USER || "hellceo";
  const password = process.env.HELLCORP_ADMIN_PASSWORD || "hellceo123";
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
  console.log(`[db] Created default user "${username}" / "${password}" — change this later.`);
}

function ensureGameState() {
  db.prepare(
    "INSERT OR IGNORE INTO game_state (id, capital, reputation, revenue_per_hour) VALUES (1, 42680, 18, 1240)"
  ).run();
}

function ensureRoster() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM employees").get();
  if (existing.n > 0) return;

  const insert = db.prepare(`
    INSERT INTO employees (name, is_major, department, stats, traits, fatigue, motivation, stress, hired, hire_cost, flavor)
    VALUES (@name, @is_major, @department, @stats, @traits, @fatigue, @motivation, @stress, @hired, @hire_cost, @flavor)
  `);

  const roster = [
    // Already hired starter team
    {
      name: "Jonas Ledger",
      is_major: 0,
      department: "Finance",
      stats: { finance: 55, legal: 20, marketing: 10, occult: 0, security: 5, management: 25 },
      traits: ["Workaholic"],
      fatigue: 0, motivation: 70, stress: 10,
      hired: 1, hire_cost: 0,
      flavor: "Comptable méticuleux, ne compte pas ses heures.",
    },
    {
      name: "Petra Voss",
      is_major: 0,
      department: "Legal",
      stats: { finance: 15, legal: 60, marketing: 5, occult: 0, security: 10, management: 20 },
      traits: ["Idealist"],
      fatigue: 0, motivation: 65, stress: 5,
      hired: 1, hire_cost: 0,
      flavor: "Juriste rigoureuse, mal à l'aise avec les clauses les plus sombres.",
    },
    {
      name: "Sam Okoye",
      is_major: 0,
      department: "Management",
      stats: { finance: 20, legal: 15, marketing: 30, occult: 0, security: 5, management: 55 },
      traits: ["Ambitious"],
      fatigue: 0, motivation: 75, stress: 8,
      hired: 1, hire_cost: 0,
      flavor: "Coordinateur d'équipe, vise clairement ta place.",
    },
    // Job board candidates
    {
      name: "Denise Okafor",
      is_major: 0,
      department: "Finance",
      stats: { finance: 40, legal: 10, marketing: 5, occult: 0, security: 5, management: 15 },
      traits: ["Coward"],
      fatigue: 0, motivation: 60, stress: 0,
      hired: 0, hire_cost: 1200,
      flavor: "Junior finance, fiable mais évite les risques.",
    },
    {
      name: "Marcus Fell",
      is_major: 0,
      department: "Legal",
      stats: { finance: 10, legal: 45, marketing: 10, occult: 5, security: 15, management: 15 },
      traits: ["Jealous"],
      fatigue: 0, motivation: 55, stress: 0,
      hired: 0, hire_cost: 1800,
      flavor: "Avocat correct, garde un œil sur les promotions des autres.",
    },
    // Story recruitment
    {
      name: "Morrigan",
      is_major: 1,
      department: "Finance",
      stats: { finance: 90, legal: 60, marketing: 20, occult: 10, security: 15, management: 70 },
      traits: ["Ruthless Negotiator"],
      fatigue: 0, motivation: 80, stress: 15,
      hired: 0, hire_cost: 15000,
      flavor: "VP Finance chez Greed Division. Débauchage coûteux, mais elle change la donne.",
    },
  ];

  const insertAll = db.transaction((items) => {
    for (const emp of items) {
      insert.run({
        name: emp.name,
        is_major: emp.is_major,
        department: emp.department,
        stats: JSON.stringify(emp.stats),
        traits: JSON.stringify(emp.traits),
        fatigue: emp.fatigue,
        motivation: emp.motivation,
        stress: emp.stress,
        hired: emp.hired,
        hire_cost: emp.hire_cost,
        flavor: emp.flavor,
      });
    }
  });
  insertAll(roster);
  console.log(`[db] Seeded ${roster.length} employees (3 hired, 2 job-board candidates, 1 story recruit).`);
}

function ensureContracts() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM contracts").get();
  if (existing.n > 0) return;

  const insert = db.prepare(`
    INSERT INTO contracts (name, duration_tier, duration_seconds, requirements, risk, reward_money, reward_reputation)
    VALUES (@name, @duration_tier, @duration_seconds, @requirements, @risk, @reward_money, @reward_reputation)
  `);

  const contracts = [
    {
      name: "Recouvrement de créances",
      duration_tier: "FLASH",
      duration_seconds: 60,
      requirements: { finance: 40 },
      risk: "low",
      reward_money: 900,
      reward_reputation: 1,
    },
    {
      name: "Audit express",
      duration_tier: "FLASH",
      duration_seconds: 90,
      requirements: { finance: 60, legal: 20 },
      risk: "low",
      reward_money: 1400,
      reward_reputation: 1,
    },
    {
      name: "Négociation fournisseur",
      duration_tier: "SHORT",
      duration_seconds: 180,
      requirements: { finance: 70, management: 30 },
      risk: "medium",
      reward_money: 2600,
      reward_reputation: 2,
    },
    {
      name: "Contentieux discret",
      duration_tier: "SHORT",
      duration_seconds: 240,
      requirements: { legal: 80, management: 20 },
      risk: "medium",
      reward_money: 3200,
      reward_reputation: 3,
    },
    {
      name: "Acquisition hostile",
      duration_tier: "STANDARD",
      duration_seconds: 300,
      requirements: { finance: 180, legal: 120, management: 70 },
      risk: "high",
      reward_money: 8000,
      reward_reputation: 5,
    },
    {
      name: "Fusion discrète",
      duration_tier: "EXPEDITION",
      duration_seconds: 600,
      requirements: { finance: 150, legal: 100, management: 100 },
      risk: "high",
      reward_money: 14000,
      reward_reputation: 8,
    },
  ];

  const insertAll = db.transaction((items) => {
    for (const c of items) {
      insert.run({
        name: c.name,
        duration_tier: c.duration_tier,
        duration_seconds: c.duration_seconds,
        requirements: JSON.stringify(c.requirements),
        risk: c.risk,
        reward_money: c.reward_money,
        reward_reputation: c.reward_reputation,
      });
    }
  });
  insertAll(contracts);
  console.log(`[db] Seeded ${contracts.length} contracts (durations compressed for prototyping).`);
}

function ensureCharacters() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM characters").get();
  if (existing.n > 0) return;

  const now = Date.now();
  const minutesAgo = (m) => new Date(now - m * 60 * 1000).toISOString();

  const insert = db.prepare(`
    INSERT INTO characters (key, name, title, avatar_file, accent_color, flavor,
      affinity, trust, respect, attraction, fear, rivalry, last_interaction_at, last_decay_at)
    VALUES (@key, @name, @title, @avatar_file, @accent_color, @flavor,
      @affinity, @trust, @respect, @attraction, @fear, @rivalry, @last_interaction_at, @last_decay_at)
  `);

  const characters = [
    {
      key: "morrigan",
      name: "Morrigan",
      title: "VP Finance — Greed Division",
      avatar_file: "morrigan.png",
      accent_color: "#c9a227",
      flavor: "Ambitieuse, sarcastique, calculatrice. Déteste devoir quoi que ce soit à qui que ce soit.",
      affinity: 25, trust: 20, respect: 35, attraction: 15, fear: 20, rivalry: 30,
      last_interaction_at: minutesAgo(6),
      last_decay_at: minutesAgo(6),
    },
    {
      key: "lucy",
      name: "Lucy",
      title: "Assistante exécutive",
      avatar_file: "lucy.png",
      accent_color: "#8a8350",
      flavor: "Intelligente, pratique, observatrice. Plus mystérieuse qu'elle n'y paraît.",
      affinity: 45, trust: 40, respect: 30, attraction: 25, fear: 5, rivalry: 5,
      last_interaction_at: minutesAgo(4),
      last_decay_at: minutesAgo(4),
    },
    {
      key: "malphas",
      name: "Malphas",
      title: "Directrice des affaires occultes",
      avatar_file: "malphas.png",
      accent_color: "#7a1f3a",
      flavor: "Calme, précise, ancienne. Fascinée par les pactes et les règles.",
      affinity: 20, trust: 35, respect: 45, attraction: 15, fear: 25, rivalry: 10,
      last_interaction_at: minutesAgo(10),
      last_decay_at: minutesAgo(10),
    },
    {
      key: "raven",
      name: "Raven",
      title: "Directrice de la sécurité",
      avatar_file: "raven.png",
      accent_color: "#3a4a5c",
      flavor: "Directe, disciplinée, vigilante. Protectrice malgré elle.",
      affinity: 30, trust: 35, respect: 40, attraction: 15, fear: 10, rivalry: 15,
      last_interaction_at: minutesAgo(8),
      last_decay_at: minutesAgo(8),
    },
  ];

  const insertAll = db.transaction((items) => {
    for (const c of items) insert.run(c);
  });
  insertAll(characters);
  console.log(`[db] Seeded ${characters.length} characters (relationship system).`);
}

function ensureMessages() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
  if (existing.n > 0) return;

  const now = Date.now();
  const minutesAgo = (m) => new Date(now - m * 60 * 1000).toISOString();

  const insert = db.prepare(`
    INSERT INTO messages (character_key, sender, kind, body, read, created_at)
    VALUES (@character_key, @sender, 'chat', @body, @read, @created_at)
  `);

  const thread = [
    { character_key: "morrigan", sender: "character", body: "Les chiffres du trimestre sont sur ton bureau. Ne me fais pas attendre.", read: 1, created_at: minutesAgo(180) },
    { character_key: "morrigan", sender: "player", body: "Bien reçu. On garde ça strictement pro.", read: 1, created_at: minutesAgo(178) },
    { character_key: "morrigan", sender: "character", body: "Tu es encore au bureau ? Intéressant.", read: 0, created_at: minutesAgo(6) },

    { character_key: "lucy", sender: "character", body: "Tu es encore au bureau ?", read: 1, created_at: minutesAgo(90) },
    { character_key: "lucy", sender: "player", body: "Merci pour ton travail, ça compte pour moi.", read: 1, created_at: minutesAgo(88) },
    { character_key: "lucy", sender: "character", body: "J'ai laissé le dossier de Morrigan sur ton bureau, au cas où.", read: 0, created_at: minutesAgo(4) },

    { character_key: "malphas", sender: "character", body: "Nous avons un problème aux archives.", read: 0, created_at: minutesAgo(10) },

    { character_key: "raven", sender: "character", body: "Accès de sécurité verrouillé au sous-sol. Je m'en occupe.", read: 0, created_at: minutesAgo(8) },
  ];

  const insertAll = db.transaction((items) => {
    for (const m of items) insert.run(m);
  });
  insertAll(thread);
  console.log(`[db] Seeded ${thread.length} seed messages across 4 characters.`);
}

function ensureEvents() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM events").get();
  if (existing.n > 0) return;

  const insert = db.prepare(`
    INSERT INTO events (key, character_key, title, requirements, body, choices)
    VALUES (@key, @character_key, @title, @requirements, @body, @choices)
  `);

  const events = [
    {
      key: "morrigan_late_night_01",
      character_key: "morrigan",
      title: "Fin de soirée",
      requirements: {},
      body: 'Morrigan traîne encore dans son bureau après l\'heure. "Tout le monde est parti. Toi non."',
      choices: [
        { id: "a", label: "Rester discuter", effects: { trust: 5, affinity: 3 }, set_flags: ["morrigan_late_night_01_done"], unlock_memory: { key: "morrigan_late_night", title: "Late Night" }, reaction: "Elle esquisse un sourire rare. \"Ne t'habitue pas à ça.\"" },
        { id: "b", label: "Rester strictement professionnel", effects: { respect: 5 }, set_flags: ["morrigan_late_night_01_done"], unlock_memory: { key: "morrigan_late_night", title: "Late Night" }, reaction: "Elle hoche la tête. \"Au moins, toi, tu comprends les priorités.\"" },
        { id: "c", label: "Flirter légèrement", effects: { attraction: 6, rivalry: 2 }, set_flags: ["morrigan_late_night_01_done"], unlock_memory: { key: "morrigan_late_night", title: "Late Night" }, reaction: "Elle hausse un sourcil, amusée malgré elle. \"Prudent, PDG. Très prudent.\"" },
      ],
    },
    {
      key: "morrigan_boardroom_war",
      character_key: "morrigan",
      title: "Guerre en salle de conseil",
      requirements: { flags: ["morrigan_late_night_01_done"], trust_min: 10 },
      body: "Un autre VP tente de saper ton autorité en pleine réunion. Morrigan te regarde, attendant de voir comment tu réagis.",
      choices: [
        { id: "a", label: "La défendre publiquement", effects: { trust: 8, respect: 5, rivalry: -3 }, unlock_memory: { key: "morrigan_boardroom_war", title: "Boardroom War" }, reaction: "\"Tu viens de te faire un ennemi. Et une alliée.\"" },
        { id: "b", label: "Rester neutre, observer", effects: { respect: -2, fear: 3 }, unlock_memory: { key: "morrigan_boardroom_war", title: "Boardroom War" }, reaction: "Elle ne dit rien. Son silence est pire qu'un reproche." },
        { id: "c", label: "La laisser gérer seule", effects: { trust: -5, respect: 2 }, unlock_memory: { key: "morrigan_boardroom_war", title: "Boardroom War" }, reaction: "Elle règle ça seule, brutalement efficace. \"Je n'ai pas besoin qu'on me sauve.\"" },
      ],
    },
    {
      key: "lucy_after_hours",
      character_key: "lucy",
      title: "Lucy reste tard",
      requirements: {},
      body: 'Lucy classe encore des dossiers bien après la fin officielle de la journée. "Quelqu\'un doit garder cette boîte organisée..."',
      choices: [
        { id: "a", label: "Lui demander pourquoi elle reste", effects: { trust: 5, affinity: 3 }, unlock_memory: { key: "lucy_after_hours", title: "After Hours" }, reaction: "Elle hésite, puis sourit. \"Une autre fois, peut-être.\"" },
        { id: "b", label: "La remercier et rentrer", effects: { respect: 3 }, unlock_memory: { key: "lucy_after_hours", title: "After Hours" }, reaction: "\"Bonne nuit, patron.\"" },
        { id: "c", label: "Rester travailler avec elle", effects: { affinity: 6, attraction: 3 }, unlock_memory: { key: "lucy_after_hours", title: "After Hours" }, reaction: "Elle pousse une pile de dossiers vers toi sans un mot. Un petit sourire en coin." },
      ],
    },
    {
      key: "malphas_sealed_file",
      character_key: "malphas",
      title: "Une requête des archives",
      requirements: {},
      body: 'Malphas te tend un dossier scellé. "Certains contrats ne devraient jamais être rouverts. Celui-ci l\'a été."',
      choices: [
        { id: "a", label: "Enquêter avec elle", effects: { trust: 6, fear: 2 }, unlock_memory: { key: "malphas_sealed_file", title: "Sealed File" }, reaction: "\"Curieux. La plupart des PDG préfèrent ne pas savoir.\"" },
        { id: "b", label: "Refuser de t'impliquer", effects: { respect: -3, fear: -2 }, unlock_memory: { key: "malphas_sealed_file", title: "Sealed File" }, reaction: "Elle range le dossier sans un mot de plus." },
        { id: "c", label: "Lui faire confiance sans poser de questions", effects: { trust: 8, respect: 4 }, unlock_memory: { key: "malphas_sealed_file", title: "Sealed File" }, reaction: "\"C'est la première fois qu'on me dit ça ici.\"" },
      ],
    },
    {
      key: "raven_first_breach",
      character_key: "raven",
      title: "Brèche de sécurité",
      requirements: {},
      body: 'Raven débarque sans prévenir. "Quelqu\'un a accédé à ton étage cette nuit. Ce n\'était pas autorisé."',
      choices: [
        { id: "a", label: "La laisser gérer à sa façon", effects: { trust: 6, respect: 3 }, unlock_memory: { key: "raven_first_breach", title: "First Breach" }, reaction: "\"Ce sera réglé avant l'aube.\"" },
        { id: "b", label: "Exiger un rapport complet", effects: { respect: -2, fear: 3, rivalry: 2 }, unlock_memory: { key: "raven_first_breach", title: "First Breach" }, reaction: "Elle te tend un rapport froid, exhaustif, sans un mot en trop." },
        { id: "c", label: "La remercier pour sa vigilance", effects: { affinity: 5, trust: 3 }, unlock_memory: { key: "raven_first_breach", title: "First Breach" }, reaction: "Elle semble surprise, presque désarmée. \"...De rien.\"" },
      ],
    },
  ];

  const insertAll = db.transaction((items) => {
    for (const e of items) {
      insert.run({
        key: e.key,
        character_key: e.character_key,
        title: e.title,
        requirements: JSON.stringify(e.requirements),
        body: e.body,
        choices: JSON.stringify(e.choices),
      });
    }
  });
  insertAll(events);
  console.log(`[db] Seeded ${events.length} Event Director events (5 events, 2 chained for Morrigan).`);
}

function ensureQuests() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM quests").get();
  if (existing.n > 0) return;

  const insert = db.prepare(`
    INSERT INTO quests (key, title, description, category, objective_type, objective_target, objective_count, reward_money, reward_reputation, requirements, set_flags_on_complete)
    VALUES (@key, @title, @description, @category, @objective_type, @objective_target, @objective_count, @reward_money, @reward_reputation, @requirements, @set_flags_on_complete)
  `);

  // All start 'locked' — unlockEligibleQuests() promotes any whose requirements are already
  // met (an empty {flags:[]} is trivially met) the first time /api/quests is hit, same lazy
  // pattern as the Event Director triggering its own events.
  const quests = [
    {
      key: "first_day",
      title: "Premier jour",
      description: "Va discuter avec Lucy dans l'open space.",
      category: "main",
      objective_type: "talk_to_npc",
      objective_target: { character_key: "lucy" },
      objective_count: 1,
      reward_money: 5000,
      reward_reputation: 10,
      requirements: {},
      set_flags_on_complete: ["quest_first_day_done"],
    },
    {
      key: "quick_contract",
      title: "Contrat rapide",
      description: "Termine un contrat, succès ou échec.",
      category: "contracts",
      objective_type: "complete_contract",
      objective_target: {},
      objective_count: 1,
      reward_money: 8000,
      reward_reputation: 15,
      requirements: { flags: ["quest_first_day_done"] },
      set_flags_on_complete: ["quest_quick_contract_done"],
    },
    {
      key: "recruitment",
      title: "Recrutement",
      description: "Embauche un nouvel employé.",
      category: "recruitment",
      objective_type: "hire_employee",
      objective_target: {},
      objective_count: 1,
      reward_money: 6000,
      reward_reputation: 12,
      requirements: { flags: ["quest_first_day_done"] },
      set_flags_on_complete: ["quest_recruitment_done"],
    },
    {
      key: "team_building",
      title: "Construire l'équipe",
      description: "Recrute 3 employés au total.",
      category: "recruitment",
      objective_type: "hire_employee",
      objective_target: {},
      objective_count: 3,
      reward_money: 12000,
      reward_reputation: 20,
      requirements: { flags: ["quest_recruitment_done"] },
      set_flags_on_complete: ["quest_team_building_done"],
    },
    {
      key: "lucy_trust",
      title: "Gagner la confiance de Lucy",
      description: "Fais en sorte que Lucy te fasse davantage confiance (confiance ≥ 50).",
      category: "relationships",
      objective_type: "reach_stat",
      objective_target: { character_key: "lucy", stat: "trust", min: 50 },
      objective_count: 1,
      reward_money: 3000,
      reward_reputation: 5,
      requirements: {},
      set_flags_on_complete: ["quest_lucy_trust_done"],
    },
  ];

  const insertAll = db.transaction((items) => {
    for (const q of items) {
      insert.run({
        key: q.key,
        title: q.title,
        description: q.description,
        category: q.category,
        objective_type: q.objective_type,
        objective_target: JSON.stringify(q.objective_target),
        objective_count: q.objective_count,
        reward_money: q.reward_money,
        reward_reputation: q.reward_reputation,
        requirements: JSON.stringify(q.requirements),
        set_flags_on_complete: JSON.stringify(q.set_flags_on_complete),
      });
    }
  });
  insertAll(quests);
  console.log(`[db] Seeded ${quests.length} quests.`);
}

ensureMap("office_floor");
ensureDefaultUser();
ensureGameState();
ensureRoster();
ensureContracts();
ensureCharacters();
ensureMessages();
ensureEvents();
ensureQuests();

module.exports = db;
