const STAT_LABELS = { affinity: "Affinité", trust: "Confiance", respect: "Respect", attraction: "Attraction", fear: "Peur", rivalry: "Rivalité" };
const TONE_LABELS = { chaleureux: "Chaleureux", professionnel: "Professionnel", distant: "Distant", taquin: "Taquin" };

let currentKey = null;
let charactersCache = [];

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

function humanTimeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

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

// --- Conversation list ---

function conversationRow(c) {
  const row = el("div", "conv-row");
  row.style.setProperty("--accent", c.accent_color);
  if (c.key === currentKey) row.classList.add("active");

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = `assets/avatars/${c.avatar_file}`;
  row.appendChild(avatar);

  const info = el("div", "conv-info");
  const topRow = el("div", "conv-top-row");
  topRow.appendChild(text("span", "conv-name", c.name));
  if (c.last_message) topRow.appendChild(text("span", "conv-time", humanTimeAgo(c.last_message.created_at)));
  info.appendChild(topRow);

  if (c.last_message) {
    const prefix = c.last_message.sender === "player" ? "Toi : " : "";
    info.appendChild(text("div", "conv-preview", prefix + c.last_message.body));
  }
  info.appendChild(text("div", "conv-sentiment", c.sentiment[0] || ""));
  row.appendChild(info);

  if (c.unread > 0) row.appendChild(el("div", "unread-dot"));

  row.addEventListener("click", () => openThread(c.key));
  return row;
}

async function refreshConversationList() {
  const res = await fetch("/api/characters");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  charactersCache = await res.json();

  const list = document.getElementById("conversation-list");
  list.innerHTML = "";
  charactersCache.forEach((c) => list.appendChild(conversationRow(c)));
}

// --- Thread ---

function messageBubble(m) {
  if (m.kind === "event") {
    const card = el("div", "event-card");
    card.appendChild(text("div", "event-tag", "Événement"));
    card.appendChild(text("div", "event-body", m.body));
    return card;
  }
  const cls = m.sender === "player" ? (m.kind === "choice" ? "bubble choice" : "bubble player") : "bubble character";
  return text("div", cls, m.body);
}

function statBars(character) {
  const wrap = el("div", "thread-details");
  wrap.id = "thread-details";
  Object.keys(STAT_LABELS).forEach((stat) => {
    const row = el("div", "stat-row");
    row.appendChild(text("span", "stat-label", STAT_LABELS[stat]));
    const track = el("div", "stat-track");
    const fill = el("div", "stat-fill");
    fill.style.width = `${character[stat]}%`;
    fill.style.setProperty("--accent", character.accent_color);
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(text("span", null, character[stat]));
    wrap.appendChild(row);
  });
  return wrap;
}

async function sendTone(key, tone) {
  await fetch(`/api/characters/${key}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tone }),
  });
  await Promise.all([openThread(key), refreshConversationList()]);
}

async function sendChoice(eventId, choiceId, key) {
  await fetch(`/api/events/${eventId}/choice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choice_id: choiceId }),
  });
  await Promise.all([openThread(key), refreshConversationList()]);
}

async function openThread(key) {
  currentKey = key;
  const res = await fetch(`/api/characters/${key}/messages`);
  const data = await res.json();
  const { character, messages, events, memories } = data;

  const thread = document.getElementById("thread");
  thread.innerHTML = "";
  thread.style.setProperty("--accent", character.accent_color);

  // Header
  const header = el("div", "thread-header");
  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = `assets/avatars/${character.avatar_file}`;
  header.appendChild(avatar);

  const info = el("div", "thread-header-info");
  info.appendChild(text("div", "thread-header-name", character.name));
  info.appendChild(text("div", "thread-header-title", character.title));
  header.appendChild(info);

  const toggleBtn = text("button", "details-toggle", "Détails");
  toggleBtn.addEventListener("click", () => {
    document.getElementById("thread-details").classList.toggle("open");
  });
  header.appendChild(toggleBtn);
  thread.appendChild(header);

  thread.appendChild(statBars(character));

  const sentimentEl = el("div", "sentiment-lines");
  character.sentiment.forEach((line) => sentimentEl.appendChild(text("div", null, line)));
  thread.appendChild(sentimentEl);

  if (memories.length > 0) {
    thread.appendChild(text("div", "memories-line", `${memories.length} souvenir(s) débloqué(s) : ${memories.map((m) => m.title).join(", ")}`));
  }

  const scroll = el("div", "messages-scroll");
  messages.forEach((m) => scroll.appendChild(messageBubble(m)));
  thread.appendChild(scroll);
  scroll.scrollTop = scroll.scrollHeight;

  const pendingEvent = events.find((e) => e.status !== "completed");
  const replyBar = el("div", "reply-bar");
  if (pendingEvent) {
    replyBar.classList.add("event-choices");
    pendingEvent.choices.forEach((choice) => {
      const btn = text("button", null, choice.label);
      btn.addEventListener("click", () => sendChoice(pendingEvent.id, choice.id, key));
      replyBar.appendChild(btn);
    });
  } else {
    Object.entries(TONE_LABELS).forEach(([tone, label]) => {
      const btn = text("button", null, label);
      btn.addEventListener("click", () => sendTone(key, tone));
      replyBar.appendChild(btn);
    });
  }
  thread.appendChild(replyBar);

  document.querySelectorAll(".conv-row").forEach((row, i) => row.classList.toggle("active", charactersCache[i]?.key === key));
}

// --- Boot ---

loadWhoAmI();
refreshConversationList();
setInterval(refreshConversationList, 8000);
