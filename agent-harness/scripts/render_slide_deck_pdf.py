#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
from pathlib import Path

import markdown
from bs4 import BeautifulSoup, NavigableString, Tag
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.styles import ListStyle, ParagraphStyle, StyleSheet1, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    SimpleDocTemplate,
)


PAGE_SIZE = (13.333 * inch, 7.5 * inch)
WIDTH, HEIGHT = PAGE_SIZE

ACCENT = colors.HexColor("#F97316")
INK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#475569")
LINE = colors.HexColor("#CBD5E1")
SOFT = colors.HexColor("#F8FAFC")
SOFT_ALT = colors.HexColor("#E2E8F0")
PAGE_BG = colors.HexColor("#FFFDF8")
ACCENT_SOFT = colors.HexColor("#FFEDD5")


def register_fonts() -> None:
    fonts = {
        "InvestorSans": "/System/Library/Fonts/Supplemental/Arial.ttf",
        "InvestorSans-Bold": "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "InvestorSans-Italic": "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
        "InvestorSans-BoldItalic": "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
        "InvestorSerif": "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "InvestorSerif-Bold": "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "InvestorCode": "/System/Library/Fonts/Supplemental/Courier New.ttf",
    }
    for name, path in fonts.items():
        if Path(path).exists():
            pdfmetrics.registerFont(TTFont(name, path))

    pdfmetrics.registerFontFamily(
        "InvestorSans",
        normal="InvestorSans",
        bold="InvestorSans-Bold",
        italic="InvestorSans-Italic",
        boldItalic="InvestorSans-BoldItalic",
    )


def build_styles() -> StyleSheet1:
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="SlideEyebrow",
            parent=styles["BodyText"],
            fontName="InvestorSans-Bold",
            fontSize=9,
            leading=11,
            textColor=ACCENT,
            alignment=TA_LEFT,
            spaceAfter=12,
            uppercase=True,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideTitle",
            parent=styles["Heading1"],
            fontName="InvestorSerif-Bold",
            fontSize=24,
            leading=28,
            textColor=INK,
            alignment=TA_LEFT,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideHeadline",
            parent=styles["Heading2"],
            fontName="InvestorSans-Bold",
            fontSize=14,
            leading=18,
            textColor=MUTED,
            alignment=TA_LEFT,
            spaceAfter=14,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideTitleCover",
            parent=styles["Heading1"],
            fontName="InvestorSerif-Bold",
            fontSize=30,
            leading=34,
            textColor=INK,
            alignment=TA_LEFT,
            spaceAfter=10,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideHeadlineCover",
            parent=styles["Heading2"],
            fontName="InvestorSans-Bold",
            fontSize=15,
            leading=19,
            textColor=MUTED,
            alignment=TA_LEFT,
            spaceAfter=16,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideBody",
            parent=styles["BodyText"],
            fontName="InvestorSans",
            fontSize=11.5,
            leading=15,
            textColor=INK,
            alignment=TA_LEFT,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideTableCell",
            parent=styles["BodyText"],
            fontName="InvestorSans",
            fontSize=9.2,
            leading=11.5,
            textColor=INK,
            alignment=TA_LEFT,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideTableHeader",
            parent=styles["BodyText"],
            fontName="InvestorSans-Bold",
            fontSize=9.2,
            leading=11.5,
            textColor=INK,
            alignment=TA_LEFT,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideFooter",
            parent=styles["BodyText"],
            fontName="InvestorSans",
            fontSize=8,
            leading=10,
            textColor=MUTED,
            alignment=TA_CENTER,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SlideBodyCover",
            parent=styles["BodyText"],
            fontName="InvestorSans",
            fontSize=12.5,
            leading=16.5,
            textColor=INK,
            alignment=TA_LEFT,
            spaceAfter=7,
        )
    )
    return styles


def clean_text(text: str) -> str:
    return html.escape(text, quote=True)


def inline_markup(node: Tag | NavigableString) -> str:
    if isinstance(node, NavigableString):
        return clean_text(str(node))

    children = "".join(inline_markup(child) for child in node.children)
    name = node.name.lower()

    if name in {"strong", "b"}:
        return f"<b>{children}</b>"
    if name in {"em", "i"}:
        return f"<i>{children}</i>"
    if name == "code":
        return f'<font name="InvestorCode">{children}</font>'
    if name == "a":
        href = clean_text(node.get("href", ""))
        return f'<link href="{href}" color="{ACCENT}">{children}</link>'
    if name == "br":
        return "<br/>"
    return children


def para_from_tag(tag: Tag, style: ParagraphStyle) -> Paragraph:
    markup = "".join(inline_markup(child) for child in tag.children).strip()
    return Paragraph(markup or "&nbsp;", style)


def build_table(tag: Tag, width: float, styles: StyleSheet1) -> Table:
    rows: list[list[Paragraph]] = []
    for tr in tag.find_all("tr"):
        cells = tr.find_all(["th", "td"])
        if not cells:
            continue
        row: list[Paragraph] = []
        for cell in cells:
            cell_style = styles["SlideTableHeader"] if cell.name == "th" else styles["SlideTableCell"]
            row.append(Paragraph("".join(inline_markup(child) for child in cell.children).strip() or "&nbsp;", cell_style))
        rows.append(row)

    if not rows:
        return Table([[""]], colWidths=[width])

    ncols = max(len(row) for row in rows)
    normalized: list[list[Paragraph]] = []
    for row in rows:
        normalized.append(row + [Paragraph("&nbsp;", styles["SlideTableCell"]) for _ in range(ncols - len(row))])

    col_width = width / ncols
    table = Table(normalized, colWidths=[col_width] * ncols, repeatRows=1, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), ACCENT_SOFT),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("BACKGROUND", (0, 1), (-1, -1), colors.white),
            ]
        )
    )
    return table


