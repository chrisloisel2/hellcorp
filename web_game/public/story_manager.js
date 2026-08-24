const STATS = ["affinity", "trust", "respect", "attraction", "fear", "rivalry"];
const STAT_LABELS = { affinity: "Affinité", trust: "Confiance", respect: "Respect", attraction: "Attraction", fear: "Peur", rivalry: "Rivalité" };

let characters = [];
let events = [];
let filterCharacter = "";
let currentEventId = null; // null = creating a new event

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

// --- Characters ---

async function loadCharacters() {
  const res = await fetch("/api/characters");
  characters = await res.json();

  const filterSelect = document.getElementById("filter-character");
  filterSelect.innerHTML = '<option value="">Tous</option>';
  const evSelect = document.getElementById("ev-character");
  evSelect.innerHTML = "";
  characters.forEach((c) => {
    const opt1 = document.createElement("option");
    opt1.value = c.key;
    opt1.textContent = c.name;
    filterSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = c.key;
    opt2.textContent = c.name;
    evSelect.appendChild(opt2);
  });
}

document.getElementById("filter-character").addEventListener("change", (e) => {
  filterCharacter = e.target.value;
  loadEvents();
  loadMemories();
});

// --- Events list ---

async function loadEvents() {
  const url = filterCharacter ? `/api/story/events?character_key=${filterCharacter}` : "/api/story/events";
  const res = await fetch(url);
  events = res.ok ? await res.json() : [];
  renderEventsList();
}

function renderEventsList() {
  const list = document.getElementById("events-list");
  list.innerHTML = "";
  events.forEach((ev) => {
    const row = el("div", "event-row");
    if (ev.id === currentEventId) row.classList.add("active");
    row.appendChild(text("div", "event-row-title", ev.title));
    const meta = el("div", "event-row-meta");
    const charName = characters.find((c) => c.key === ev.character_key)?.name || ev.character_key;
    meta.appendChild(text("span", null, charName));
    meta.appendChild(text("span", `status-badge ${ev.status}`, statusLabel(ev)));
    row.appendChild(meta);
    row.addEventListener("click", () => selectEvent(ev.id));
    list.appendChild(row);
  });
}

function statusLabel(ev) {
  if (ev.status === "completed") return "terminé";
  if (ev.triggered_at) return "déclenché";
  return "en attente";
}

document.getElementById("new-event-btn").addEventListener("click", () => newEvent());

// --- Requirements builder ---

function renderStatRequirements(requirements) {
  const wrap = document.getElementById("stat-requirements");
  wrap.innerHTML = "";
  STATS.forEach((stat) => {
    const item = el("div", "stat-req-item");
    item.appendChild(text("span", "stat-name", STAT_LABELS[stat]));
    const row = el("div", "minmax-row");

    const minInput = document.createElement("input");
    minInput.type = "number";
    minInput.placeholder = "min";
    minInput.dataset.stat = stat;
    minInput.dataset.bound = "min";
    minInput.value = requirements?.[`${stat}_min`] ?? "";

    const maxInput = document.createElement("input");
    maxInput.type = "number";
    maxInput.placeholder = "max";
    maxInput.dataset.stat = stat;
    maxInput.dataset.bound = "max";
    maxInput.value = requirements?.[`${stat}_max`] ?? "";

    row.appendChild(minInput);
    row.appendChild(maxInput);
    item.appendChild(row);
    wrap.appendChild(item);
  });
}

function collectRequirements() {
  const requirements = {};
  document.querySelectorAll("#stat-requirements input").forEach((input) => {
    if (input.value === "") return;
    requirements[`${input.dataset.stat}_${input.dataset.bound}`] = parseFloat(input.value);
  });
  const flagsRaw = document.getElementById("ev-flags").value.trim();
  if (flagsRaw) {
    requirements.flags = flagsRaw.split(",").map((f) => f.trim()).filter(Boolean);
  }
  return requirements;
}

// --- Choices builder ---

