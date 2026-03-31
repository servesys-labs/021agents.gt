/**
 * Companion System — Buddy equivalent for AgentOS
 *
 * ASCII art virtual pet companion generated deterministically from user identity.
 * Sits beside the input in the TUI, animates idle, shows speech bubble reactions.
 *
 * Architecture mirrors Claude Code's Buddy:
 *   - "Bones" (deterministic, regenerated): species, rarity, eye, hat, shiny, stats
 *   - "Soul" (persistent): name, personality, hatchedAt
 *   - Bones never persist → species can be renamed without breaking saves
 *   - Generation uses seeded Mulberry32 PRNG from user hash
 */

// ── Types ───────────────────────────────────────────────────────

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export const SPECIES = [
  "duck", "goose", "blob", "cat", "dragon", "octopus", "owl", "penguin",
  "turtle", "snail", "ghost", "axolotl", "capybara", "cactus", "robot",
  "rabbit", "mushroom", "chonk",
] as const;

export type Species = typeof SPECIES[number];

export const EYES = ["·", "✦", "×", "◉", "@", "°"] as const;
export const HATS = ["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie"] as const;
export const STATS = ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"] as const;

export interface CompanionBones {
  species: Species;
  rarity: Rarity;
  eye: string;
  hat: string;
  shiny: boolean;
  stats: Record<string, number>;
}

export interface CompanionSoul {
  name: string;
  personality: string;
  hatchedAt: number;
}

export interface Companion {
  bones: CompanionBones;
  soul: CompanionSoul;
}

// ── Mulberry32 Seeded PRNG ──────────────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

// ── Generation ──────────────────────────────────────────────────

const SALT = "oneshots-companion-2026";

export function generateCompanion(userId: string): CompanionBones {
  const seed = hashString(userId + SALT);
  const rng = mulberry32(seed);

  // Rarity: common 60%, uncommon 25%, rare 10%, epic 4%, legendary 1%
  const rarityRoll = rng();
  const rarity: Rarity =
    rarityRoll < 0.01 ? "legendary" :
    rarityRoll < 0.05 ? "epic" :
    rarityRoll < 0.15 ? "rare" :
    rarityRoll < 0.40 ? "uncommon" : "common";

  const species = SPECIES[Math.floor(rng() * SPECIES.length)];
  const eye = EYES[Math.floor(rng() * EYES.length)];

  // Hats: only rare+ get special hats
  const hatPool = rarity === "common" || rarity === "uncommon"
    ? ["none"]
    : [...HATS];
  const hat = hatPool[Math.floor(rng() * hatPool.length)];

  const shiny = rng() < 0.01;

  // Stats: 1-10, rarity affects floor. One peak, one dump.
  const floor = { common: 1, uncommon: 2, rare: 3, epic: 5, legendary: 7 }[rarity];
  const rawStats: Record<string, number> = {};
  const peakStat = STATS[Math.floor(rng() * STATS.length)];
  const dumpStat = STATS[Math.floor(rng() * STATS.length)];
  for (const stat of STATS) {
    let val = floor + Math.floor(rng() * (10 - floor + 1));
    if (stat === peakStat) val = Math.min(10, val + 3);
    if (stat === dumpStat && stat !== peakStat) val = Math.max(1, val - 3);
    rawStats[stat] = val;
  }

  return { species, rarity, eye, hat, shiny, stats: rawStats };
}

export function createDefaultSoul(bones: CompanionBones): CompanionSoul {
  const personalities: Record<Rarity, string[]> = {
    common: ["cheerful", "curious", "sleepy", "hungry"],
    uncommon: ["mischievous", "studious", "dramatic", "chill"],
    rare: ["mysterious", "philosophical", "sarcastic", "poetic"],
    epic: ["ancient", "cosmic", "trickster", "sage"],
    legendary: ["eldritch", "omniscient", "chaotic neutral", "transcendent"],
  };
  const pool = personalities[bones.rarity];
  const idx = hashString(bones.species + bones.eye) % pool.length;

  return {
    name: `${bones.species.charAt(0).toUpperCase() + bones.species.slice(1)}`,
    personality: pool[idx],
    hatchedAt: Date.now(),
  };
}

