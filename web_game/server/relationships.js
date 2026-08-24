const STATS = ["affinity", "trust", "respect", "attraction", "fear", "rivalry"];

const DECAY_WINDOW_SECONDS = 90; // compressed real-time "unit" of neglect, for prototyping
const DECAY_PER_WINDOW = 1;
const MAX_WINDOWS_PER_TICK = 6; // caps how much a long absence can erode a relationship in one read
const DECAY_FLOOR = 15;

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// --- Sentiment: numeric relationship state -> the phrases the player actually sees ---

function sentimentPhrases(c) {
  const candidates = [];

  if (c.trust >= 60) candidates.push({ score: c.trust - 50, text: "Elle vous fait confiance." });
  if (c.trust <= 20) candidates.push({ score: 50 - c.trust, text: "Elle se méfie de vos intentions." });

  if (c.respect >= 60) candidates.push({ score: c.respect - 50, text: "Elle vous respecte professionnellement." });
  if (c.respect <= 20) candidates.push({ score: 50 - c.respect, text: "Elle doute de vos compétences." });

  if (c.attraction >= 60) candidates.push({ score: c.attraction - 50, text: "Elle semble étrangement à l'aise autour de vous." });

  if (c.fear >= 50) candidates.push({ score: c.fear - 40, text: "Elle est sur ses gardes en votre présence." });

  if (c.rivalry >= 50) candidates.push({ score: c.rivalry - 40, text: "Une tension palpable subsiste entre vous." });

  if (c.affinity <= 20 && c.trust <= 25) candidates.push({ score: 60, text: "Quelque chose semble la déranger." });
  if (c.affinity >= 70) candidates.push({ score: c.affinity - 50, text: "Elle apprécie sincèrement votre présence." });

  if (candidates.length === 0) return ["La relation reste neutre, encore à définir."];

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.text);
}

// --- Last-interaction decay: neglecting a conversation slowly costs affinity/trust ---

function applyDecay(character, now = Date.now()) {
  const lastDecayAt = new Date(character.last_decay_at || character.last_interaction_at || now).getTime();
  const elapsedSeconds = (now - lastDecayAt) / 1000;
  const windows = Math.min(MAX_WINDOWS_PER_TICK, Math.floor(elapsedSeconds / DECAY_WINDOW_SECONDS));

  if (windows <= 0) return null;

  const newAffinity = Math.max(DECAY_FLOOR, character.affinity - windows * DECAY_PER_WINDOW);
  const newTrust = Math.max(DECAY_FLOOR, character.trust - windows * DECAY_PER_WINDOW);
  const newLastDecayAt = new Date(lastDecayAt + windows * DECAY_WINDOW_SECONDS * 1000).toISOString();

  return { affinity: newAffinity, trust: newTrust, last_decay_at: newLastDecayAt, windows };
}

// --- Tone replies: the always-available lightweight interaction ---

const TONES = {
  chaleureux: { effects: { affinity: 4, attraction: 2, trust: 1 }, playerLine: "Merci pour ton travail, ça compte pour moi." },
  professionnel: { effects: { respect: 4, trust: 2 }, playerLine: "Bien reçu. On garde ça strictement pro." },
  distant: { effects: { affinity: -3, fear: 2 }, playerLine: "Note. On verra ça plus tard." },
  taquin: { effects: { attraction: 4, rivalry: 2, respect: -1 }, playerLine: "Tu es toujours aussi... intense, dis donc." },
};

const CHARACTER_REACTIONS = {
  morrigan: {
    chaleureux: "Elle vous regarde un instant de trop. \"...Ne t'attends pas à ce que ça devienne une habitude.\"",
    professionnel: "\"Enfin quelqu'un qui comprend comment ça marche ici.\"",
    distant: (c) => c.rivalry >= 40
      ? "\"Fais attention. Je note qui me prend au sérieux, et qui non.\""
      : "Elle hausse les épaules, indifférente en apparence.",
    taquin: "Un sourire en coin, calculateur. \"Tu joues à un jeu dangereux, PDG.\"",
  },
  lucy: {
    chaleureux: "\"Oh— merci. Ça fait plaisir à entendre, vraiment.\"",
    professionnel: "\"Reçu. Je m'en occupe.\"",
    distant: "Un silence bref. \"...D'accord.\"",
    taquin: "Elle rit, un peu gênée. \"Arrête un peu, sérieux.\"",
  },
  malphas: {
    chaleureux: "\"Votre gratitude est... inhabituelle. Mais notée.\"",
    professionnel: "\"Précis. J'apprécie ça.\"",
    distant: "\"Comme vous voudrez.\" Sa voix ne trahit rien.",
    taquin: (c) => c.attraction >= 40
      ? "Elle vous fixe, amusée. \"Vous devenez audacieux.\""
      : "Elle incline légèrement la tête, sans un mot.",
  },
  raven: {
    chaleureux: "\"...Merci, monsieur.\" Elle semble presque surprise.",
    professionnel: "\"Compris. Ce sera fait.\"",
    distant: "\"Bien reçu.\" Rien de plus.",
    taquin: "\"Concentrez-vous sur le travail.\" Mais elle ne semble pas fâchée.",
  },
};

function toneReaction(characterKey, tone, character) {
  const reactions = CHARACTER_REACTIONS[characterKey] || {};
  const reaction = reactions[tone];
  if (typeof reaction === "function") return reaction(character);
  return reaction || "Elle acquiesce sans un mot.";
}

// --- Event Director: generic requirement checking against flags + relationship stats ---

function requirementsMet(requirements, character, flagSet) {
  if (requirements.flags) {
    for (const flag of requirements.flags) {
      if (!flagSet.has(flag)) return false;
    }
  }
  for (const stat of STATS) {
    const minKey = `${stat}_min`;
    const maxKey = `${stat}_max`;
    if (requirements[minKey] != null && character[stat] < requirements[minKey]) return false;
    if (requirements[maxKey] != null && character[stat] > requirements[maxKey]) return false;
  }
  return true;
}

module.exports = {
  STATS,
  clamp,
  sentimentPhrases,
  applyDecay,
  TONES,
  toneReaction,
  requirementsMet,
};