function choiceCard(choice) {
  const card = el("div", "choice-card");

  const idRow = el("div", "row");
  idRow.appendChild(text("label", null, "Identifiant du choix"));
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.className = "choice-id";
  idInput.value = choice.id || "";
  idInput.placeholder = "ex: a";
  idRow.appendChild(idInput);
  card.appendChild(idRow);

  const labelRow = el("div", "row");
  labelRow.appendChild(text("label", null, "Texte du bouton"));
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "choice-label";
  labelInput.value = choice.label || "";
  labelRow.appendChild(labelInput);
  card.appendChild(labelRow);

  const effectsWrap = el("div", "choice-effects");
  STATS.forEach((stat) => {
    const field = el("div", "field");
    field.appendChild(text("span", null, STAT_LABELS[stat]));
    const input = document.createElement("input");
    input.type = "number";
    input.className = "choice-effect";
    input.dataset.stat = stat;
    input.value = choice.effects?.[stat] ?? "";
    input.placeholder = "0";
    field.appendChild(input);
    effectsWrap.appendChild(field);
  });
  card.appendChild(effectsWrap);

  const flagsRow = el("div", "row");
  flagsRow.appendChild(text("label", null, "Flags à activer"));
  const flagsInput = document.createElement("input");
  flagsInput.type = "text";
  flagsInput.className = "choice-flags";
  flagsInput.value = (choice.set_flags || []).join(", ");
  flagsInput.placeholder = "ex: lucy_confession_done";
  flagsRow.appendChild(flagsInput);
  card.appendChild(flagsRow);

  const memKeyRow = el("div", "row");
  memKeyRow.appendChild(text("label", null, "Souvenir — clé"));
  const memKeyInput = document.createElement("input");
  memKeyInput.type = "text";
  memKeyInput.className = "choice-memory-key";
  memKeyInput.value = choice.unlock_memory?.key || "";
  memKeyRow.appendChild(memKeyInput);
  card.appendChild(memKeyRow);

  const memTitleRow = el("div", "row");
  memTitleRow.appendChild(text("label", null, "Souvenir — titre"));
  const memTitleInput = document.createElement("input");
  memTitleInput.type = "text";
  memTitleInput.className = "choice-memory-title";
  memTitleInput.value = choice.unlock_memory?.title || "";
  memTitleRow.appendChild(memTitleInput);
  card.appendChild(memTitleRow);

  const reactionRow = el("div", "row align-top");
  reactionRow.appendChild(text("label", null, "Réaction du personnage"));
  const reactionInput = document.createElement("textarea");
  reactionInput.rows = 2;
  reactionInput.className = "choice-reaction";
  reactionInput.value = choice.reaction || "";
  reactionRow.appendChild(reactionInput);
  card.appendChild(reactionRow);

  const actions = el("div", "choice-card-actions");
  const removeBtn = text("button", null, "Supprimer ce choix");
  removeBtn.addEventListener("click", () => card.remove());
  actions.appendChild(removeBtn);
  card.appendChild(actions);

  return card;
}

function renderChoices(choices) {
  const wrap = document.getElementById("choices-list");
  wrap.innerHTML = "";
  (choices.length ? choices : [{ id: "a", label: "" }]).forEach((c) => wrap.appendChild(choiceCard(c)));
}

document.getElementById("add-choice-btn").addEventListener("click", () => {
  document.getElementById("choices-list").appendChild(choiceCard({ id: "", label: "" }));
});

function collectChoices() {
  return [...document.querySelectorAll(".choice-card")].map((card) => {
    const effects = {};
    card.querySelectorAll(".choice-effect").forEach((input) => {
      if (input.value !== "" && parseFloat(input.value) !== 0) effects[input.dataset.stat] = parseFloat(input.value);
    });
    const flagsRaw = card.querySelector(".choice-flags").value.trim();
    const memKey = card.querySelector(".choice-memory-key").value.trim();
    const memTitle = card.querySelector(".choice-memory-title").value.trim();
    const choice = {
      id: card.querySelector(".choice-id").value.trim(),
      label: card.querySelector(".choice-label").value.trim(),
    };
    if (Object.keys(effects).length) choice.effects = effects;
    if (flagsRaw) choice.set_flags = flagsRaw.split(",").map((f) => f.trim()).filter(Boolean);
    if (memKey && memTitle) choice.unlock_memory = { key: memKey, title: memTitle };
    const reaction = card.querySelector(".choice-reaction").value.trim();
    if (reaction) choice.reaction = reaction;
    return choice;
  });
}

// --- Event editor ---

function newEvent() {
  currentEventId = null;
  renderEventsList();
  document.getElementById("editor-empty-hint").hidden = true;
  document.getElementById("editor-form").hidden = false;
  document.getElementById("editor-status-line").textContent = "Nouvel événement (pas encore sauvegardé).";
  document.getElementById("editor-status").textContent = "";

  document.getElementById("ev-key").value = "";
  document.getElementById("ev-key").disabled = false;
  document.getElementById("ev-character").value = filterCharacter || characters[0]?.key || "";
  document.getElementById("ev-title").value = "";
  document.getElementById("ev-body").value = "";
  document.getElementById("ev-flags").value = "";
  renderStatRequirements({});
  renderChoices([]);

  document.getElementById("reset-event-btn").hidden = true;
  document.getElementById("delete-event-btn").hidden = true;
}

