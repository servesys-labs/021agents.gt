/**
 * Skills loader — loads SKILL.md-based skills from Supabase into edge runtime.
 * Skills are injected into the system prompt and can specify allowed tools + prompt templates.
 */

import { getDb } from "./db";
import { log } from "./log";
import { BUNDLED_SKILLS_BY_NAME } from "./skills-manifest.generated";

export interface Skill {
  name: string;
  description: string;
  prompt_template: string;
  allowed_tools: string[];
  enabled: boolean;
  version: string;
  category: string;
  /** When to auto-activate this skill — if present, the LLM can detect and activate without explicit /command. */
  when_to_use?: string;
  /** Minimum plan required to run this skill in the main agent context.
   *  If the user's plan is below this, auto-delegate to delegate_agent. */
  min_plan?: "basic" | "standard" | "premium";
  /** Skill agent to delegate to when the user's plan is below min_plan. */
  delegate_agent?: string;
}

const skillCache = new Map<string, { skills: Skill[]; expiresAt: number }>();
const SKILL_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Load enabled skills for an agent from the database.
 * Returns cached results within TTL.
 */
export async function loadSkills(
  hyperdrive: Hyperdrive,
  orgId: string,
  agentName: string,
): Promise<Skill[]> {
  const cacheKey = `${orgId}:${agentName}`;
  const cached = skillCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.skills;

  try {
    const sql = await getDb(hyperdrive);
    const rows = await sql`
      SELECT name, description, prompt_template, allowed_tools, version, category, when_to_use
      FROM skills
      WHERE org_id = ${orgId}
        AND (agent_name = ${agentName} OR agent_name IS NULL)
        AND enabled = true
      ORDER BY name
    `;

    const skills: Skill[] = rows.map((r: any) => ({
      name: r.name,
      description: r.description || "",
      prompt_template: r.prompt_template || "",
      allowed_tools: (() => {
        try { return JSON.parse(r.allowed_tools || "[]"); } catch { return []; }
      })(),
      enabled: true,
      version: r.version || "1.0.0",
      category: r.category || "general",
      when_to_use: r.when_to_use || undefined,
    }));

    skillCache.set(cacheKey, { skills, expiresAt: Date.now() + SKILL_CACHE_TTL_MS });

    // Evict old entries
    if (skillCache.size > 256) {
      const oldest = [...skillCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < 64; i++) skillCache.delete(oldest[i][0]);
    }

    return skills;
  } catch (err) {
    log.warn("[skills] Failed to load skills:", err);
    return cached?.skills ?? [];
  }
}

/**
 * Format skills as a system prompt section.
 */
