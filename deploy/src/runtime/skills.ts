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

  BUNDLED_SKILLS_BY_NAME["website"],

  BUNDLED_SKILLS_BY_NAME["game"],

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

