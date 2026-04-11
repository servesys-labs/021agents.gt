---
name: website
description: "Build a complete website or web app — design, code, and test. Covers landing pages, portfolios, web apps, and browser games."
when_to_use: "When the user asks to build a website, web app, landing page, portfolio site, or any web-based project."
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
Build a website: {{ARGS}}

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

Run `git init` in the project directory after scaffolding. Commit after each major milestone.

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
- Run `npx vite build` to verify clean production build
- Serve locally with `npx vite preview` or deploy via bash (e.g., `npx wrangler pages deploy dist`, `npx netlify deploy --prod`, or similar)

## Use Every Tool

- **Research first.** Search the web for reference sites, trends, and competitor examples before designing. Browse award-winning examples of the specific site type. Fetch any URLs the user provides.
- **Generate real assets — generously.** Generate images for heroes, section illustrations, editorial visuals, atmospheric backgrounds — not just one hero image. Every long page should have visual rhythm. No placeholders. Generate a custom SVG logo for every project (see below).
- **Screenshot for QA.** For multi-page sites and web apps, take screenshots at desktop (1280px+) and mobile (375px) to verify quality. Skip for simple single-page static sites.
- **Write production code directly.** HTML, CSS, JS, SVG. Use bash for build tools and file processing.

## SVG Logo Generation

Every project gets a custom inline SVG logo. Never substitute a styled text heading.

1. **Understand the brand** — purpose, tone, one defining word
2. **Write SVG directly** — geometric shapes, letterforms, or abstract marks. One memorable shape.
3. **Principles:** Geometric/minimal. Works at 24px and 200px. Monochrome first — add color as enhancement. Use `currentColor` for dark/light mode.
4. **Implement inline** with `aria-label`, `viewBox`, `fill="none"`, `currentColor` strokes
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
- Visual foundations (color, type, charts): reference the /design skill