// ── Sprites ─────────────────────────────────────────────────────
// 5 lines tall, ~12 chars wide. [frame0, frame1(fidget), frame2(blink)]

type SpriteFrames = [string[], string[], string[]];

const SPRITES: Record<Species, SpriteFrames> = {
  duck: [
    ["   __     ", "  (· ·)>  ", "  /| |\\   ", " / | | \\  ", "  d   b   "],
    ["   __     ", "  (· ·)>  ", " ~/| |\\   ", " / | | \\  ", "  d   b   "],
    ["   __     ", "  (- -)>  ", "  /| |\\   ", " / | | \\  ", "  d   b   "],
  ],
  goose: [
    ["    ___   ", "   (· ·)  ", "   /||\\   ", "  / || \\  ", "   w  w   "],
    ["    ___   ", "   (· ·)~ ", "   /||\\   ", "  / || \\  ", "   w  w   "],
    ["    ___   ", "   (- -)  ", "   /||\\   ", "  / || \\  ", "   w  w   "],
  ],
  blob: [
    ["  .---.   ", " ( · · )  ", " (  ^  )  ", "  '---'   ", "   ~~~    "],
    ["  .---.   ", " ( · · )  ", " (  o  )  ", "  '---'   ", "   ~~~    "],
    ["  .---.   ", " ( - - )  ", " (  ^  )  ", "  '---'   ", "   ~~~    "],
  ],
  cat: [
    ["  /\\ /\\   ", " ( · · )  ", "  ( ^ )   ", "  /| |\\   ", " (_/ \\_)  "],
    ["  /\\ /\\   ", " ( · · )  ", "  ( w )   ", "  /| |\\   ", " (_/ \\_)  "],
    ["  /\\ /\\   ", " ( - - )  ", "  ( ^ )   ", "  /| |\\   ", " (_/ \\_)  "],
  ],
  dragon: [
    ["  /\\/\\    ", " (· · )~  ", "  {===}   ", " /|   |\\  ", " _/   \\_  "],
    ["  /\\/\\    ", " (· · )~~ ", "  {===}   ", " /|   |\\  ", " _/   \\_  "],
    ["  /\\/\\    ", " (- - )~  ", "  {===}   ", " /|   |\\  ", " _/   \\_  "],
  ],
  octopus: [
    ["  .oOo.   ", " ( · · )  ", "  \\|^|/   ", " ~/|||\\~  ", " ~ ~ ~ ~  "],
    ["  .oOo.   ", " ( · · )  ", "  \\|^|/   ", " ~\\|||/~  ", "  ~ ~ ~   "],
    ["  .oOo.   ", " ( - - )  ", "  \\|^|/   ", " ~/|||\\~  ", " ~ ~ ~ ~  "],
  ],
  owl: [
    ["   {o}    ", "  (◉ ◉)   ", "  /{Y}\\   ", "  || ||   ", "  \\/ \\/   "],
    ["   {o}    ", "  (◉ ◉)?  ", "  /{Y}\\   ", "  || ||   ", "  \\/ \\/   "],
    ["   {o}    ", "  (- -)   ", "  /{Y}\\   ", "  || ||   ", "  \\/ \\/   "],
  ],
  penguin: [
    ["   .--.   ", "  (· · )  ", "  /####\\  ", " |#    #| ", "  \\_/\\_/  "],
    ["   .--.   ", "  (· · )> ", "  /####\\  ", " |#    #| ", "  \\_/\\_/  "],
    ["   .--.   ", "  (- - )  ", "  /####\\  ", " |#    #| ", "  \\_/\\_/  "],
  ],
  turtle: [
    ["   ___    ", "  (· ·)   ", " _/===\\_  ", "|_______| ", " d     b  "],
    ["   ___    ", "  (· ·).  ", " _/===\\_  ", "|_______| ", "  d     b "],
    ["   ___    ", "  (- -)   ", " _/===\\_  ", "|_______| ", " d     b  "],
  ],
  snail: [
    ["    @     ", "   /· ·   ", "  /__O    ", " /======\\ ", " ~~~~~~~~ "],
    ["    @     ", "   /· ·   ", "  /__O    ", " /======\\ ", "  ~~~~~~~~"],
    ["    @     ", "   /- -   ", "  /__O    ", " /======\\ ", " ~~~~~~~~ "],
  ],
  ghost: [
    ["  .---.   ", " ( · · )  ", " |  O  |  ", " |     |  ", " /\\/\\/\\/  "],
    ["  .---.   ", " ( · · )  ", " |  o  |  ", " |     |  ", " /\\/\\/\\/  "],
    ["  .---.   ", " ( - - )  ", " |  O  |  ", " |     |  ", " /\\/\\/\\/  "],
  ],
  axolotl: [
    [" \\(~  ~)/ ", "  (· · )  ", "  (===)   ", "  /| |\\   ", "  ~   ~   "],
    [" \\(~  ~)/ ", "  (· · )  ", "  (===)   ", " ~/| |\\~  ", "  ~   ~   "],
    [" \\(~  ~)/ ", "  (- - )  ", "  (===)   ", "  /| |\\   ", "  ~   ~   "],
  ],
  capybara: [
    ["  .===.   ", " (· · )   ", "  (---)   ", " /|   |\\  ", " d     b  "],
    ["  .===.   ", " (· · )~  ", "  (---)   ", " /|   |\\  ", " d     b  "],
    ["  .===.   ", " (- - )   ", "  (---)   ", " /|   |\\  ", " d     b  "],
  ],
  cactus: [
    ["   |/|    ", "   (· ·)  ", "  --|--   ", "   |^|    ", "  ~~~~~   "],
    ["   |\\|    ", "   (· ·)  ", "  --|--   ", "   |^|    ", "  ~~~~~   "],
    ["   |/|    ", "   (- -)  ", "  --|--   ", "   |^|    ", "  ~~~~~   "],
  ],
  robot: [
    ["  [===]   ", "  |· ·|   ", "  |___|   ", "  /| |\\   ", "  d   b   "],
    ["  [===]   ", "  |· ·|   ", "  |===|   ", "  /| |\\   ", "  d   b   "],
    ["  [===]   ", "  |- -|   ", "  |___|   ", "  /| |\\   ", "  d   b   "],
  ],
  rabbit: [
    ["  (\\(\\    ", "  ( · ·)  ", "  o(\")(\") ", "  /| |\\   ", "  (_(_)   "],
    ["  (\\(\\    ", "  ( · ·)  ", "  o(\")(\") ", " ~/| |\\   ", "  (_(_)   "],
    ["  (\\(\\    ", "  ( - -)  ", "  o(\")(\") ", "  /| |\\   ", "  (_(_)   "],
  ],
  mushroom: [
    ["  .oOOo.  ", " /· · · \\ ", " |______|  ", "   |  |   ", "   |__|   "],
    ["  .oOOo.  ", " /· · · \\ ", " |______| ", "   |  |   ", "   |~~|   "],
    ["  .oOOo.  ", " /- - - \\ ", " |______|  ", "   |  |   ", "   |__|   "],
  ],
  chonk: [
    ["  ,===,   ", " / · · \\  ", "|  ~~~  | ", " \\_____/  ", "  d   b   "],
    ["  ,===,   ", " / · · \\  ", "|  ~~~  | ", " \\_____/  ", " d     b  "],
    ["  ,===,   ", " / - - \\  ", "|  ~~~  | ", " \\_____/  ", "  d   b   "],
  ],
};

