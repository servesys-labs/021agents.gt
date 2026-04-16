#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import re
from datetime import date
from pathlib import Path

import markdown
from bs4 import BeautifulSoup, NavigableString, Tag
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ListStyle, ParagraphStyle, StyleSheet1, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ACCENT = colors.HexColor("#F97316")
INK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#475569")
LINE = colors.HexColor("#CBD5E1")
SOFT = colors.HexColor("#F8FAFC")
SOFT_ALT = colors.HexColor("#F1F5F9")
LINK = colors.HexColor("#0F4C81")


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
            name="InvestorTitle",
            parent=styles["Title"],
            fontName="InvestorSerif-Bold",
            fontSize=24,
            leading=28,
            textColor=INK,
            alignment=TA_CENTER,
            spaceAfter=18,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorSubtitle",
            parent=styles["Normal"],
            fontName="InvestorSans",
            fontSize=11,
            leading=15,
            textColor=MUTED,
            alignment=TA_CENTER,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorBody",
            parent=styles["BodyText"],
            fontName="InvestorSans",
            fontSize=10.5,
            leading=15,
            textColor=INK,
            alignment=TA_JUSTIFY,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorH1",
            parent=styles["Heading1"],
            fontName="InvestorSerif-Bold",
            fontSize=20,
            leading=24,
            textColor=INK,
            spaceBefore=18,
            spaceAfter=10,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorH2",
            parent=styles["Heading2"],
            fontName="InvestorSans-Bold",
            fontSize=14,
            leading=18,
            textColor=INK,
            spaceBefore=16,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorH3",
            parent=styles["Heading3"],
            fontName="InvestorSans-Bold",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#1E293B"),
            spaceBefore=12,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorTableCell",
            parent=styles["Normal"],
            fontName="InvestorSans",
            fontSize=8.5,
            leading=11,
            textColor=INK,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorTableHeader",
            parent=styles["Normal"],
            fontName="InvestorSans-Bold",
            fontSize=8.5,
            leading=11,
            textColor=INK,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorQuote",
            parent=styles["BodyText"],
            fontName="InvestorSans-Italic",
            fontSize=10,
            leading=15,
            leftIndent=18,
            rightIndent=18,
            textColor=MUTED,
            spaceBefore=6,
            spaceAfter=10,
        )
    )
    styles.add(
        ParagraphStyle(
            name="InvestorMeta",
            parent=styles["BodyText"],
            fontName="InvestorSans",
            fontSize=9,
            leading=12,
            textColor=MUTED,
            alignment=TA_CENTER,
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
        return f'<font name="InvestorCode" backColor="#F1F5F9">{children}</font>'
    if name == "a":
        href = clean_text(node.get("href", ""))
        return f'<link href="{href}" color="{LINK}">{children}</link>'
    if name == "br":
        return "<br/>"
    if name in {"p", "span", "li", "th", "td"}:
        return children
    return children


def para_from_tag(tag: Tag, style: ParagraphStyle) -> Paragraph:
    markup = "".join(inline_markup(child) for child in tag.children).strip()
    return Paragraph(markup or "&nbsp;", style)


def build_table(tag: Tag, doc_width: float, styles: StyleSheet1) -> Table:
    rows: list[list[Paragraph]] = []
    for tr in tag.find_all("tr"):
        cells = tr.find_all(["th", "td"])
        if not cells:
            continue
        row: list[Paragraph] = []
        for cell in cells:
            cell_style = styles["InvestorTableHeader"] if cell.name == "th" else styles["InvestorTableCell"]
            row.append(Paragraph("".join(inline_markup(child) for child in cell.children).strip() or "&nbsp;", cell_style))
        rows.append(row)

    ncols = max(len(row) for row in rows)
    normalized: list[list[Paragraph]] = []
    for row in rows:
        padded = row + [Paragraph("&nbsp;", styles["InvestorTableCell"]) for _ in range(ncols - len(row))]
        normalized.append(padded)

    col_width = doc_width / max(ncols, 1)
    table = Table(normalized, colWidths=[col_width] * ncols, repeatRows=1, hAlign="LEFT")
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E2E8F0")),
        ("TEXTCOLOR", (0, 0), (-1, 0), INK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, LINE),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    for row_idx in range(1, len(normalized)):
        if row_idx % 2 == 0:
            style_cmds.append(("BACKGROUND", (0, row_idx), (-1, row_idx), SOFT))
    table.setStyle(TableStyle(style_cmds))
    return table


def build_story(markdown_text: str, input_name: str, styles: StyleSheet1) -> list:
    html_text = markdown.markdown(
        markdown_text,
        extensions=["tables", "fenced_code", "sane_lists"],
        output_format="html5",
    )
    soup = BeautifulSoup(f"<root>{html_text}</root>", "html.parser")
    root = soup.find("root")
    story: list = []

    first_h1 = root.find("h1")
    title = first_h1.get_text(" ", strip=True) if first_h1 else input_name

    story.extend(
        [
            Spacer(1, 1.15 * inch),
            Paragraph(title, styles["InvestorTitle"]),
            Paragraph("Investor-ready strategic memo and competitive analysis", styles["InvestorSubtitle"]),
            Spacer(1, 0.18 * inch),
            Table(
                [[
                    Paragraph(
                        (
                            "<b>Prepared from:</b> current repository review and market research<br/>"
                            f"<b>Document date:</b> {date.today().strftime('%B %d, %Y')}<br/>"
                            "<b>Audience:</b> prospective investors, advisors, and strategic partners"
                        ),
                        styles["InvestorMeta"],
                    )
                ]],
                colWidths=[6.3 * inch],
            ),
            Spacer(1, 0.22 * inch),
            HRFlowable(width="100%", thickness=1, color=ACCENT),
            Spacer(1, 0.18 * inch),
            Paragraph(
                "This report converts the repository review into an investor-facing market and positioning memo, "
                "with emphasis on category definition, pricing benchmarks, competitive differentiation, and "
                "near-term strategic priorities.",
                styles["InvestorBody"],
            ),
            Spacer(1, 0.35 * inch),
            PageBreak(),
        ]
    )

    skip_first_h1 = True
    for child in root.children:
        if isinstance(child, NavigableString):
            if not str(child).strip():
                continue
            story.append(Paragraph(clean_text(str(child).strip()), styles["InvestorBody"]))
            continue

        if not isinstance(child, Tag):
            continue

        if skip_first_h1 and child.name.lower() == "h1":
            skip_first_h1 = False
            continue

        name = child.name.lower()

        if name == "h1":
            story.append(Paragraph(child.get_text(" ", strip=True), styles["InvestorH1"]))
        elif name == "h2":
            story.append(Paragraph(child.get_text(" ", strip=True), styles["InvestorH2"]))
        elif name == "h3":
            story.append(Paragraph(child.get_text(" ", strip=True), styles["InvestorH3"]))
        elif name == "p":
            story.append(para_from_tag(child, styles["InvestorBody"]))
        elif name in {"ul", "ol"}:
            items: list[ListItem] = []
            for li in child.find_all("li", recursive=False):
                items.append(ListItem(Paragraph("".join(inline_markup(c) for c in li.children).strip(), styles["InvestorBody"])))
            list_style = ListStyle(
                "InvestorList",
                leftIndent=18,
                rightIndent=0,
                bulletFontName="InvestorSans",
                bulletFontSize=9,
                bulletColor=ACCENT,
            )
            bullet_type = "bullet" if name == "ul" else "1"
            story.append(ListFlowable(items, bulletType=bullet_type, start="1", style=list_style))
            story.append(Spacer(1, 0.08 * inch))
        elif name == "table":
            doc_width = 7.0 * inch
            story.append(build_table(child, doc_width, styles))
            story.append(Spacer(1, 0.14 * inch))
        elif name == "blockquote":
            story.append(para_from_tag(child, styles["InvestorQuote"]))
        elif name == "pre":
            code = child.get_text("\n", strip=False).rstrip()
            story.append(
                Table(
                    [[Preformatted(code, ParagraphStyle(name="InvestorCodeBlock", fontName="InvestorCode", fontSize=8, leading=10, textColor=INK))]],
                    colWidths=[7.0 * inch],
                    style=TableStyle(
                        [
                            ("BACKGROUND", (0, 0), (-1, -1), SOFT_ALT),
                            ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                            ("LEFTPADDING", (0, 0), (-1, -1), 8),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                            ("TOPPADDING", (0, 0), (-1, -1), 8),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                        ]
                    ),
                )
            )
            story.append(Spacer(1, 0.12 * inch))
        elif name == "hr":
            story.append(HRFlowable(width="100%", thickness=0.75, color=LINE))
            story.append(Spacer(1, 0.12 * inch))

    return story


def add_page_chrome(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1)
    canvas.line(doc.leftMargin, letter[1] - 0.55 * inch, letter[0] - doc.rightMargin, letter[1] - 0.55 * inch)
    canvas.setFont("InvestorSans", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 0.45 * inch, "Agent Harness | Investor Competitive Analysis")
    canvas.drawRightString(letter[0] - doc.rightMargin, 0.45 * inch, f"Page {canvas.getPageNumber()}")
    canvas.restoreState()


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a markdown report to a polished PDF.")
    parser.add_argument("input", help="Input markdown file")
    parser.add_argument("output", help="Output PDF file")
    args = parser.parse_args()

    register_fonts()
    styles = build_styles()

    input_path = Path(args.input)
    output_path = Path(args.output)
    markdown_text = input_path.read_text(encoding="utf-8")

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        leftMargin=0.72 * inch,
        rightMargin=0.72 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.65 * inch,
        title=input_path.stem.replace("-", " ").title(),
        author="Codex",
    )

    story = build_story(markdown_text, input_path.stem.replace("-", " ").title(), styles)
    doc.build(story, onFirstPage=add_page_chrome, onLaterPages=add_page_chrome)


if __name__ == "__main__":
    main()
