---
name: pdf
description: "Create, read, extract, or fill PDF documents. Supports text extraction, table extraction, PDF generation, and form filling."
when_to_use: "When the user asks to create, read, extract text from, merge, split, fill forms in, or convert a PDF document."
category: office
version: 1.0.0
enabled: true
min_plan: standard
delegate_agent: pdf-specialist
allowed-tools:
  - python-exec
  - bash
  - read-file
  - write-file
---
PDF task: {{ARGS}}

## When to Use Which Tool

| Task | Tool | Notes |
|------|------|-------|
| Create PDF from scratch | reportlab | `pip install reportlab` — primary creation tool |
| Read / merge / split / rotate / encrypt | pypdf | `pip install pypdf` |
| Extract text and tables | pdfplumber | `pip install pdfplumber` — best for structured extraction |
| Render pages to images | pypdfium2 | `pip install pypdfium2` |
| OCR scanned PDFs | pytesseract + pdf2image | `pip install pytesseract pdf2image` — convert to images, then OCR |
| Fill PDF forms | pypdf | Read field names first, then set values |
| CLI merge/split/encrypt/repair | qpdf | **Check availability first:** run `which qpdf` — may not be installed in sandbox |
| CLI text extraction | pdftotext | **Check availability first:** run `which pdftotext` — may not be installed |
| CLI image extraction | pdfimages | **Check availability first:** run `which pdfimages` — may not be installed |

**Form filling:** Before attempting to fill any PDF form, first extract all field names with pypdf (`reader.get_fields()`) to understand the form structure. Never guess field names.

## Design and Typography

**Design defaults:** See the /design skill for palette, fonts, PDF font pairings, chart colors, and core principles (1 accent + neutrals, no decorative imagery, accessibility).

**Typography:** PDFs embed any TTF font — use distinctive, professional fonts, not system defaults. Download from Google Fonts at runtime, register with ReportLab, and it embeds automatically. Default to a clean sans-serif (Inter, DM Sans, Work Sans). See /design skill for PDF Pairings table.

**CJK text:** Fonts like Inter and DM Sans only cover Latin glyphs. ReportLab has no automatic font fallback — unregistered scripts render as tofu. Register Noto Sans CJK for Chinese, Japanese, or Korean text.

## PDF Metadata

Always set metadata when creating PDFs:
- **Author** — set to the user's name or organization name (ask if unknown)
- **Title** — a descriptive name relevant to the document contents

Canvas API: `c.setTitle(...)`, `c.setAuthor("...")` right after creating the canvas.
SimpleDocTemplate: pass `title=...`, `author="..."` as constructor kwargs.

## Source Citations

Every PDF that includes information from web sources MUST have:
1. Numbered superscript footnote markers in body text (using `<super>` tags, never Unicode superscripts)
2. A numbered source list at the bottom of each page with clickable hyperlinked URLs

Each footnote entry must include the actual URL wrapped in an `<a href>` tag — never omit the URL or substitute a plain-text source name.

## Hyperlinks

All URLs in generated PDFs must be clickable. In ReportLab Paragraph objects, use `<a href="..." color="blue">` markup. On the canvas, use `canvas.linkURL(url, rect)`.

## Subscripts and Superscripts

**Never use Unicode subscript/superscript characters** in ReportLab PDFs. Built-in fonts lack these glyphs, rendering them as black boxes. Use `<sub>` and `<super>` XML tags in Paragraph objects. For canvas text, manually adjust font size and y-offset.

## Tips

**Text extraction:** `pdftotext` (if available) is the fastest option for plain text. Use pdfplumber when you need tables or coordinate data — don't use `pypdf.extract_text()` on large documents, it's slow.

**Image extraction:** `pdfimages` (if available) extracts embedded images directly and is much faster than rendering whole pages. Only render with pypdfium2 when you need a visual snapshot of the page layout.

**Large PDFs:** Process pages individually or in chunks rather than loading the entire document. Use `qpdf --split-pages` (if available) to break up very large files before processing.

**Encrypted PDFs:** Use `pypdf` to detect and decrypt (`reader.is_encrypted` / `reader.decrypt(pw)`). If you don't have the password, try `qpdf --password=X --decrypt`. Run `qpdf --show-encryption` to inspect what protection is applied.

**Corrupted PDFs:** Run `qpdf --check` to diagnose structural problems, then `qpdf --replace-input` to attempt repair.

**Text extraction fails:** If pdfplumber or pdftotext return empty/garbled text, the PDF is likely scanned images. Fall back to OCR:

```python
import pytesseract
from pdf2image import convert_from_path

pages = convert_from_path("scan_output.pdf", dpi=300)
ocr_text = "\n\n".join(
    f"--- Page {n} ---\n{pytesseract.image_to_string(pg)}"
    for n, pg in enumerate(pages, 1)
)
```

## Visual QA (run BEFORE sharing any PDF)
After generating the PDF, verify:
- Check page count matches expectation
- Check file size is reasonable (< 10MB for text docs)
- Extract first page text with pdfplumber to verify content rendered
- For multi-page: spot-check a middle page for layout consistency
- For forms: verify field names match expected values