def parse_slides(markdown_text: str) -> list[list[Tag]]:
    html_text = markdown.markdown(
        markdown_text,
        extensions=["tables", "fenced_code", "sane_lists"],
        output_format="html5",
    )
    soup = BeautifulSoup(f"<root>{html_text}</root>", "html.parser")
    root = soup.find("root")

    slides: list[list[Tag]] = []
    current: list[Tag] = []
    for child in root.children:
        if isinstance(child, NavigableString):
            if str(child).strip():
                p = soup.new_tag("p")
                p.string = str(child).strip()
                current.append(p)
            continue
        if not isinstance(child, Tag):
            continue
        if child.name.lower() == "hr":
            if current:
                slides.append(current)
                current = []
            continue
        current.append(child)

    if current:
        slides.append(current)
    return slides


def build_slide(slide_nodes: list[Tag], styles: StyleSheet1, slide_number: int, total: int) -> list:
    story: list = []

    title = "Agent Harness"
    headline = None
    content_nodes = slide_nodes[:]

    if content_nodes and content_nodes[0].name.lower() in {"h1", "h2"}:
        title = content_nodes.pop(0).get_text(" ", strip=True)
    if content_nodes and content_nodes[0].name.lower() in {"h2", "h3"}:
        headline = content_nodes.pop(0).get_text(" ", strip=True)

    cover = slide_number == 1
    title_style = styles["SlideTitleCover"] if cover else styles["SlideTitle"]
    headline_style = styles["SlideHeadlineCover"] if cover else styles["SlideHeadline"]
    body_style = styles["SlideBodyCover"] if cover else styles["SlideBody"]

    story.extend([Spacer(1, 0.44 * inch)])
    if cover:
        story.append(Paragraph("Investor deck | April 2026", styles["SlideEyebrow"]))
    story.append(Paragraph(title, title_style))
    if headline:
        story.append(Paragraph(headline, headline_style))
    else:
        story.append(Spacer(1, 0.08 * inch))

    body_block: list = []
    content_width = WIDTH - (0.8 * inch * 2)

    for node in content_nodes:
        name = node.name.lower()
        if name == "p":
            body_block.append(para_from_tag(node, body_style))
        elif name in {"ul", "ol"}:
            items: list[ListItem] = []
            for li in node.find_all("li", recursive=False):
                items.append(ListItem(Paragraph("".join(inline_markup(child) for child in li.children).strip(), body_style)))
            list_style = ListStyle(
                "DeckList",
                leftIndent=20,
                bulletFontName="InvestorSans-Bold",
                bulletFontSize=10,
                bulletColor=ACCENT,
            )
            bullet_type = "bullet" if name == "ul" else "1"
            if bullet_type == "bullet":
                body_block.append(ListFlowable(items, bulletType=bullet_type, style=list_style))
            else:
                body_block.append(ListFlowable(items, bulletType=bullet_type, start="1", style=list_style))
            body_block.append(Spacer(1, 0.06 * inch))
        elif name == "table":
            body_block.append(build_table(node, content_width, styles))
            body_block.append(Spacer(1, 0.08 * inch))

    story.append(KeepTogether(body_block))
    story.append(Spacer(1, 0.22 * inch))
    story.append(Paragraph(f"Slide {slide_number} of {total}", styles["SlideFooter"]))
    return story


def add_page_chrome(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFillColor(PAGE_BG)
    canvas.rect(0, 0, WIDTH, HEIGHT, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor("#FFF7ED"))
    canvas.roundRect(WIDTH - 3.1 * inch, 0.95 * inch, 2.35 * inch, 1.65 * inch, 16, stroke=0, fill=1)
    canvas.setFillColor(ACCENT)
    canvas.rect(0, HEIGHT - 0.22 * inch, WIDTH, 0.22 * inch, stroke=0, fill=1)
    canvas.setFillColor(ACCENT_SOFT)
    canvas.rect(0, HEIGHT - 0.5 * inch, 2.15 * inch, 0.08 * inch, stroke=0, fill=1)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(doc.leftMargin, 0.55 * inch, WIDTH - doc.rightMargin, 0.55 * inch)
    canvas.setFont("InvestorSans", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 0.33 * inch, "Agent Harness | Investor Deck")
    canvas.drawRightString(WIDTH - doc.rightMargin, 0.33 * inch, "Confidential")
    canvas.restoreState()


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a markdown slide deck to PDF.")
    parser.add_argument("input", help="Input markdown file")
    parser.add_argument("output", help="Output PDF file")
    args = parser.parse_args()

    register_fonts()
    styles = build_styles()

    input_path = Path(args.input)
    output_path = Path(args.output)
    markdown_text = input_path.read_text(encoding="utf-8")
    slides = parse_slides(markdown_text)

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=PAGE_SIZE,
        leftMargin=0.8 * inch,
        rightMargin=0.8 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.65 * inch,
        title=input_path.stem.replace("-", " ").title(),
        author="Codex",
    )

    story: list = []
    total = len(slides)
    for idx, slide in enumerate(slides, start=1):
        story.extend(build_slide(slide, styles, idx, total))
        if idx != total:
            story.append(PageBreak())

    doc.build(story, onFirstPage=add_page_chrome, onLaterPages=add_page_chrome)


if __name__ == "__main__":
    main()
