// The action catalog doubles as the animation catalog: each action a schedule block can use
// carries its own little animation "style" so the client knows how to move the sprite without
// needing real per-action spritesheets (none of the character art has any).
const NPC_ACTIONS = {
  absent: { label: "Absent", style: "none" },
  idle: { label: "Présent (repos)", style: "idle", bobAmp: 3, bobHz: 0.5 },
  marcher: { label: "En déplacement", style: "walk", bobAmp: 6, bobHz: 2.2 },
  travailler: { label: "Travaille", style: "work", bobAmp: 2, bobHz: 3, tiltDeg: 2 },
  pause: { label: "En pause", style: "sit", scaleY: 0.85, emoji: "☕" },
  dormir: { label: "Dort", style: "sleep", scaleY: 0.55, emoji: "💤" },
};

module.exports = { NPC_ACTIONS };