// ── Idle Animation ──────────────────────────────────────────────
// Sequence: 0=rest, 1=fidget, -1=blink(on frame 0)
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0];

export function getIdleFrame(species: Species, tick: number): string[] {
  const seqIdx = tick % IDLE_SEQUENCE.length;
  const frameIdx = IDLE_SEQUENCE[seqIdx];
  const frames = SPRITES[species] || SPRITES.blob;

  if (frameIdx === -1) return frames[2]; // blink
  if (frameIdx === 1) return frames[1]; // fidget
  return frames[0]; // rest
}

// ── Hat Rendering ───────────────────────────────────────────────

const HAT_ART: Record<string, string> = {
  none: "          ",
  crown: "   ♛      ",
  tophat: "   ▄▀▀▄   ",
  propeller: "    ⌖     ",
  halo: "    ◯     ",
  wizard: "   ▲      ",
  beanie: "   ◠◡◠    ",
};

export function renderCompanion(bones: CompanionBones, tick: number): string[] {
  const frame = getIdleFrame(bones.species, tick);
  const hatLine = bones.hat !== "none" ? HAT_ART[bones.hat] || "" : "";

  // Replace eye placeholders with actual eyes
  const rendered = frame.map(line =>
    line.replace(/·/g, bones.eye).replace(/◉/g, bones.eye)
  );

  if (hatLine) {
    return [hatLine, ...rendered];
  }
  return rendered;
}

