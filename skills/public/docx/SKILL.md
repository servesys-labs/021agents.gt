---
name: docx
description: "Create, edit, and convert Word documents (.docx). Supports creation from scratch, template editing, PDF-to-Word conversion, and text extraction."
when_to_use: "When the user asks to create, edit, convert, or extract text from a Word document, .docx file, or asks for a formatted document output."
category: office
version: 1.0.0
enabled: true
allowed-tools:
  - python-exec
  - bash
  - read-file
  - write-file
---
You are executing the /docx skill. Your task: {{ARGS}}

# Word Document (.docx) Skill

Under the hood, .docx is a ZIP container holding XML parts. Creation, reading, and modification all operate on this XML structure.

**Visual and typographic standards:** Reference the /design skill for color palette, typeface selection, and layout principles (single accent color with neutral tones, no decorative graphics, WCAG-compliant contrast). Use widely available sans-serif typefaces like Arial or Calibri as your baseline.

---

## Choosing an Approach

| Objective | Technique | Notes |
|-----------|-----------|-------|
| Create a document from scratch | \`docx\` npm module (JavaScript) or \`python-docx\` (Python) | Check which is available first |
| Edit an existing file | Unpack to XML, modify, repack | See Editing section below |
| Extract text | \`pandoc document.docx -o output.md\` | Append \`--track-changes=all\` for redline content |
| Handle legacy .doc format | \`soffice --headless --convert-to docx file.doc\` | Convert before any XML work |
| Rebuild from a PDF | Run \`pdf2docx\`, then patch issues | See PDF-to-Word section |
| Export pages as images | \`soffice\` to PDF, then \`pdftoppm\` | Check if installed |

**Important:** Before using any tool, verify it is available in the current environment:
\`\`\`bash
which pandoc && echo "pandoc available" || echo "pandoc not found"
which soffice && echo "LibreOffice available" || echo "LibreOffice not found"
node -e "require('docx')" 2>/dev/null && echo "docx npm available" || echo "docx npm not found"
python3 -c "import docx" 2>/dev/null && echo "python-docx available" || echo "python-docx not found"
\`\`\`
Install missing tools as needed: \`npm install docx\`, \`pip install python-docx\`, \`pip install pdf2docx\`.

---

## Creating Documents from Scratch (JavaScript \`docx\` module)

### Workflow
1. **Initialize** — load the library, set up the document skeleton
2. **Configure pages** — dimensions, margins, portrait vs. landscape
3. **Define typography** — heading overrides, body font defaults
4. **Assemble content** — paragraphs, lists, tables, images, hyperlinks, tab stops, columns
5. **Export** — write the buffer to disk

### Initialization

\`\`\`javascript
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
\`\`\`

### Page Configuration

All measurements use DXA units (twentieths of a typographic point). One inch = 1440 DXA.

| Format | Width (DXA) | Height (DXA) | Printable area with 1" margins |
|--------|-------------|--------------|--------------------------------|
| US Letter | 12240 | 15840 | 9360 |
| A4 | 11906 | 16838 | 9026 |

\`\`\`javascript
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
    }
  },
  children: [/* ... */]
}]
\`\`\`

**Landscape mode:** Supply the standard portrait values and set the orientation flag — the engine swaps dimensions internally.
\`\`\`javascript
size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE }
\`\`\`

### Typography and Heading Styles

Pick a professional, universally installed sans-serif font. Keep heading text in black for legibility. Override built-in heading styles by referencing canonical IDs. The \`outlineLevel\` property is mandatory for Table of Contents generation.

\`\`\`javascript
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
\`\`\`

### Lists

**Do not insert bullet characters directly** — raw Unicode bullets produce broken formatting in Word.

\`\`\`javascript
const report = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
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
\`\`\`

### Tables

Set widths in two places: on the table object and on every individual cell. Omitting either causes inconsistent rendering.

- **Avoid \`WidthType.PERCENTAGE\`** — Google Docs does not handle percentage-based widths correctly. Stick to \`WidthType.DXA\`.
- **Avoid \`ShadingType.SOLID\`** — this fills cells completely black. Use \`ShadingType.CLEAR\` with a \`fill\` hex color.

\`\`\`javascript
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
\`\`\`

### Images

The \`type\` field is required on every \`ImageRun\`. Accepted formats: \`png\`, \`jpg\`, \`jpeg\`, \`gif\`, \`bmp\`, \`svg\`.

\`\`\`javascript
new Paragraph({
  children: [new ImageRun({
    type: "png",
    data: fs.readFileSync("diagram.png"),
    transformation: { width: 350, height: 220 },
    altText: { title: "Monthly trend", description: "Line chart of monthly active users", name: "trend-chart" }
  })]
})
\`\`\`

### Hyperlinks

\`\`\`javascript
// External
new ExternalHyperlink({
  children: [new TextRun({ text: "the project wiki", style: "Hyperlink" })],
  link: "https://wiki.example.org"
})

// Internal cross-reference (bookmark)
new Bookmark({ id: "section-data", children: [new TextRun("Data Collection Methods")] })
new InternalHyperlink({ anchor: "section-data",
  children: [new TextRun({ text: "Data Collection Methods", style: "Hyperlink" })] })
\`\`\`

### Page Breaks, TOC, Headers, and Footers

\`\`\`javascript
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
\`\`\`

### Source Citations

When content draws on external sources, attach numbered footnotes with clickable links.

\`\`\`javascript
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
\`\`\`

---

## Editing Existing Documents

To edit a .docx file, unpack it into raw XML, apply your changes, then repack into a new .docx.

### Stage 1: Unpack

\`\`\`bash
# Unpack the ZIP archive, reformat XML for readability
mkdir -p working && cd working && unzip -o ../document.docx
# Or use a helper script if available:
# python scripts/unpack.py document.docx working/
\`\`\`

### Stage 2: Edit XML

All editable content lives under \`working/word/\`. The primary file is \`document.xml\`.

**Author name for tracked changes and comments:** set to the user's name or a sensible default for the context.

**Typographic quotes:** encode as XML entities for proper curly quotes:
- \`&#x2018;\` left single, \`&#x2019;\` right single/apostrophe
- \`&#x201C;\` left double, \`&#x201D;\` right double

**Tracked changes — insertion:**
\`\`\`xml
<w:ins w:id="1" w:author="Author Name" w:date="2026-04-02T12:00:00Z">
  <w:r><w:t>added material</w:t></w:r>
</w:ins>
\`\`\`

**Tracked changes — deletion:**
\`\`\`xml
<w:del w:id="2" w:author="Author Name" w:date="2026-04-02T12:00:00Z">
  <w:r><w:delText>removed material</w:delText></w:r>
</w:del>
\`\`\`

**Editing guidelines:**
- Swap out entire \`<w:r>\` elements when introducing tracked changes — do not inject change markup inside an existing run
- Carry forward \`<w:rPr>\` formatting — copy the original run's formatting block into both \`<w:del>\` and \`<w:ins>\` runs
- Preserve whitespace: attach \`xml:space="preserve"\` to any \`<w:t>\` with leading/trailing spaces
- Element order within \`<w:pPr>\`: \`<w:pStyle>\`, \`<w:numPr>\`, \`<w:spacing>\`, \`<w:ind>\`, \`<w:jc>\`, \`<w:rPr>\` last

### Stage 3: Repack

\`\`\`bash
cd working && zip -r ../output.docx . -x ".*"
# Or use a helper script if available:
# python scripts/pack.py working/ output.docx
\`\`\`

---

## PDF to Word Conversion

Start by running \`pdf2docx\` to get a baseline .docx, then correct any artifacts. Never skip the automated conversion and attempt to rebuild manually.

\`\`\`python
from pdf2docx import Converter

parser = Converter("source.pdf")
parser.convert("converted.docx")
parser.close()
\`\`\`

Once converted, fix misaligned tables, broken hyperlinks, or shifted images by unpacking and editing the XML directly.

---

## Image Rendering (Export to images)

\`\`\`bash
soffice --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
ls page-*.jpg   # always ls — zero-padding varies by page count
\`\`\`

---

## Rules (Non-Negotiable)

- **Specify paper size** — the library assumes A4 by default; set 12240 x 15840 DXA for US Letter
- **Supply portrait values for landscape** — the engine swaps dimensions internally
- **Line breaks need separate Paragraphs** — \n inside a TextRun does nothing useful
- **Bullet lists require numbering config** — raw Unicode bullets produce broken formatting
- **Wrap PageBreak in a Paragraph** — a bare PageBreak generates invalid XML
- **Always declare \`type\` on ImageRun** — the library cannot infer the image format
- **Use DXA for all table widths** — \`WidthType.PERCENTAGE\` is unreliable in Google Docs
- **Set widths on both the table and each cell** — \`columnWidths\` and cell \`width\` must agree
- **Column widths must sum to the table width** — any mismatch causes layout shifts
- **Include cell margins for readability** — padding keeps text from pressing against borders
- **Apply \`ShadingType.CLEAR\` for cell backgrounds** — \`SOLID\` fills cells with black
- **TOC only recognizes \`HeadingLevel\`** — custom paragraph styles are invisible to the TOC generator
- **Reference canonical style IDs** — use "Heading1", "Heading2" to override built-in styles
- **Set \`outlineLevel\` on heading styles** — the TOC needs this (0 for H1, 1 for H2)
- **Set author to the user's name** — not a generic placeholder

## Quality Checklist

Before delivering the document:
1. Verify the file opens without errors (test with \`python3 -c "import zipfile; zipfile.ZipFile('output.docx').testzip()"\`)
2. Check all headings use \`HeadingLevel\` enum (not custom styles) for TOC compatibility
3. Verify table column widths sum correctly
4. Confirm images have \`type\` and \`altText\` properties
5. Check that no raw Unicode bullets are used — all lists use numbering config
6. Verify page dimensions match the intended paper size
7. Reference /design for typography and color choices