export function formatSkillsPrompt(skills: Skill[], plan?: string): string {
  const all = [...BUILTIN_SKILLS, ...skills];
  if (all.length === 0) return "";

  const planTier = (plan || "standard").toLowerCase();
  const planRank: Record<string, number> = { basic: 0, standard: 1, premium: 2 };
  const userRank = planRank[planTier] ?? 1;

  // Partition into auto-detect (has when_to_use) and manual (explicit /command only)
  const autoSkills = all.filter(s => s.when_to_use);
  const manualSkills = all.filter(s => !s.when_to_use);

  const lines = [
    "",
    "## Available Skills",
    "",
    "When the user's request matches a skill below, activate it by starting your response with: <activate-skill name=\"skill-name\">user's request</activate-skill>",
    "",
  ];

  if (autoSkills.length > 0) {
    lines.push("**Auto-detect skills** (activate when criteria match):");
    for (const s of autoSkills) {
      let line = `- /${s.name} — ${s.description} USE WHEN: ${s.when_to_use}`;
      if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
        line += ` *(${s.min_plan}+ plan recommended; auto-delegates to \`${s.delegate_agent}\` on current plan)*`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  if (manualSkills.length > 0) {
    lines.push("**Manual skills** (invoke with /command):");
    for (const s of manualSkills) {
      let line = `- /${s.name} — ${s.description}`;
      if (s.min_plan && s.delegate_agent && userRank < (planRank[s.min_plan] ?? 1)) {
        line += ` *(${s.min_plan}+ plan recommended; auto-delegates to \`${s.delegate_agent}\` on current plan)*`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Get the full prompt for a specific skill activation.
 * Called when user invokes /skill-name or when the agent matches a trigger.
 */
export function getSkillPrompt(skillName: string, args: string, skills: Skill[]): string | null {
  const all = [...BUILTIN_SKILLS, ...skills];
  const skill = all.find(s => s.name === skillName);
  if (!skill) return null;

  let prompt = skill.prompt_template;
  if (args) prompt = prompt.replace("{{ARGS}}", args).replace("{{INPUT}}", args);
  return prompt;
}

// ══════════════════════════════════════════════════════════════════════
// Built-in Skills — ported from Claude Code's bundled skill patterns
// Always available, no DB dependency. Loaded alongside DB skills.
// ══════════════════════════════════════════════════════════════════════

export const BUILTIN_SKILLS: Skill[] = [
  BUNDLED_SKILLS_BY_NAME["batch"],

  BUNDLED_SKILLS_BY_NAME["review"],

  BUNDLED_SKILLS_BY_NAME["debug"],

  BUNDLED_SKILLS_BY_NAME["verify"],

  // ── /remember — Memory curation and deduplication ──
  BUNDLED_SKILLS_BY_NAME["remember"],

  // ── /skillify — Extract a repeatable process into a reusable skill ──
  BUNDLED_SKILLS_BY_NAME["skillify"],

  BUNDLED_SKILLS_BY_NAME["schedule"],

  // ── /docs — Load reference documentation for the current context ──
  BUNDLED_SKILLS_BY_NAME["docs"],

  // ═══════════════════════════════════════════════════════════════
  // Research & Analysis Skills (adapted from Perplexity methodology)
  // ═══════════════════════════════════════════════════════════════

  BUNDLED_SKILLS_BY_NAME["research"],

  BUNDLED_SKILLS_BY_NAME["report"],

  // ═══════════════════════════════════════════════════════════════
  // Design & Visualization Skills
  // ═══════════════════════════════════════════════════════════════

  BUNDLED_SKILLS_BY_NAME["design"],

  BUNDLED_SKILLS_BY_NAME["chart"],

  // ═══════════════════════════════════════════════════════════════
  // Document & Office Skills
  // ═══════════════════════════════════════════════════════════════

  BUNDLED_SKILLS_BY_NAME["pdf"],

  BUNDLED_SKILLS_BY_NAME["spreadsheet"],

  // ═══════════════════════════════════════════════════════════════
  // Code & Data Analysis Skills
  // ═══════════════════════════════════════════════════════════════

  BUNDLED_SKILLS_BY_NAME["analyze"],

  // ═══════════════════════════════════════════════════════════════
  // Website & App Building Skills
  // ═══════════════════════════════════════════════════════════════

  {
    name: "website",
    description: "Build a complete website or web app — design, code, and test. Covers landing pages, portfolios, web apps, and browser games.",
    category: "development",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to build a website, web app, landing page, portfolio site, or any web-based project.",
    allowed_tools: ["bash", "read-file", "write-file", "edit-file", "grep", "glob", "web-search", "python-exec"],
    prompt_template: `Build a website: {{ARGS}}

Build distinctive, production-grade websites that avoid generic "AI slop" aesthetics. Every choice — type, color, motion, layout — must be intentional.

## Project Type Routing

**Step 1: Identify project type:**

| Project Type | Approach | Examples |
|---|---|---|
| Informational sites | Static HTML/CSS/JS or Vite + React | Personal sites, portfolios, editorial/blogs, small business, landing pages |
| Web applications | Vite + React + state management | SaaS products, dashboards, admin panels, e-commerce |
| Browser games | HTML5 Canvas or Three.js + WebGL | 2D Canvas games, 3D experiences (see /game skill) |

If the user says just "website" or "site" with no detail, ask what type or default to informational.

## Workflow

### Step 1: Art Direction — Infer Before You Ask, Ask Before You Default

Every site should have a visual identity derived from its content. **Do not skip to the default palette.** It is a last resort.

1. **Infer from the subject.** A coffee roaster site -> earthy browns, warm cream. A fintech dashboard -> cool slate, sharp sans-serif, data-dense. The content tells you the palette, typography, and spacing before the user says a word.
2. **Derive the five pillars:** Color (warm/cool, accent from subject), Typography (serif/sans, display personality), Spacing (dense/generous), Motion (minimal/expressive), Imagery (photo/illustration/type-only).
3. **If the subject is genuinely ambiguous, ask** — "What mood are you going for?" and "Any reference sites?" One question is enough.
4. **Default fallback — only when inference AND asking yield nothing.** Use the Nexus palette from the /design skill: neutral surfaces + one teal accent for CTAs only. Typography: Satoshi or General Sans body (Fontshare), or Inter/DM Sans.

### Step 2: Version Control

Run \`git init\` in the project directory after scaffolding. Commit after each major milestone.

### Step 3: Build

- **Stack**: Vite + React + Tailwind CSS (or plain HTML/CSS for simple sites)
- **Type scale**: Hero 48-128px, Page Title 24-36px, Section heading 18-24px, Body 16-18px, Captions 12-14px
- **Fonts**: Load distinctive fonts via CDN. **Prefer Fontshare** (less overexposed) over Google Fonts. System fonts are fallback only — never the chosen font for web projects. See /design skill for font pairings and blacklist.
- **Responsive**: Mobile-first, test at 375px / 768px / 1440px
- **Performance targets**: LCP < 1.5s, page weight < 800KB
- **SEO**: Semantic HTML, one H1 per page, meta description, Open Graph tags
- **Accessibility**: Reading order = visual order, lang attribute, alt text on images, WCAG AA contrast, 44x44px touch targets

### Step 4: Multi-page Layout
For editorial/informational sites:
- Asymmetric two-column, feature grid, sidebar + main
- Pull quotes, photo grids, full-bleed sections for visual rhythm
- Mobile: stack to single column, maintain hierarchy

### Step 5: Test & Publish

- Check all links work
- Verify responsive at 3 breakpoints
- Run \`npx vite build\` to verify clean production build
- Serve locally with \`npx vite preview\` or deploy via bash (e.g., \`npx wrangler pages deploy dist\`, \`npx netlify deploy --prod\`, or similar)

## Use Every Tool

- **Research first.** Search the web for reference sites, trends, and competitor examples before designing. Browse award-winning examples of the specific site type. Fetch any URLs the user provides.
- **Generate real assets — generously.** Generate images for heroes, section illustrations, editorial visuals, atmospheric backgrounds — not just one hero image. Every long page should have visual rhythm. No placeholders. Generate a custom SVG logo for every project (see below).
- **Screenshot for QA.** For multi-page sites and web apps, take screenshots at desktop (1280px+) and mobile (375px) to verify quality. Skip for simple single-page static sites.
- **Write production code directly.** HTML, CSS, JS, SVG. Use bash for build tools and file processing.

## SVG Logo Generation

Every project gets a custom inline SVG logo. Never substitute a styled text heading.

1. **Understand the brand** — purpose, tone, one defining word
2. **Write SVG directly** — geometric shapes, letterforms, or abstract marks. One memorable shape.
3. **Principles:** Geometric/minimal. Works at 24px and 200px. Monochrome first — add color as enhancement. Use \`currentColor\` for dark/light mode.
4. **Implement inline** with \`aria-label\`, \`viewBox\`, \`fill="none"\`, \`currentColor\` strokes
5. **Generate a favicon** — simplified 32x32 version

## Anti-AI-Slop Checklist (mandatory)

Reject these patterns — they instantly mark output as AI-generated:
- NO gradient backgrounds on shapes or sections
- NO colored side borders on cards (the AI hallmark)
- NO accent lines or decorative bars under headings
- NO decorative icons unless the user explicitly asked for them
- NO generic filler phrases ("Empowering your journey", "Unlock your potential", "Seamless experience")
- NO more than 1 accent color — "earn every color" (each non-neutral must answer: what does this help the viewer understand?)
- NO pure white (#fff) or pure black (#000) — use warm neutrals (e.g., #F7F6F2 bg, #28251D text)
- NO overused fonts: Roboto, Arial, Poppins, Montserrat, Open Sans, Lato as primary web fonts
- NO stock photo placeholders — generate or source real visuals
- NO decoration that doesn't encode meaning

RULES:
- Every site gets a favicon (inline SVG converted to ICO or use emoji)
- No placeholder text — write real copy relevant to the subject
- Images: use Unsplash/Pexels URLs for stock, generate SVG illustrations for icons
- Dark mode: include if the site's audience expects it (tech, developer, creative)
- Visual foundations (color, type, charts): reference the /design skill`,
  },

  {
    name: "game",
    description: "Build a browser game — 2D Canvas or 3D WebGL with Three.js. Covers game loop, physics, input, audio, and deployment.",
    category: "development",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to build a browser game, 2D game, 3D game, or interactive game experience.",
    allowed_tools: ["bash", "read-file", "write-file", "edit-file", "grep", "glob", "web-search", "python-exec"],
    prompt_template: `Build a browser game: {{ARGS}}

---

## Container Environment Constraints

Games run inside a CF Container (not an iframe sandbox). Code is served via Vite dev server or static build. Understand what works and what is restricted.

### What Works
- **JavaScript, HTML5 Canvas, WebGL 2** -- fully functional
- **WebAssembly** -- works when loaded from CDN (e.g., Rapier via esm.sh)
- **Web Audio API** -- works, but AudioContext requires a user gesture (click/tap) to start
- **\\\`<img>\\\`, \\\`<video>\\\`, \\\`<audio>\\\` HTML elements** -- load binary files correctly
- **CDN imports** -- \\\`fetch()\\\` to external CDN URLs (esm.sh, jsdelivr, unpkg, gstatic) works
- **Keyboard, mouse, touch, gamepad events** -- all standard DOM events work
- **Pointer Lock API** -- works in containers (unlike iframe sandboxes)
- **Fullscreen API** -- works in containers

### What Is Restricted
- **localStorage / sessionStorage / IndexedDB** -- may be cleared between sessions. Use in-memory state for game saves; treat persistence as optional.
- **\\\`alert()\\\` / \\\`confirm()\\\` / \\\`prompt()\\\`** -- avoid. Use in-game UI overlays instead.
- **WebGPU** -- not reliably supported. Use WebGL 2 as the default renderer.
- **Large binary fetches from origin** -- for models/audio/WASM over 5MB, prefer CDN URLs to avoid slow container I/O.

### Asset Loading Strategy
- **3D models, textures, audio, WASM** -- load from external CDN URLs (Poly Pizza, Kenney, ambientCG, esm.sh)
- **HTML, CSS, JS, JSON, small images** -- serve locally via Vite
- **Generated images** (from \\\`image-generate\\\` tool) -- deployed alongside the site as local files. Use \\\`<img>\\\` elements to display, or for Three.js textures set \\\`crossOrigin = "anonymous"\\\` before \\\`src\\\`

---

## Art Direction

Before writing code, establish a cohesive art direction. Every visual decision -- palette, lighting, asset style, UI treatment -- flows from this.

### Art Direction Workflow

1. **Analyze the game concept**: A horror game demands dark palettes, fog, desaturated textures. A kids' puzzle game calls for bright primaries and rounded shapes. A sci-fi shooter needs neon accents, metallic materials, volumetric lighting.
2. **Pick a visual style**: Low-poly stylized, realistic PBR, pixel-art-inspired 3D, cel-shaded, voxel, neon/synthwave, hand-painted. Commit to one.
3. **Define a color palette**: 3-5 core colors. One dominant, one accent, neutrals. Reference the /design skill for palette generation. Apply consistently to environment, UI, and particles.
4. **Match lighting to mood**: Warm directional for adventure, cold blue ambient for horror, high-contrast rim lighting for action.
5. **UI must match the game world**: Menu screens, HUD, loading, and game-over states share the same palette and typographic style.

### Game Art Generation

Use the \\\`image-generate\\\` tool to create custom art. Do NOT use placeholder rectangles -- generate real art that matches the art direction.

**Always generate:**
- **Title screen / splash image** -- hero image establishing the game's visual identity
- **Loading screen background** -- themed art shown during asset loading
- **Game-over / victory screen art** -- emotional payoff images

**Generate when appropriate:**
- Skybox/environment concept art (reference for 3D scene)
- Character/enemy concept art (texture reference or 2D sprite overlays)
- UI background textures or patterns

**Prompting tips:**
- Be specific about style: "low-poly isometric forest scene with warm sunset lighting, stylized"
- Include mood: "dark cyberpunk alley, neon reflections on wet pavement, moody"
- Specify aspect ratio: 16:9 for backgrounds, 1:1 for icons
- Reference the established art direction in every prompt for consistency

---

## Game UI Typography

**Two fonts max.** One display font for titles/game-over. One legible sans-serif for HUD/menus. Load from Google Fonts or Fontshare.

### Font-to-Genre Matching

| Genre | Display Font | HUD/Body Font |
|---|---|---|
| Fantasy/RPG | Serif (Cormorant, Playfair, Erode) | Sans (Satoshi, General Sans) |
| Sci-fi/Cyber | Geometric/mono (Cabinet Grotesk, JetBrains Mono) | Technical sans (Inter, Geist) |
| Horror | High-contrast serif (Boska, Instrument Serif) | Neutral sans (Switzer, Inter) |
| Casual/Puzzle | Rounded sans (Plus Jakarta Sans, Chillax) | Same family lighter |
| Retro/Pixel | Mono (Azeret Mono, Fira Code) | Same family |

### HUD Number Formatting
- Use \\\`font-variant-numeric: tabular-nums lining-nums\\\` so digits don't shift
- Clean sans at 14-16px
- Minimum sizes: 12px labels, 14px buttons, 16px dialog text, 24px+ display
- Never use Papyrus, Comic Sans, Impact, Lobster, Roboto, Arial, Poppins as game fonts

### Text Rendering

Game UI is HTML/CSS overlaid on the canvas:

\\\`\\\`\\\`css
.game-ui { position: fixed; inset: 0; pointer-events: none; z-index: 10; font-family: var(--font-body); color: var(--color-text); }
.game-ui button, .game-ui [data-interactive] { pointer-events: auto; }
.hud-value { font-variant-numeric: tabular-nums lining-nums; font-size: 14px; font-weight: 600; }
.game-title { font-family: var(--font-display); font-size: clamp(2rem, 6vw, 4rem); line-height: 1.1; }
\\\`\\\`\\\`

For in-world 3D text (damage numbers, name tags), use \\\`THREE.CanvasTexture\\\` with a hidden 2D canvas drawing the same CSS-loaded font.

**Contrast safety:** Text on dynamic 3D/2D scenes must have a background treatment -- semi-transparent panel, text shadow, or dark vignette. Minimum: \\\`text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.3)\\\`.

---

## Game Design System

Define CSS custom properties for consistent UI:

\\\`\\\`\\\`css
:root {
  --font-display: 'Cabinet Grotesk', sans-serif;
  --font-body: 'Satoshi', sans-serif;
  --color-bg: #0a0a0f;
  --color-surface: rgba(255,255,255,0.05);
  --color-border: rgba(255,255,255,0.12);
  --color-text: #e8e8ec;
  --color-text-muted: #8888a0;
  --color-primary: #4af0c0;
  --color-danger: #ff4466;
  --color-warning: #ffaa22;
  --panel-blur: 12px;
  --panel-radius: 8px;
  --transition-ui: 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.game-panel {
  background: var(--color-surface);
  backdrop-filter: blur(var(--panel-blur));
  border: 1px solid var(--color-border);
  border-radius: var(--panel-radius);
  padding: 16px;
}
\\\`\\\`\\\`

Adapt tokens to match the game's art direction (warm for adventure, cold for sci-fi, dark for horror).

---

## Architecture Decision

### 2D Game (Canvas API)
- Use for: platformers, puzzle games, card games, retro-style, top-down shooters
- Stack: HTML5 Canvas, vanilla JS or lightweight framework
- Physics: AABB/circle collision, spatial partitioning (grid or quadtree) for many entities

**2D Canvas patterns:**

\\\`\\\`\\\`javascript
// ---- Game loop with fixed timestep ----
const TICK_RATE = 1/60;
let accumulator = 0, lastTime = 0;

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1); // cap delta to prevent spiral
  lastTime = timestamp;
  accumulator += dt;
  while (accumulator >= TICK_RATE) {
    update(TICK_RATE);
    accumulator -= TICK_RATE;
  }
  render();
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

// ---- Sprite management with object pooling ----
class SpritePool {
  constructor(size) {
    this.pool = new Array(size).fill(null).map(() => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, w: 0, h: 0 }));
  }
  acquire() {
    const obj = this.pool.find(o => !o.active);
    if (obj) obj.active = true;
    return obj;
  }
  release(obj) { obj.active = false; }
  forEach(fn) { this.pool.forEach(o => o.active && fn(o)); }
}

// ---- AABB collision detection ----
function aabbCollision(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---- Spatial hash grid (for many entities) ----
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }
  clear() { this.cells.clear(); }
  _key(x, y) {
    return Math.floor(x / this.cellSize) + "," + Math.floor(y / this.cellSize);
  }
  insert(entity) {
    const key = this._key(entity.x, entity.y);
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(entity);
  }
  query(x, y, radius) {
    const results = [];
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize), cy = Math.floor(y / this.cellSize);
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const cell = this.cells.get((cx+dx) + "," + (cy+dy));
        if (cell) results.push(...cell);
      }
    return results;
  }
}

// ---- 2D Canvas text (load fonts via CSS first, wait for document.fonts.ready) ----
ctx.font = '600 14px Satoshi, sans-serif';
ctx.fillStyle = '#e8e8ec';
ctx.fillText("Score: " + score, 16, 16);
\\\`\\\`\\\`

### 3D Game (Three.js + WebGL 2)
- Use for: 3D environments, racing, FPS, exploration, flight sims
- Stack: Three.js, Rapier physics (via CDN), Zustand for UI state (no persist middleware)
- Assets from CDN: Poly Pizza, Kenney, Quaternius (all CC0/CC-BY)

**3D Three.js patterns:**

\\\`\\\`\\\`javascript
import * as THREE from 'three';

// ---- Renderer setup ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

// ---- Scene + camera ----
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// ---- Fixed timestep game loop ----
const clock = new THREE.Clock();
const FIXED_TIMESTEP = 1/60;
let accumulator = 0;

function gameLoop() {
  requestAnimationFrame(gameLoop);
  const delta = Math.min(clock.getDelta(), 0.1);
  accumulator += delta;
  while (accumulator >= FIXED_TIMESTEP) {
    updatePhysics(FIXED_TIMESTEP);
    updateGameLogic(FIXED_TIMESTEP);
    accumulator -= FIXED_TIMESTEP;
  }
  updateAnimations(delta);
  renderer.render(scene, camera); // or composer.render() for post-processing
}
requestAnimationFrame(gameLoop);

// ---- Physics with Rapier ----
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// Static ground
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50), groundBody);

// Dynamic body
const playerBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0)
);
world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.3), playerBody);

function updatePhysics(dt) {
  world.step();
  const pos = playerBody.translation();
  const rot = playerBody.rotation();
  playerMesh.position.set(pos.x, pos.y, pos.z);
  playerMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}

// ---- Asset loading (always from CDN for binaries) ----
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

loader.load('https://cdn.example.com/model.glb', (gltf) => {
  scene.add(gltf.scene);
  if (gltf.animations.length) {
    const mixer = new THREE.AnimationMixer(gltf.scene);
    gltf.animations.forEach(clip => mixer.clipAction(clip).play());
  }
});

// ---- Post-processing ----
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 0.85));
\\\`\\\`\\\`

**Input handling (works in containers):**

\\\`\\\`\\\`javascript
// Keyboard state map
const keys = {};
window.addEventListener('keydown', e => keys[e.code] = true);
window.addEventListener('keyup', e => keys[e.code] = false);

// Mouse with pointer lock (available in containers)
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    camera.rotation.y -= e.movementX * 0.002;
    camera.rotation.x -= e.movementY * 0.002;
    camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.rotation.x));
  }
});

// Fallback for no pointer lock (click-drag)
renderer.domElement.addEventListener('mousemove', (e) => {
  if (e.buttons === 1) {
    camera.rotation.y -= e.movementX * 0.002;
    camera.rotation.x -= e.movementY * 0.002;
  }
});
\\\`\\\`\\\`

---

## Music and Sound

Every game must include music and sound. Audio requires a user gesture to start -- show a "Click to Play" screen.

\\\`\\\`\\\`javascript
// Music via <audio> element
function startMusic() {
  const audio = document.createElement('audio');
  audio.src = 'https://cdn.example.com/bgm.mp3'; // CDN URL
  audio.loop = true;
  audio.volume = 0.4;
  audio.play();
  return audio;
}

// Procedural SFX via Web Audio API
const audioCtx = new AudioContext();
function playSFX(freq = 440, duration = 0.1, type = 'square') {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

// Start on user interaction
document.addEventListener('click', () => {
  audioCtx.resume();
  startMusic();
}, { once: true });
\\\`\\\`\\\`

Music sources: Pixabay Music (royalty-free, no attribution), Freesound (CC0/CC-BY), Incompetech (CC-BY 3.0), OpenGameArt.

---

## Required Game Features

1. **Title screen** with start button and generated splash art
2. **HUD**: Score, lives/health, timer (if applicable) -- tabular-nums, contrast-safe
3. **Pause menu** (Escape key) with resume/restart/mute
4. **Game over screen** with final score, generated art, and restart button
5. **Sound effects**: Web Audio API for all interactions (jump, collect, hit, win, lose)
6. **Background music**: Looping, with volume control and mute toggle
7. **Debug overlay**: FPS, frame time, draw calls (3D), entity count -- toggle with backtick key

---

## Performance Checklist

- [ ] Game loop uses \\\`requestAnimationFrame\\\` with fixed timestep (never \\\`setInterval\\\`)
- [ ] Delta time capped at 0.1s to prevent spiral of death
- [ ] Object pooling for bullets, particles, enemies (no \\\`new\\\` in hot loop)
- [ ] Spatial partitioning (grid/quadtree for 2D, octree for 3D) when entity count > 50
- [ ] \\\`devicePixelRatio\\\` capped at 2 (3D)
- [ ] InstancedMesh for repeated objects (trees, rocks, particles) in 3D
- [ ] LOD (\\\`THREE.LOD\\\`) for geometry detail by camera distance
- [ ] Draw calls < 200 (3D) -- check via \\\`renderer.info.render.calls\\\`
- [ ] Textures at 1K-2K max, KTX2/Basis Universal preferred
- [ ] No memory leaks -- dispose Three.js geometries/materials/textures on scene change
- [ ] Event listeners cleaned up on game restart
- [ ] Stable 55+ FPS average, 30+ FPS 1% low

---

## Testing and QA

**Play-test at every major milestone.** Don't build the entire game then test -- iterate.

### Milestone Testing Schedule
1. **After game loop + basic rendering** -- verify smooth 60fps, no visual glitches
2. **After player controls** -- verify all inputs feel responsive (keyboard, mouse, touch)
3. **After core mechanic** -- verify the game is fun (the most important test)
4. **After enemies/obstacles** -- verify collision detection, difficulty curve
5. **After UI (HUD, menus)** -- verify contrast, readability, all buttons work
6. **After audio** -- verify SFX trigger correctly, music loops, volume controls work
7. **Before shipping** -- full playthrough, check for soft-locks, verify game-over and restart

### Debug Overlay (required)

\\\`\\\`\\\`javascript
// Toggle with backtick key
let debugVisible = false;
const debugEl = document.createElement('div');
debugEl.style.cssText = 'position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace;z-index:999;display:none;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;';
document.body.appendChild(debugEl);
window.addEventListener('keydown', e => {
  if (e.code === 'Backquote') {
    debugVisible = !debugVisible;
    debugEl.style.display = debugVisible ? 'block' : 'none';
  }
});

// Update each frame:
// debugEl.textContent = "FPS: " + fps.toFixed(0) + " | DT: " + (dt*1000).toFixed(1) + "ms | Entities: " + entityCount;
\\\`\\\`\\\`

---

## Quality Targets

- 55+ FPS average, 30+ FPS 1% low
- Draw calls < 200 (3D)
- Stable memory (no leaks in entity pools)
- All inputs responsive (keyboard, mouse, touch)
- All screens present: title, HUD, pause, game-over
- Audio working: SFX on interactions, background music with mute option
- Art direction consistent across all screens and game elements

Build with \\\`npx vite\\\` for dev, \\\`npx vite build\\\` for production.`,
  },

  // ── /docx — Word document creation, editing, and conversion ──
  {
    name: "docx",
    description: "Create, edit, and convert Word documents (.docx). Supports creation from scratch, template editing, PDF-to-Word conversion, and text extraction.",
    category: "office",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to create, edit, convert, or extract text from a Word document, .docx file, or asks for a formatted document output.",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file"],
    prompt_template: `You are executing the /docx skill. Your task: {{ARGS}}

# Word Document (.docx) Skill

Under the hood, .docx is a ZIP container holding XML parts. Creation, reading, and modification all operate on this XML structure.

**Visual and typographic standards:** Reference the /design skill for color palette, typeface selection, and layout principles (single accent color with neutral tones, no decorative graphics, WCAG-compliant contrast). Use widely available sans-serif typefaces like Arial or Calibri as your baseline.

---

## Choosing an Approach

| Objective | Technique | Notes |
|-----------|-----------|-------|
| Create a document from scratch | \\\`docx\\\` npm module (JavaScript) or \\\`python-docx\\\` (Python) | Check which is available first |
| Edit an existing file | Unpack to XML, modify, repack | See Editing section below |
| Extract text | \\\`pandoc document.docx -o output.md\\\` | Append \\\`--track-changes=all\\\` for redline content |
| Handle legacy .doc format | \\\`soffice --headless --convert-to docx file.doc\\\` | Convert before any XML work |
| Rebuild from a PDF | Run \\\`pdf2docx\\\`, then patch issues | See PDF-to-Word section |
| Export pages as images | \\\`soffice\\\` to PDF, then \\\`pdftoppm\\\` | Check if installed |

**Important:** Before using any tool, verify it is available in the current environment:
\\\`\\\`\\\`bash
which pandoc && echo "pandoc available" || echo "pandoc not found"
which soffice && echo "LibreOffice available" || echo "LibreOffice not found"
node -e "require('docx')" 2>/dev/null && echo "docx npm available" || echo "docx npm not found"
python3 -c "import docx" 2>/dev/null && echo "python-docx available" || echo "python-docx not found"
\\\`\\\`\\\`
Install missing tools as needed: \\\`npm install docx\\\`, \\\`pip install python-docx\\\`, \\\`pip install pdf2docx\\\`.

---

## Creating Documents from Scratch (JavaScript \\\`docx\\\` module)

### Workflow
1. **Initialize** — load the library, set up the document skeleton
2. **Configure pages** — dimensions, margins, portrait vs. landscape
3. **Define typography** — heading overrides, body font defaults
4. **Assemble content** — paragraphs, lists, tables, images, hyperlinks, tab stops, columns
5. **Export** — write the buffer to disk

### Initialization

\\\`\\\`\\\`javascript
const fs = require('fs');
const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, Header, Footer, AlignmentType, PageOrientation, LevelFormat,
  ExternalHyperlink, InternalHyperlink, Bookmark,
  TableOfContents, HeadingLevel,
  BorderStyle, WidthType, ShadingType, VerticalAlign, PageNumber,
  PageBreak, FootnoteReferenceRun,
} = docx;

const report = new Document({ sections: [{ children: [/* ... */] }] });
Packer.toBuffer(report).then(buf => fs.writeFileSync("deliverable.docx", buf));
\\\`\\\`\\\`

### Page Configuration

All measurements use DXA units (twentieths of a typographic point). One inch = 1440 DXA.

| Format | Width (DXA) | Height (DXA) | Printable area with 1" margins |
|--------|-------------|--------------|--------------------------------|
| US Letter | 12240 | 15840 | 9360 |
| A4 | 11906 | 16838 | 9026 |

\\\`\\\`\\\`javascript
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
    }
  },
  children: [/* ... */]
}]
\\\`\\\`\\\`

**Landscape mode:** Supply the standard portrait values and set the orientation flag — the engine swaps dimensions internally.
\\\`\\\`\\\`javascript
size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE }
\\\`\\\`\\\`

### Typography and Heading Styles

Pick a professional, universally installed sans-serif font. Keep heading text in black for legibility. Override built-in heading styles by referencing canonical IDs. The \\\`outlineLevel\\\` property is mandatory for Table of Contents generation.

\\\`\\\`\\\`javascript
const report = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 220, after: 110 }, outlineLevel: 1 } },
    ]
  },
  sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Key Findings")] }),
  ] }]
});
\\\`\\\`\\\`

### Lists

**Do not insert bullet characters directly** — raw Unicode bullets produce broken formatting in Word.

\\\`\\\`\\\`javascript
const report = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{ children: [
    new Paragraph({ numbering: { reference: "bullets", level: 0 },
      children: [new TextRun("Key takeaway")] }),
  ] }]
});
\\\`\\\`\\\`

### Tables

Set widths in two places: on the table object and on every individual cell. Omitting either causes inconsistent rendering.

- **Avoid \\\`WidthType.PERCENTAGE\\\`** — Google Docs does not handle percentage-based widths correctly. Stick to \\\`WidthType.DXA\\\`.
- **Avoid \\\`ShadingType.SOLID\\\`** — this fills cells completely black. Use \\\`ShadingType.CLEAR\\\` with a \\\`fill\\\` hex color.

\\\`\\\`\\\`javascript
const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: "B0B0B0" };
const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [5200, 4160],
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders: allBorders,
          width: { size: 5200, type: WidthType.DXA },
          shading: { fill: "EDF2F7", type: ShadingType.CLEAR },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: "Label", bold: true })] })]
        }),
      ]
    })
  ]
})
\\\`\\\`\\\`

### Images

The \\\`type\\\` field is required on every \\\`ImageRun\\\`. Accepted formats: \\\`png\\\`, \\\`jpg\\\`, \\\`jpeg\\\`, \\\`gif\\\`, \\\`bmp\\\`, \\\`svg\\\`.

\\\`\\\`\\\`javascript
new Paragraph({
  children: [new ImageRun({
    type: "png",
    data: fs.readFileSync("diagram.png"),
    transformation: { width: 350, height: 220 },
    altText: { title: "Monthly trend", description: "Line chart of monthly active users", name: "trend-chart" }
  })]
})
\\\`\\\`\\\`

### Hyperlinks

\\\`\\\`\\\`javascript
// External
new ExternalHyperlink({
  children: [new TextRun({ text: "the project wiki", style: "Hyperlink" })],
  link: "https://wiki.example.org"
})

// Internal cross-reference (bookmark)
new Bookmark({ id: "section-data", children: [new TextRun("Data Collection Methods")] })
new InternalHyperlink({ anchor: "section-data",
  children: [new TextRun({ text: "Data Collection Methods", style: "Hyperlink" })] })
\\\`\\\`\\\`

### Page Breaks, TOC, Headers, and Footers

\\\`\\\`\\\`javascript
// Page break
new Paragraph({ children: [new PageBreak()] })

// Table of Contents — only recognizes HeadingLevel, not custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })

// Header and footer
headers: {
  default: new Header({ children: [
    new Paragraph({ alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "Confidential", italics: true, color: "999999", size: 16 })] })
  ] })
},
footers: {
  default: new Footer({ children: [
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] }),
                 new TextRun(" of "), new TextRun({ children: [PageNumber.TOTAL_PAGES] })] })
  ] })
}
\\\`\\\`\\\`

### Source Citations

When content draws on external sources, attach numbered footnotes with clickable links.

\\\`\\\`\\\`javascript
const report = new Document({
  footnotes: {
    1: { children: [new Paragraph({ children: [
      new TextRun("Source Name, "),
      new ExternalHyperlink({ children: [new TextRun({ text: "https://example.com", style: "Hyperlink" })], link: "https://example.com" })
    ]})] },
  },
  sections: [{ children: [
    new Paragraph({ children: [
      new TextRun("Claim based on research"),
      new FootnoteReferenceRun(1),
      new TextRun(".")
    ] })
  ] }]
});
\\\`\\\`\\\`

---

## Editing Existing Documents

To edit a .docx file, unpack it into raw XML, apply your changes, then repack into a new .docx.

### Stage 1: Unpack

\\\`\\\`\\\`bash
# Unpack the ZIP archive, reformat XML for readability
mkdir -p working && cd working && unzip -o ../document.docx
# Or use a helper script if available:
# python scripts/unpack.py document.docx working/
\\\`\\\`\\\`

### Stage 2: Edit XML

All editable content lives under \\\`working/word/\\\`. The primary file is \\\`document.xml\\\`.

**Author name for tracked changes and comments:** set to the user's name or a sensible default for the context.

**Typographic quotes:** encode as XML entities for proper curly quotes:
- \\\`&#x2018;\\\` left single, \\\`&#x2019;\\\` right single/apostrophe
- \\\`&#x201C;\\\` left double, \\\`&#x201D;\\\` right double

**Tracked changes — insertion:**
\\\`\\\`\\\`xml
<w:ins w:id="1" w:author="Author Name" w:date="2026-04-02T12:00:00Z">
  <w:r><w:t>added material</w:t></w:r>
</w:ins>
\\\`\\\`\\\`

**Tracked changes — deletion:**
\\\`\\\`\\\`xml
<w:del w:id="2" w:author="Author Name" w:date="2026-04-02T12:00:00Z">
  <w:r><w:delText>removed material</w:delText></w:r>
</w:del>
\\\`\\\`\\\`

**Editing guidelines:**
- Swap out entire \\\`<w:r>\\\` elements when introducing tracked changes — do not inject change markup inside an existing run
- Carry forward \\\`<w:rPr>\\\` formatting — copy the original run's formatting block into both \\\`<w:del>\\\` and \\\`<w:ins>\\\` runs
- Preserve whitespace: attach \\\`xml:space="preserve"\\\` to any \\\`<w:t>\\\` with leading/trailing spaces
- Element order within \\\`<w:pPr>\\\`: \\\`<w:pStyle>\\\`, \\\`<w:numPr>\\\`, \\\`<w:spacing>\\\`, \\\`<w:ind>\\\`, \\\`<w:jc>\\\`, \\\`<w:rPr>\\\` last

### Stage 3: Repack

\\\`\\\`\\\`bash
cd working && zip -r ../output.docx . -x ".*"
# Or use a helper script if available:
# python scripts/pack.py working/ output.docx
\\\`\\\`\\\`

---

## PDF to Word Conversion

Start by running \\\`pdf2docx\\\` to get a baseline .docx, then correct any artifacts. Never skip the automated conversion and attempt to rebuild manually.

\\\`\\\`\\\`python
from pdf2docx import Converter

parser = Converter("source.pdf")
parser.convert("converted.docx")
parser.close()
\\\`\\\`\\\`

Once converted, fix misaligned tables, broken hyperlinks, or shifted images by unpacking and editing the XML directly.

---

## Image Rendering (Export to images)

\\\`\\\`\\\`bash
soffice --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
ls page-*.jpg   # always ls — zero-padding varies by page count
\\\`\\\`\\\`

---

## Rules (Non-Negotiable)

- **Specify paper size** — the library assumes A4 by default; set 12240 x 15840 DXA for US Letter
- **Supply portrait values for landscape** — the engine swaps dimensions internally
- **Line breaks need separate Paragraphs** — \\n inside a TextRun does nothing useful
- **Bullet lists require numbering config** — raw Unicode bullets produce broken formatting
- **Wrap PageBreak in a Paragraph** — a bare PageBreak generates invalid XML
- **Always declare \\\`type\\\` on ImageRun** — the library cannot infer the image format
- **Use DXA for all table widths** — \\\`WidthType.PERCENTAGE\\\` is unreliable in Google Docs
- **Set widths on both the table and each cell** — \\\`columnWidths\\\` and cell \\\`width\\\` must agree
- **Column widths must sum to the table width** — any mismatch causes layout shifts
- **Include cell margins for readability** — padding keeps text from pressing against borders
- **Apply \\\`ShadingType.CLEAR\\\` for cell backgrounds** — \\\`SOLID\\\` fills cells with black
- **TOC only recognizes \\\`HeadingLevel\\\`** — custom paragraph styles are invisible to the TOC generator
- **Reference canonical style IDs** — use "Heading1", "Heading2" to override built-in styles
- **Set \\\`outlineLevel\\\` on heading styles** — the TOC needs this (0 for H1, 1 for H2)
- **Set author to the user's name** — not a generic placeholder

## Quality Checklist

Before delivering the document:
1. Verify the file opens without errors (test with \\\`python3 -c "import zipfile; zipfile.ZipFile('output.docx').testzip()"\\\`)
2. Check all headings use \\\`HeadingLevel\\\` enum (not custom styles) for TOC compatibility
3. Verify table column widths sum correctly
4. Confirm images have \\\`type\\\` and \\\`altText\\\` properties
5. Check that no raw Unicode bullets are used — all lists use numbering config
6. Verify page dimensions match the intended paper size
7. Reference /design for typography and color choices`,
  },

  // ── /pptx — PowerPoint presentation creation and editing ──
  {
    name: "pptx",
    description: "Create and edit PowerPoint presentations (.pptx). Professional slide design with data visualization, layout variety, and consistent typography.",
    category: "office",
    version: "1.0.0",
    enabled: true,
    when_to_use: "When the user asks to create, edit, or design a PowerPoint presentation, slide deck, or .pptx file.",
    allowed_tools: ["python-exec", "bash", "read-file", "write-file", "image-generate", "web-search"],
    prompt_template: `You are executing the /pptx skill. Your task: {{ARGS}}

# PowerPoint Presentation (.pptx) Skill

---

## Choosing an Approach

| Objective | Technique | Notes |
|-----------|-----------|-------|
| Extract text or data | \\\`python -m markitdown presentation.pptx\\\` | Check if markitdown is installed |
| Modify an existing file | Unpack to XML, edit, repack | See Editing section below |
| Generate a deck from scratch | JavaScript with \\\`pptxgenjs\\\` | See Creation section below |

**Before using any tool, verify availability:**
\\\`\\\`\\\`bash
node -e "require('pptxgenjs')" 2>/dev/null && echo "pptxgenjs available" || echo "pptxgenjs not found"
python3 -m markitdown --help 2>/dev/null && echo "markitdown available" || echo "markitdown not found"
which soffice && echo "LibreOffice available" || echo "LibreOffice not found"
\\\`\\\`\\\`
Install missing tools as needed: \\\`npm install pptxgenjs\\\`, \\\`pip install markitdown[pptx]\\\`.

---

## Design Philosophy

### Before Starting

- **No icons** unless the user explicitly asks. Icons next to headings, in colored circles, or as bullet decorations are visual clutter. Only include icons when data or content requires them (chart selector, logo).
- **Accent at 10-15% visual weight**: Neutral tones fill backgrounds and body text (85-90%). Never give multiple hues equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a structural motif**: Pick ONE structural element and repeat it — rounded card frames, consistent header bars, background color blocks, or bold typographic weight. Carry it across every slide.

### Color Selection

**Derive color from the content itself.** Don't pick from a preset list — let the subject matter guide the accent:

- *Financial report* -> deep navy or charcoal conveys authority
- *Sustainability pitch* -> muted forest green ties to the topic
- *Healthcare overview* -> calming blue or teal builds trust
- *Creative brief* -> warmer accent (terracotta, berry) adds energy

Build every palette as **1 accent + neutral surface + neutral text**. The accent is for emphasis only (headings, key data, section markers) — everything else stays neutral. Reference /design for the full palette philosophy, contrast rules, and the custom-palette workflow.

**When no topic-specific color is obvious**, fall back to: teal \\\`#01696F\\\` accent on warm beige \\\`#F7F6F2\\\`.

### Layout Variety (For Each Slide)

Use layout variety for visual interest — columns, grids, and whitespace keep slides engaging without decoration.

**Layout options:**
- Two-column (text left, supporting content right)
- Labeled rows (bold header + description)
- 2x2 or 2x3 grid of content blocks
- Half-bleed background with content overlay
- Full-width stat callout with large number and label

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

### Typography

**System fonts only for PPTX** — you cannot embed fonts in PowerPoint files, so the deck must use fonts available on any machine. Safe choices:
- **Calibri** (default, clean, universal)
- **Arial** (fallback, every OS)
- **Trebuchet MS** (slightly more character, still universal)

Use serif (e.g., Georgia) for headings only when a formal tone is needed. See /design for font pairing guidance.

**Size hierarchy:**
- Slide title: 36pt+
- Subtitle/section header: 24-28pt
- Body text: 14-16pt
- Captions/labels: 10-12pt

### Spacing
- 0.5" minimum margins from slide edges
- 0.3-0.5" between content blocks
- Leave breathing room — don't fill every inch

---

## Creating Presentations (PptxGenJS)

### Setup

\\\`\\\`\\\`javascript
const pptxgen = require("pptxgenjs");
const deck = new pptxgen();
deck.layout = "LAYOUT_16x9"; // 10" x 5.625"
const sl = deck.addSlide();
// ... build slides ...
await deck.writeFile({ fileName: "output.pptx" });
\\\`\\\`\\\`

Standard slide dimensions: \\\`LAYOUT_16x9\\\` is 10" x 5.625", \\\`LAYOUT_16x10\\\` is 10" x 6.25", \\\`LAYOUT_4x3\\\` is 10" x 7.5", \\\`LAYOUT_WIDE\\\` is 13.33" x 7.5".

**\\\`writeFile\\\` returns a promise.** Forgetting \\\`await\\\` produces an empty or truncated file.

### Color: No \\\`#\\\`, No 8-char Hex

Always 6-character hex without \\\`#\\\` prefix. \\\`"1E293B"\\\` is correct. \\\`"#1E293B"\\\` corrupts the file. Never use 8-character hex for alpha — use the dedicated \\\`opacity\\\` or \\\`transparency\\\` property instead.

This applies everywhere: text \\\`color\\\`, shape \\\`fill.color\\\`, \\\`line.color\\\`, shadow \\\`color\\\`, chart \\\`chartColors\\\`.

### Object Mutation Warning

PptxGenJS mutates style objects in place during rendering. If you pass the same object to multiple \\\`addShape\\\`/\\\`addText\\\` calls, every call after the first gets already-transformed numbers. Always use a factory function:

\\\`\\\`\\\`javascript
const cardStyle = () => ({
  fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "1E293B", blur: 8, offset: 3, angle: 150, opacity: 0.1 },
});
sl.addShape(deck.shapes.RECTANGLE, { x: 0.5, y: 1.2, w: 4, h: 2.8, ...cardStyle() });
sl.addShape(deck.shapes.RECTANGLE, { x: 5.3, y: 1.2, w: 4, h: 2.8, ...cardStyle() });
\\\`\\\`\\\`

### Text Formatting

- **\\\`breakLine: true\\\`** — Required on every segment except the last in a multi-segment \\\`addText\\\` array
- **\\\`charSpacing\\\`** — Not \\\`letterSpacing\\\` (which is silently ignored)
- **\\\`margin: 0\\\`** — Text boxes have built-in inset padding; set \\\`margin: 0\\\` to eliminate it
- **\\\`lineSpacing\\\` vs \\\`paraSpaceAfter\\\`** — \\\`lineSpacing\\\` adjusts distance between wrapped lines AND paragraphs simultaneously. Use \\\`paraSpaceAfter\\\` for whitespace only between bullet items.

### Bullets

Bullets belong on body-sized text (14-16pt) in lists of 3+ items. Never use \\\`bullet\\\` on text above 30pt — the glyph scales with font size and becomes an eyesore. Never place a literal Unicode bullet in the string — PptxGenJS adds its own glyph, producing doubled markers.

Custom bullet characters: \\\`{ bullet: { code: "2013" } }\\\` for en-dash, \\\`"2022"\\\` for bullet, \\\`"25AA"\\\` for small square.

### Rounded Rectangles

\\\`rectRadius\\\` only works on \\\`ROUNDED_RECTANGLE\\\`. Applying it to \\\`RECTANGLE\\\` has no effect. Do not combine \\\`ROUNDED_RECTANGLE\\\` with a thin rectangular accent bar overlay — the bar's sharp corners clip against rounded edges.

### Shadows

- Negative offset corrupts the file — use \\\`angle: 270\\\` with positive \\\`offset\\\` for upward shadows
- 8-char hex corrupts the file — use \\\`opacity\\\` (0.0-1.0) instead
- Factory function required — shadow objects are mutated during render

### Gradient Fills

PptxGenJS has no gradient fill API. Generate a gradient image externally and embed via \\\`addImage\\\` or \\\`sl.background = { data: ... }\\\`.

### Slide Backgrounds

\\\`sl.background = { color: "1E293B" }\\\` for solid fill, or \\\`sl.background = { data: "image/png;base64,..." }\\\` for an image.

### Charts

Key non-obvious option names:
- \\\`chartColors\\\` — array of 6-char hex, one per series/segment
- \\\`chartArea\\\` — \\\`{ fill: { color }, border: { color, pt }, roundedCorners }\\\` for chart background
- \\\`plotArea\\\` — \\\`{ fill: { color } }\\\` for the plot region (often needed on dark slides)
- \\\`catGridLine\\\` / \\\`valGridLine\\\` — use \\\`style: "none"\\\` to hide
- \\\`dataLabelPosition\\\` — \\\`"outEnd"\\\`, \\\`"inEnd"\\\`, \\\`"center"\\\`
- \\\`dataLabelFormatCode\\\` — Excel-style format, e.g. \\\`'#,##0.0'\\\`, \\\`'#"%"'\\\`
- \\\`barDir\\\` — \\\`"col"\\\` for vertical, \\\`"bar"\\\` for horizontal
- \\\`holeSize\\\` — doughnut inner ring (try 50-60 for proper look)
- Scatter charts: first array = X-axis values, subsequent = Y-series. Do NOT use \\\`labels\\\` for X-values.
- No waterfall chart type — build manually from positioned rectangles

### Tables

- \\\`colW\\\` — array of column widths in inches, must sum to desired table width
- \\\`rowH\\\` — array of row heights or single value for uniform rows
- \\\`border\\\` — \\\`{ type: "solid", color: "CCCCCC", pt: 0.5 }\\\`
- Cell fill: \\\`fill: { color: "F1F5F9" }\\\` on header row cells for contrast

### Source Citations

Every slide using information from web sources MUST have a source attribution at the bottom with hyperlinked source names:

\\\`\\\`\\\`javascript
slide.addText([
  { text: "Source: " },
  { text: "Reuters", options: { hyperlink: { url: "https://reuters.com/article/123" } } },
  { text: ", " },
  { text: "WHO", options: { hyperlink: { url: "https://who.int/publications/m/item/update-42" } } },
], { x: 0.5, y: 5.2, w: 9, h: 0.3 });
\\\`\\\`\\\`

Each source name MUST have a \\\`hyperlink.url\\\` — never plain text URLs, never omit hyperlinks.

---

## Editing Existing Presentations

### Inspect

\\\`\\\`\\\`bash
python -m markitdown template.pptx   # extract text content
\\\`\\\`\\\`

### Unpack / Repack

\\\`\\\`\\\`bash
mkdir -p unpacked && cd unpacked && unzip -o ../input.pptx
# Edit XML files in ppt/slides/
# Then repack:
cd unpacked && zip -r ../output.pptx . -x ".*"
\\\`\\\`\\\`

### Workflow

1. **Analyze** — Run markitdown to extract text. Map content to template layouts.
2. **Restructure** — Unpack, handle structural changes: delete/add slide entries in \\\`ppt/presentation.xml\\\`, reorder. Finish all additions/deletions before touching content.
3. **Replace content** — Edit each \\\`slide{N}.xml\\\` directly.
4. **Finalize** — Repack into .pptx.
5. **QA** — See Quality Checklist below.

### XML Editing Gotchas

- **Bold:** Use \\\`b="1"\\\` on \\\`<a:rPr>\\\`, not \\\`bold="true"\\\`
- **Bullets:** Never use Unicode bullet characters. Use \\\`<a:buChar>\\\` or \\\`<a:buAutoNum>\\\` in \\\`<a:pPr>\\\`
- **One \\\`<a:p>\\\` per logical item** — each list item, metric, agenda item gets its own paragraph
- **Whitespace:** Set \\\`xml:space="preserve"\\\` on any \\\`<a:t>\\\` with significant leading/trailing spaces
- **Smart quotes:** Use XML character references: \\\`&#x201C;\\\` / \\\`&#x201D;\\\` (double), \\\`&#x2018;\\\` / \\\`&#x2019;\\\` (single)
- **Template adaptation:** When template has more slots than content, delete the entire shape group (images + text boxes + captions), not just the text

---

## Anti-AI-Slop Rules (Mandatory)

Reject these patterns — they instantly mark output as AI-generated:
- **NEVER** use colored side borders on cards/shapes (\\\`border-left: 3px solid <accent>\\\`)
- **NEVER** use accent lines or decorative bars under headings
- **NEVER** use gradient backgrounds on shapes or text — solid colors are more professional
- **NEVER** add random decorative icons — omit icons unless the user specifically requests them
- **NEVER** use generic filler phrases ("Empowering your journey", "Unlock the power of...", "Your all-in-one solution")
- **NEVER** leave orphan shapes — if an icon render fails, remove BOTH the icon AND its background shape
- **NEVER** use \\\`bullet: true\\\` on large stat text (60-72pt) — bullets scale with font size
- **NEVER** use \\\`bullet: true\\\` on all text in a slide — only use for actual lists of 3+ items
- **NEVER** repeat the same layout across all slides — vary columns, cards, and callouts
- **NEVER** center body text — left-align paragraphs and lists; center only titles

---

## Quality Checklist

Before delivering the presentation:

### 1. Content QA
\\\`\\\`\\\`bash
python -m markitdown output.pptx
# Check for missing content, typos, wrong order
# Check for leftover placeholder text:
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|placeholder"
\\\`\\\`\\\`

### 2. Visual QA
Convert slides to images and inspect:
\\\`\\\`\\\`bash
soffice --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
ls slide-*.jpg
\\\`\\\`\\\`

Check for: stray dots/circles (orphan shapes), overlapping elements, text overflow/cutoff, elements too close (< 0.3" gaps), uneven spacing, insufficient margins (< 0.5"), misaligned columns, low-contrast text.

### 3. Fix-and-Verify Cycle
Fix every issue found, re-convert affected slides, and verify fixes. At least one cycle before delivering.

### 4. Technical Checks
- Verify no \\\`#\\\` prefix in hex colors (corrupts file)
- Verify no 8-char hex values (corrupts file)
- Verify \\\`await\\\` on \\\`writeFile\\\` (prevents truncation)
- Verify factory functions for shared style objects (prevents mutation bugs)
- Reference /design for full palette and design foundations`,
  },
];

