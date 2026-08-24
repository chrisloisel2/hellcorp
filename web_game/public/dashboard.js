const STAT_LABELS = { finance: "Fin", legal: "Leg", marketing: "Mkt", occult: "Occ", security: "Sec", management: "Mgmt" };
let charactersCache = [];

function formatMoney(n) {
  return Math.round(n).toLocaleString("fr-FR") + " $";
}

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children) for (const c of children) node.appendChild(c);
  return node;
}

function text(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

// --- Tabs ---

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
  });
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

// --- State header ---

async function refreshState() {
  const res = await fetch("/api/state");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  const state = await res.json();

  document.getElementById("stat-capital").textContent = formatMoney(state.capital);
  document.getElementById("stat-revenue").textContent = formatMoney(state.revenue_per_hour);
  document.getElementById("stat-reputation").textContent = state.reputation;
  document.getElementById("stat-employees").textContent = state.employee_count;

  const summary = document.getElementById("summary");
  summary.innerHTML = "";
  const lines = [];
  const totalUnread = charactersCache.reduce((sum, c) => sum + c.unread, 0);
  if (totalUnread > 0) lines.push(`${totalUnread} message(s) non lu(s)`);
  if (state.contracts_ready_to_collect > 0) lines.push(`${state.contracts_ready_to_collect} contrat(s) prêt(s) à collecter`);
  if (state.contracts_active > 0) lines.push(`${state.contracts_active} contrat(s) en cours`);
  if (state.candidates_available > 0) lines.push(`${state.candidates_available} candidat(s) disponible(s)`);
  if (lines.length === 0) lines.push("Rien de particulier à signaler.");
  lines.forEach((l) => summary.appendChild(text("li", null, l)));
}

// --- Contracts ---

const selectedEmployees = new Map(); // contract id -> Set of employee ids
const expandedContracts = new Set();
let hiredEmployeesCache = [];

function requirementChips(requirements) {
  const wrap = el("div", "chips");
  Object.entries(requirements).forEach(([k, v]) => {
    wrap.appendChild(text("span", "chip", `${STAT_LABELS[k] || k} ${v}`));
  });
  return wrap;
}