function selectEvent(id) {
  const ev = events.find((e) => e.id === id);
  if (!ev) return;
  currentEventId = id;
  renderEventsList();

  document.getElementById("editor-empty-hint").hidden = true;
  document.getElementById("editor-form").hidden = false;
  document.getElementById("editor-status").textContent = "";

  const statusBits = [`statut : ${statusLabel(ev)}`];
  if (ev.triggered_at) statusBits.push(`déclenché le ${new Date(ev.triggered_at).toLocaleString()}`);
  if (ev.completed_at) statusBits.push(`complété le ${new Date(ev.completed_at).toLocaleString()} (choix ${ev.completed_choice_id})`);
  document.getElementById("editor-status-line").textContent = statusBits.join(" — ");

  document.getElementById("ev-key").value = ev.key;
  document.getElementById("ev-key").disabled = true; // stable identifier once created
  document.getElementById("ev-character").value = ev.character_key;
  document.getElementById("ev-title").value = ev.title;
  document.getElementById("ev-body").value = ev.body;
  document.getElementById("ev-flags").value = (ev.requirements.flags || []).join(", ");
  renderStatRequirements(ev.requirements);
  renderChoices(ev.choices);

  document.getElementById("reset-event-btn").hidden = ev.status === "pending" && !ev.triggered_at;
  document.getElementById("delete-event-btn").hidden = false;
}

document.getElementById("save-event-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("editor-status");
  const payload = {
    key: document.getElementById("ev-key").value.trim().toLowerCase(),
    character_key: document.getElementById("ev-character").value,
    title: document.getElementById("ev-title").value.trim(),
    body: document.getElementById("ev-body").value.trim(),
    requirements: collectRequirements(),
    choices: collectChoices(),
  };

  const isNew = currentEventId == null;
  const res = await fetch(isNew ? "/api/story/events" : `/api/story/events/${currentEventId}`, {
    method: isNew ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    statusEl.textContent = data.error || "Erreur lors de la sauvegarde.";
    return;
  }

  await loadEvents();
  selectEvent(data.id); // clears #editor-status as part of switching events — must run before the success message below, not after
  statusEl.textContent = "Sauvegardé.";
});

document.getElementById("delete-event-btn").addEventListener("click", async () => {
  if (currentEventId == null) return;
  if (!confirm("Supprimer définitivement cet événement ?")) return;
  await fetch(`/api/story/events/${currentEventId}`, { method: "DELETE" });
  currentEventId = null;
  await loadEvents();
  document.getElementById("editor-form").hidden = true;
  document.getElementById("editor-empty-hint").hidden = false;
});

document.getElementById("reset-event-btn").addEventListener("click", async () => {
  if (currentEventId == null) return;
  const res = await fetch(`/api/story/events/${currentEventId}/reset`, { method: "POST" });
  const data = await res.json();
  await loadEvents();
  if (res.ok) selectEvent(data.id);
});

// --- Global story state: flags & memories ---

async function loadFlags() {
  const res = await fetch("/api/story/flags");
  const flags = await res.json();
  const wrap = document.getElementById("flags-list");
  wrap.innerHTML = "";
  if (flags.length === 0) {
    wrap.appendChild(text("span", "hint", "Aucun flag activé pour l'instant."));
    return;
  }
  flags.forEach((f) => {
    const chip = el("div", "chip");
    chip.appendChild(text("span", null, f.key));
    const removeBtn = text("button", null, "×");
    removeBtn.addEventListener("click", async () => {
      await fetch(`/api/story/flags/${f.key}`, { method: "DELETE" });
      loadFlags();
    });
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

async function loadMemories() {
  const url = filterCharacter ? `/api/story/memories?character_key=${filterCharacter}` : "/api/story/memories";
  const res = await fetch(url);
  const memories = await res.json();
  const wrap = document.getElementById("memories-list");
  wrap.innerHTML = "";
  if (memories.length === 0) {
    wrap.appendChild(text("span", "hint", "Aucun souvenir débloqué pour l'instant."));
    return;
  }
  memories.forEach((m) => {
    const charName = characters.find((c) => c.key === m.character_key)?.name || m.character_key;
    const chip = el("div", "chip");
    chip.appendChild(text("span", null, `${charName} — ${m.title}`));
    const removeBtn = text("button", null, "×");
    removeBtn.addEventListener("click", async () => {
      await fetch(`/api/story/memories/${m.character_key}/${m.key}`, { method: "DELETE" });
      loadMemories();
    });
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

// --- Boot ---

loadWhoAmI();
loadCharacters().then(() => {
  loadEvents();
  loadFlags();
  loadMemories();
});
