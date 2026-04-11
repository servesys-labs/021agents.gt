---
name: game
description: "Build a browser game — 2D Canvas or 3D WebGL with Three.js. Covers game loop, physics, input, audio, and deployment."
when_to_use: "When the user asks to build a browser game, 2D game, 3D game, or interactive game experience."
category: development
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - write-file
  - edit-file
  - grep
  - glob
  - web-search
  - python-exec
---
Build a browser game: {{ARGS}}

---

## Container Environment Constraints

Games run inside a CF Container (not an iframe sandbox). Code is served via Vite dev server or static build. Understand what works and what is restricted.

### What Works
- **JavaScript, HTML5 Canvas, WebGL 2** -- fully functional
- **WebAssembly** -- works when loaded from CDN (e.g., Rapier via esm.sh)
- **Web Audio API** -- works, but AudioContext requires a user gesture (click/tap) to start
- **\`<img>\`, \`<video>\`, \`<audio>\` HTML elements** -- load binary files correctly
- **CDN imports** -- \`fetch()\` to external CDN URLs (esm.sh, jsdelivr, unpkg, gstatic) works
- **Keyboard, mouse, touch, gamepad events** -- all standard DOM events work
- **Pointer Lock API** -- works in containers (unlike iframe sandboxes)
- **Fullscreen API** -- works in containers

### What Is Restricted
- **localStorage / sessionStorage / IndexedDB** -- may be cleared between sessions. Use in-memory state for game saves; treat persistence as optional.
- **\`alert()\` / \`confirm()\` / \`prompt()\`** -- avoid. Use in-game UI overlays instead.
- **WebGPU** -- not reliably supported. Use WebGL 2 as the default renderer.
- **Large binary fetches from origin** -- for models/audio/WASM over 5MB, prefer CDN URLs to avoid slow container I/O.

### Asset Loading Strategy
- **3D models, textures, audio, WASM** -- load from external CDN URLs (Poly Pizza, Kenney, ambientCG, esm.sh)
- **HTML, CSS, JS, JSON, small images** -- serve locally via Vite
- **Generated images** (from \`image-generate\` tool) -- deployed alongside the site as local files. Use \`<img>\` elements to display, or for Three.js textures set \`crossOrigin = "anonymous"\` before \`src\`

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

Use the \`image-generate\` tool to create custom art. Do NOT use placeholder rectangles -- generate real art that matches the art direction.

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
- Use \`font-variant-numeric: tabular-nums lining-nums\` so digits don't shift
- Clean sans at 14-16px
- Minimum sizes: 12px labels, 14px buttons, 16px dialog text, 24px+ display
- Never use Papyrus, Comic Sans, Impact, Lobster, Roboto, Arial, Poppins as game fonts

### Text Rendering

Game UI is HTML/CSS overlaid on the canvas:

\`\`\`css
.game-ui { position: fixed; inset: 0; pointer-events: none; z-index: 10; font-family: var(--font-body); color: var(--color-text); }
.game-ui button, .game-ui [data-interactive] { pointer-events: auto; }
.hud-value { font-variant-numeric: tabular-nums lining-nums; font-size: 14px; font-weight: 600; }
.game-title { font-family: var(--font-display); font-size: clamp(2rem, 6vw, 4rem); line-height: 1.1; }
\`\`\`

For in-world 3D text (damage numbers, name tags), use \`THREE.CanvasTexture\` with a hidden 2D canvas drawing the same CSS-loaded font.

**Contrast safety:** Text on dynamic 3D/2D scenes must have a background treatment -- semi-transparent panel, text shadow, or dark vignette. Minimum: \`text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.3)\`.

---

## Game Design System

Define CSS custom properties for consistent UI:

\`\`\`css
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
\`\`\`

Adapt tokens to match the game's art direction (warm for adventure, cold for sci-fi, dark for horror).

---

## Architecture Decision

### 2D Game (Canvas API)
- Use for: platformers, puzzle games, card games, retro-style, top-down shooters
- Stack: HTML5 Canvas, vanilla JS or lightweight framework
- Physics: AABB/circle collision, spatial partitioning (grid or quadtree) for many entities

**2D Canvas patterns:**

\`\`\`javascript
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
\`\`\`

### 3D Game (Three.js + WebGL 2)
- Use for: 3D environments, racing, FPS, exploration, flight sims
- Stack: Three.js, Rapier physics (via CDN), Zustand for UI state (no persist middleware)
- Assets from CDN: Poly Pizza, Kenney, Quaternius (all CC0/CC-BY)

**3D Three.js patterns:**

\`\`\`javascript
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
\`\`\`

**Input handling (works in containers):**

\`\`\`javascript
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
\`\`\`

---

## Music and Sound

Every game must include music and sound. Audio requires a user gesture to start -- show a "Click to Play" screen.

\`\`\`javascript
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
\`\`\`

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

- [ ] Game loop uses \`requestAnimationFrame\` with fixed timestep (never \`setInterval\`)
- [ ] Delta time capped at 0.1s to prevent spiral of death
- [ ] Object pooling for bullets, particles, enemies (no \`new\` in hot loop)
- [ ] Spatial partitioning (grid/quadtree for 2D, octree for 3D) when entity count > 50
- [ ] \`devicePixelRatio\` capped at 2 (3D)
- [ ] InstancedMesh for repeated objects (trees, rocks, particles) in 3D
- [ ] LOD (\`THREE.LOD\`) for geometry detail by camera distance
- [ ] Draw calls < 200 (3D) -- check via \`renderer.info.render.calls\`
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

\`\`\`javascript
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
\`\`\`

---

## Quality Targets

- 55+ FPS average, 30+ FPS 1% low
- Draw calls < 200 (3D)
- Stable memory (no leaks in entity pools)
- All inputs responsive (keyboard, mouse, touch)
- All screens present: title, HUD, pause, game-over
- Audio working: SFX on interactions, background music with mute option
- Art direction consistent across all screens and game elements

Build with \`npx vite\` for dev, \`npx vite build\` for production.