function contractCard(c) {
  const card = el("div", "card");
  const title = el("div", "card-title-row");
  title.appendChild(text("span", "name", c.name));
  title.appendChild(text("span", `badge risk-${c.risk}`, c.risk));
  card.appendChild(title);
  card.appendChild(text("div", "card-footer", `${c.duration_tier} · ${formatMoney(c.reward_money)} · +${c.reward_reputation} rép.`));
  card.appendChild(requirementChips(c.requirements));

  if (c.status === "available") {
    const expanded = expandedContracts.has(c.id);
    const assignBtn = text("button", "btn", expanded ? "Annuler" : "Assigner une équipe");
    assignBtn.addEventListener("click", () => {
      if (expanded) expandedContracts.delete(c.id); else expandedContracts.add(c.id);
      renderContractsFromCache();
    });
    const actions = el("div", "card-actions", [assignBtn]);
    card.appendChild(actions);

    if (expanded) {
      if (!selectedEmployees.has(c.id)) selectedEmployees.set(c.id, new Set());
      const selected = selectedEmployees.get(c.id);

      const chips = el("div", "chips");
      hiredEmployeesCache.forEach((emp) => {
        const chip = text("span", "chip selectable", emp.name);
        if (emp.busy) chip.classList.add("busy");
        if (selected.has(emp.id)) chip.classList.add("selected");
        if (!emp.busy) {
          chip.addEventListener("click", () => {
            if (selected.has(emp.id)) selected.delete(emp.id); else selected.add(emp.id);
            renderContractsFromCache();
          });
        }
        chips.appendChild(chip);
      });
      card.appendChild(chips);

      const launchBtn = text("button", "btn primary", "Lancer le contrat");
      launchBtn.disabled = selected.size === 0;
      launchBtn.addEventListener("click", async () => {
        const res = await fetch(`/api/contracts/${c.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ employee_ids: [...selected] }),
        });
        if (res.ok) {
          expandedContracts.delete(c.id);
          selectedEmployees.delete(c.id);
          await Promise.all([refreshContracts(), refreshState(), refreshEmployees()]);
        }
      });
      card.appendChild(el("div", "card-actions", [launchBtn]));
    }
  } else if (c.status === "active") {
    const footer = el("div", "card-footer");
    const countdown = text("span", "countdown", formatCountdown(c.remaining_seconds));
    footer.appendChild(countdown);
    const collectBtn = text("button", "btn primary", "Collecter");
    collectBtn.disabled = !c.ready_to_collect;
    collectBtn.dataset.contractId = c.id;
    collectBtn.dataset.remaining = c.remaining_seconds;
    collectBtn.addEventListener("click", async () => {
      const res = await fetch(`/api/contracts/${c.id}/collect`, { method: "POST" });
      if (res.ok) await Promise.all([refreshContracts(), refreshState(), refreshEmployees()]);
    });
    card.appendChild(footer);
    card.appendChild(el("div", "card-actions", [collectBtn]));
    card._countdownEl = countdown;
    card._remaining = c.remaining_seconds;
    card._collectBtn = collectBtn;
  } else {
    card.classList.add("completed");
    card.appendChild(text("div", `badge outcome-${c.outcome}`, c.outcome === "success" ? "Réussi" : "Échoué"));
    if (c.outcome === "success") {
      card.appendChild(text("div", "card-footer", `Gagné : ${formatMoney(c.actual_reward_money)} · +${c.actual_reward_reputation} rép.`));
    }
  }

  return card;
}

function formatCountdown(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${rest.toString().padStart(2, "0")}`;
}

let contractsCache = [];

function renderContractsFromCache() {
  const list = document.getElementById("contracts-list");
  list.innerHTML = "";
  const order = { active: 0, available: 1, completed: 2 };
  const sorted = [...contractsCache].sort((a, b) => order[a.status] - order[b.status]);
  sorted.forEach((c) => list.appendChild(contractCard(c)));
}

async function refreshContracts() {
  const res = await fetch("/api/contracts");
  contractsCache = await res.json();
  renderContractsFromCache();
}

// tick active countdowns every second without refetching
setInterval(() => {
  document.querySelectorAll("#contracts-list .card").forEach((card) => {
    if (card._remaining == null) return;
    card._remaining = Math.max(0, card._remaining - 1);
    card._countdownEl.textContent = formatCountdown(card._remaining);
    if (card._remaining <= 0) card._collectBtn.disabled = false;
  });
}, 1000);

// periodically resync with server (catches state changes, clock drift)
setInterval(() => { refreshContracts(); refreshState(); }, 8000);

// --- Employees ---

function statBars(emp) {
  const bars = el("div", "bars");
  [["fatigue", emp.fatigue], ["motivation", emp.motivation], ["stress", emp.stress]].forEach(([label, val]) => {
    const row = el("div", "bar-row");
    row.appendChild(text("span", "bar-label", label));
    const track = el("div", "bar-track");
    const fill = el("div", `bar-fill ${label}`);
    fill.style.width = `${Math.min(100, val)}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(text("span", null, val));
    bars.appendChild(row);
  });
  return bars;
}

function employeeCard(emp) {
  const card = el("div", "card");
  const title = el("div", "card-title-row");
  title.appendChild(text("span", "name", emp.name));
  if (emp.is_major) title.appendChild(text("span", "badge major", "Majeur"));
  if (emp.busy) title.appendChild(text("span", "badge", "Occupé"));
  card.appendChild(title);
  card.appendChild(text("div", "card-footer", emp.department));

  const chips = el("div", "chips");
  Object.entries(emp.stats).forEach(([k, v]) => chips.appendChild(text("span", "chip", `${STAT_LABELS[k] || k} ${v}`)));
  card.appendChild(chips);

  if (emp.traits.length) {
    const traitChips = el("div", "chips");
    emp.traits.forEach((t) => traitChips.appendChild(text("span", "chip", t)));
    card.appendChild(traitChips);
  }

  card.appendChild(statBars(emp));
  return card;
}

async function refreshEmployees() {
  const res = await fetch("/api/employees");
  const employees = await res.json();
  hiredEmployeesCache = employees;
  const list = document.getElementById("employees-list");
  list.innerHTML = "";
  employees.forEach((e) => list.appendChild(employeeCard(e)));
}

// --- Recruits ---

function recruitCard(r) {
  const card = el("div", "card");
  const title = el("div", "card-title-row");
  title.appendChild(text("span", "name", r.name));
  if (r.is_major) title.appendChild(text("span", "badge major", "Histoire"));
  card.appendChild(title);
  card.appendChild(text("div", "card-footer", r.department));
  if (r.flavor) card.appendChild(text("div", "empty-hint", r.flavor));

  const chips = el("div", "chips");
  Object.entries(r.stats).forEach(([k, v]) => chips.appendChild(text("span", "chip", `${STAT_LABELS[k] || k} ${v}`)));
  card.appendChild(chips);

  const hireBtn = text("button", "btn primary", `Recruter — ${formatMoney(r.hire_cost)}`);
  hireBtn.addEventListener("click", async () => {
    const res = await fetch(`/api/recruits/${r.id}/hire`, { method: "POST" });
    if (res.ok) await Promise.all([refreshRecruits(), refreshEmployees(), refreshState()]);
    else {
      const data = await res.json().catch(() => ({}));
      if (data.error === "insufficient capital") hireBtn.textContent = "Capital insuffisant";
    }
  });
  card.appendChild(el("div", "card-actions", [hireBtn]));
  return card;
}

async function refreshRecruits() {
  const res = await fetch("/api/recruits");
  const recruits = await res.json();
  const list = document.getElementById("recruits-list");
  list.innerHTML = "";
  recruits.forEach((r) => list.appendChild(recruitCard(r)));
}

// --- Messages preview ---

function messagePreviewCard(c) {
  const card = el("div", "card");
  const title = el("div", "card-title-row");
  title.appendChild(text("span", "name", c.name));
  if (c.unread > 0) title.appendChild(text("span", "badge major", `${c.unread} non lu(s)`));
  card.appendChild(title);
  if (c.last_message) card.appendChild(text("div", "card-footer", (c.last_message.sender === "player" ? "Toi : " : "") + c.last_message.body));
  card.appendChild(text("div", "empty-hint", c.sentiment[0] || ""));
  return card;
}

async function refreshMessagesPreview() {
  const res = await fetch("/api/characters");
  charactersCache = await res.json();
  const list = document.getElementById("messages-preview");
  list.innerHTML = "";
  charactersCache.forEach((c) => list.appendChild(messagePreviewCard(c)));
  refreshState();
}

// --- Boot ---

loadWhoAmI();
refreshMessagesPreview().then(refreshState);
refreshEmployees().then(refreshContracts);
refreshRecruits();
setInterval(refreshMessagesPreview, 10000);