// ── Speech Bubbles ──────────────────────────────────────────────

const REACTIONS = {
  tool_success: [
    "Nice one!",
    "That worked!",
    "Smooth.",
    "Clean execution.",
    "*approving nod*",
  ],
  tool_error: [
    "Oof.",
    "That didn't go well...",
    "Try again?",
    "*winces*",
    "Happens to the best of us.",
  ],
  thinking: [
    "Hmm...",
    "*watches intently*",
    "This is interesting...",
    "I wonder...",
    "*leans in*",
  ],
  idle: [
    "*yawns*",
    "...",
    "*looks around*",
    "It's quiet here.",
    "*stretches*",
    "Zzz...",
  ],
  greeting: [
    "Hey there!",
    "Ready to go!",
    "*waves*",
    "What's the plan?",
  ],
};

export type ReactionType = keyof typeof REACTIONS;

export function getReaction(type: ReactionType, seed?: number): string {
  const pool = REACTIONS[type];
  const idx = seed !== undefined ? seed % pool.length : Math.floor(Math.random() * pool.length);
  return pool[idx];
}

export function renderSpeechBubble(text: string, maxWidth: number = 30): string[] {
  if (!text) return [];
  const wrapped = wrapText(text, maxWidth - 4);
  const width = Math.max(...wrapped.map(l => l.length)) + 2;

  return [
    ` ${"_".repeat(width)}`,
    ...wrapped.map(l => `| ${l.padEnd(width - 2)} |`),
    ` ${"‾".repeat(width)}`,
    "  \\",
  ];
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Rarity Colors ───────────────────────────────────────────────

export const RARITY_COLORS: Record<Rarity, string> = {
  common: "white",
  uncommon: "green",
  rare: "blue",
  epic: "magenta",
  legendary: "yellow",
};

// ── Stats Display ───────────────────────────────────────────────

export function renderStats(bones: CompanionBones): string[] {
  return Object.entries(bones.stats).map(([stat, val]) => {
    const bar = "█".repeat(val) + "░".repeat(10 - val);
    return `  ${stat.padEnd(10)} [${bar}] ${val}`;
  });
}

export function renderCompanionCard(companion: Companion): string[] {
  const { bones, soul } = companion;
  const shinyTag = bones.shiny ? " ✨ SHINY" : "";
  return [
    `╔══════════════════════════════╗`,
    `║  ${soul.name.padEnd(20)} ${bones.rarity.toUpperCase().padStart(6)}${shinyTag.padStart(bones.shiny ? 8 : 0)} ║`,
    `║  Species: ${bones.species.padEnd(18)} ║`,
    `║  Personality: ${soul.personality.padEnd(14)} ║`,
    `║  Hat: ${bones.hat.padEnd(22)} ║`,
    `╠══════════════════════════════╣`,
    ...renderStats(bones).map(l => `║${l.padEnd(30)}║`),
    `╚══════════════════════════════╝`,
  ];
}
