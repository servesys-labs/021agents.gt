---
name: spreadsheet
description: "Create or analyze Excel spreadsheets with formulas, formatting, charts, and data analysis."
when_to_use: "When the user asks to create, edit, or analyze an Excel spreadsheet, .xlsx file, or asks for data in spreadsheet format with formatting."
category: office
version: 1.0.0
enabled: true
min_plan: standard
delegate_agent: data-analyst
allowed-tools:
  - python-exec
  - bash
  - read-file
  - write-file
---
Spreadsheet task: {{ARGS}}

## Tool Decision Matrix

| Goal | Library | Why |
|------|---------|-----|
| Create workbook, add formulas, cell-level formatting | openpyxl | Native Excel objects, formulas stored as strings, full styling API |
| Analyze / transform / pivot data before writing | pandas | Vectorised ops, groupby, merge, pivot_table — reshape then hand off to openpyxl |
| High-volume write with complex formatting | xlsxwriter | Streaming writes, richer conditional-format API, but CANNOT read existing files |

Default: openpyxl for creation + formatting, pandas for data wrangling. Use xlsxwriter only when you need its unique formatting features AND are creating a new file from scratch.

\`\`\`python
# Standard imports
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, numbers
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule, FormulaRule
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.worksheet.datavalidation import DataValidation
import pandas as pd
from datetime import datetime
\`\`\`

## Creation Workflow

1. **Understand requirements** — What data? How many sheets? Who is the audience? Print or screen?
2. **Design layout** — Sketch sheet structure: summary sheet first, detail sheets after. Decide column order, header rows, where charts go.
3. **Implement** — Write data and formulas. Every derived value MUST be an Excel formula, not a Python-computed constant. The spreadsheet must recalculate when inputs change.
4. **Format** — Apply number formats, fonts, colors, borders, column widths, row heights.
5. **Validate** — Check zero formula errors, print preview, data validation rules, freeze panes.

## Core Rules

1. **Zero formula errors** — every deliverable must have zero #REF!, #DIV/0!, #NAME?, #VALUE!, #NULL!, #N/A
2. **Formulas over hardcoded values** — every derived cell must be a formula, not a pasted number
3. **Never use \`data_only=True\` when saving** — opening with \`data_only=True\` replaces formula strings with cached values; use it only for reading computed results, never save afterwards
4. **openpyxl uses 1-based indexing** — row 1 / column A = (1, 1); DataFrame row N = Excel row N+1
5. **Preserve existing templates** — when modifying an existing file, study and exactly match its format, style, and conventions; never impose new formatting on files with established patterns

## Layout Standards

- Content starts at B2 (Row 1 and Column A are empty spacers)
- Column A width = 3 (gutter): \`ws.column_dimensions['A'].width = 3\`
- Row 1 height = small (spacer)
- Freeze panes below header row: \`ws.freeze_panes = f'A\${header_row + 1}'\`
- Use Excel Table objects (\`Table\` + \`TableStyleInfo\`) for structured data — provides auto-filter, banding, structured references
- Never set \`ws.auto_filter.ref\` on a range that is also an Excel Table (causes file corruption)
- For tables with >20 rows, enable auto-filter
- Pre-sort data by most meaningful dimension (rankings descending, time ascending, otherwise alphabetical)

## Cell Formatting Patterns

| Data Type | Format Code | Display Example |
|-----------|-------------|-----------------|
| Integer | \`#,##0\` | 1,234,567 |
| Decimal (1dp) | \`#,##0.0\` | 1,234.6 |
| Currency | \`$#,##0.00\` | $1,234.56 |
| Currency (millions) | \`$#,##0,,"M"\` | $1M |
| Percentage | \`0.0%\` | 12.3% |
| Date | \`YYYY-MM-DD\` | 2026-04-02 |
| Years | Format as TEXT string | "2026" not 2,026 |
| Negatives (financial) | \`$#,##0;($#,##0);"-"\` | ($1,234) |
| Valuation multiples | \`0.0"x"\` | 8.5x |

CRITICAL: Formula cells need \`number_format\` too — they display raw precision unless explicitly formatted.

\`\`\`python
# WRONG — formula displays 14.123456789
ws['C10'] = '=C7-C9'
# RIGHT — always set number_format for formula cells
ws['C10'] = '=C7-C9'
ws['C10'].number_format = '#,##0.0'
\`\`\`

### Alignment Rules
- Headers: center-aligned, bold
- Numbers: right-aligned
- Short text (status, codes): center-aligned
- Long text (descriptions): left-aligned with \`indent=1\`
- Dates: center-aligned

### Column Width
\`\`\`python
def auto_width(ws, col, min_w=12, max_w=50, pad=2):
    length = max((len(str(c.value)) for c in ws[get_column_letter(col)] if c.value), default=0)
    ws.column_dimensions[get_column_letter(col)].width = min(max(length + pad, min_w), max_w)
\`\`\`

### Standalone Text Rows (titles, notes)
Text extends into empty right-neighbour cells but is clipped if they contain content. Merge cells across content width for titles, subtitles, section headers, and disclaimers.

## Conditional Formatting

Always use rule-based conditional formatting — never loop through cells applying static PatternFill. Static fills do not update when values change and cannot be managed by the user in Excel.

### CellIsRule — threshold-based highlighting
\`\`\`python
from openpyxl.formatting.rule import CellIsRule
ws.conditional_formatting.add("C2:C100",
    CellIsRule(operator="greaterThan", formula=["0"],
              fill=PatternFill(bgColor="C6EFCE")))  # green
ws.conditional_formatting.add("C2:C100",
    CellIsRule(operator="lessThan", formula=["0"],
              fill=PatternFill(bgColor="FFC7CE")))  # red
\`\`\`

### Color Scales — heatmap effect for matrices
\`\`\`python
# Two-color: white to blue
rule = ColorScaleRule(
    start_type='min', start_color='FFFFFF',
    end_type='max', end_color='4472C4')
ws.conditional_formatting.add('D5:H20', rule)
# Three-color: red to yellow to green (performance data)
rule = ColorScaleRule(
    start_type='min', start_color='F8696B',
    mid_type='percentile', mid_value=50, mid_color='FFEB84',
    end_type='max', end_color='63BE7B')
ws.conditional_formatting.add('D5:H20', rule)
\`\`\`

### Data Bars — inline magnitude comparison
\`\`\`python
rule = DataBarRule(start_type='min', end_type='max', color='4472C4')
ws.conditional_formatting.add('C5:C50', rule)
\`\`\`

### Icon Sets — use FormulaRule with custom icons for KPI dashboards

| Feature | Best For |
|---------|----------|
| CellIsRule | Threshold highlighting (above/below target) |
| Color Scale (2-color) | Single metric distributions |
| Color Scale (3-color) | Good / neutral / bad interpretation |
| Data Bars | Quick magnitude comparison within a column |

## Chart Creation in Excel

Place charts below their data table with a 2-row gap, left-aligned with content. Charts must never overlap each other or tables.

| Chart Type | Use When |
|------------|----------|
| BarChart / BarChart3D | Comparing values across categories |
| LineChart | Time series, trends over time |
| PieChart | Part-to-whole composition (6 or fewer categories only) |
| AreaChart | Cumulative totals over time |
| ScatterChart | Correlation between two variables |

\`\`\`python
chart = BarChart()
chart.title = "Revenue by Region"
chart.style = 10
data = Reference(ws, min_col=2, min_row=header_row, max_row=last_row)
cats = Reference(ws, min_col=1, min_row=header_row + 1, max_row=last_row)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.width = 15   # centimetres
chart.height = 7.5
ws.add_chart(chart, f"B\${last_row + 3}")
\`\`\`

### Preventing chart overlap
\`\`\`python
from math import ceil
rows_for_chart = ceil(chart.height * 2)  # ~2 rows per cm at default row height
next_content_row = chart_anchor_row + rows_for_chart + 2
\`\`\`

## Formula Patterns

### Live Excel formulas — always prefer over Python-computed constants
\`\`\`python
# Totals
ws['F20'] = '=SUM(F2:F19)'
# Percentage
ws['D5'] = '=(B5-C5)/B5'
ws['D5'].number_format = '0.0%'
# YoY growth
ws[f'E\${row}'] = f'=(\${current}-\${prior})/\${prior}'
# Ranking
ws[f'G\${row}'] = f'=RANK(C\${row},$C$2:$C$100,0)'
\`\`\`

### Structured Table References (when Tables exist)
When editing an existing file with Table objects (\`ws.tables\`), use structured references:
- \`=SUM(SalesData[Revenue])\` not \`=SUM(C2:C100)\`
- \`=VLOOKUP(A2,SalesData[#All],3,FALSE)\` for lookups

### VLOOKUP equivalents in Python (for data prep before writing)
\`\`\`python
# pandas merge = VLOOKUP
result = left_df.merge(right_df[['key', 'value']], on='key', how='left')
# Pivot table via pandas — then write result to Excel
pivot = df.pivot_table(values='Revenue', index='Region', columns='Quarter', aggfunc='sum')
\`\`\`

## Multi-Sheet Design

| Principle | Rule |
|-----------|------|
| Sheet order | Summary / Overview first, then supporting detail sheets (general to specific) |
| Sheet count | 3-5 ideal, max 7 |
| Naming | Descriptive (\`Revenue Data\`, not \`Sheet1\`) |
| Consistency | Same layout patterns, same starting positions, same formatting across sheets |
| Overview | Must stand alone — user understands the main message without opening other sheets |
| Navigation | For 3+ sheets, add a sheet index on Overview with hyperlinks |

\`\`\`python
# Cross-sheet hyperlink
from openpyxl.worksheet.hyperlink import Hyperlink
cell = ws.cell(row=6, column=2, value="Revenue Data")
cell.hyperlink = Hyperlink(ref=cell.coordinate, location="'Revenue Data'!A1")
cell.font = Font(color='0000FF', underline='single')
\`\`\`

## Print Layout

\`\`\`python
# Page setup
ws.page_setup.orientation = ws.ORIENTATION_LANDSCAPE
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0  # as many pages tall as needed

# Print area
ws.print_area = f'A1:\${get_column_letter(last_col)}\${last_row}'

# Repeat header row on every printed page
ws.print_title_rows = f'1:\${header_row}'

# Headers and footers
ws.oddHeader.center.text = "Report Title"
ws.oddFooter.left.text = f"Generated: \${datetime.now().strftime('%Y-%m-%d')}"
ws.oddFooter.right.text = "Page &P of &N"

# Manual page break
from openpyxl.worksheet.pagebreak import Break
ws.row_breaks.append(Break(id=section_end_row))
\`\`\`

## Data Validation

\`\`\`python
# Dropdown list
dv = DataValidation(type="list", formula1='"Option A,Option B,Option C"', allow_blank=True)
dv.error = "Invalid selection"
dv.errorTitle = "Input Error"
dv.prompt = "Choose from the list"
dv.promptTitle = "Selection"
ws.add_data_validation(dv)
dv.add(f'D2:D\${last_row}')

# Numeric constraint (1-100)
dv_num = DataValidation(type="whole", operator="between", formula1="1", formula2="100")
dv_num.error = "Enter a number between 1 and 100"
ws.add_data_validation(dv_num)
dv_num.add(f'E2:E\${last_row}')

# Date constraint
dv_date = DataValidation(type="date", operator="greaterThan", formula1="2020-01-01")
ws.add_data_validation(dv_date)
dv_date.add(f'F2:F\${last_row}')
\`\`\`

## Performance: Large Files

### Reading large files
\`\`\`python
# openpyxl read_only mode — streams rows, low memory
wb = openpyxl.load_workbook('large.xlsx', read_only=True)
for row in ws.iter_rows(min_row=2, values_only=True):
    process(row)
wb.close()  # MUST close read_only workbooks

# pandas — read only needed columns
df = pd.read_excel('large.xlsx', usecols=['A', 'C', 'E'], dtype={'id': str})
\`\`\`

### Writing large files
\`\`\`python
# openpyxl write_only mode — streaming, never loads full sheet in memory
wb = openpyxl.Workbook(write_only=True)
ws = wb.create_sheet()
for chunk in data_chunks:
    for record in chunk:
        ws.append([record['a'], record['b'], record['c']])
wb.save('output.xlsx')
\`\`\`

Note: write_only mode does NOT support cell-level formatting, merged cells, or random access. If you need formatting, write data in write_only mode first, then reopen in normal mode to apply styles to header rows only.

## Financial Model Color Coding

| Color | Meaning |
|-------|---------|
| Blue text (#0000FF) | Hardcoded inputs / assumptions the user will change |
| Black text (#000000) | All formulas and calculations |
| Green text (#008000) | Links pulling from other worksheets in the same workbook |
| Red text (#FF0000) | External links to other files |
| Yellow background (#FFFF00) | Key assumptions needing attention |

## Common Gotchas

1. **Date serialization** — openpyxl stores Python \`datetime\` objects natively, but pandas may write dates as serial numbers. Always verify date columns render correctly; set \`number_format = 'YYYY-MM-DD'\` explicitly.
2. **Merged cells break iteration** — \`iter_rows()\` returns \`MergedCell\` objects with \`value=None\` for all but the top-left cell. Unmerge before processing data, or skip merged regions.
3. **Font availability** — Excel on the target machine must have the font installed. Stick to universally available fonts: Calibri, Arial, Times New Roman. Never assume custom fonts exist.
4. **\`data_only=True\` destroys formulas on save** — use only for reading cached values, never save.
5. **Auto-filter + Table conflict** — never set \`ws.auto_filter.ref\` on a Table range; Tables include their own filter automatically.
6. **Cell indices are 1-based** — DataFrame row 5 = Excel row 6. Off-by-one errors are the most common formula bug.
7. **String numbers** — Excel may auto-convert ZIP codes, IDs, and years to numbers. Write them as strings or set the column format to Text before writing.
8. **write_only limitations** — no cell styling, no merged cells, no random-access writes. Plan accordingly.
9. **Large formula arrays** — openpyxl does not evaluate formulas; if you need computed values for conditional logic during generation, compute in pandas first, then write the formula string for the user.

## Data Context — Every Dataset Needs Provenance

| Element | Location | Example |
|---------|----------|---------|
| Data source | Footer or notes row | "Source: Company 10-K, FY2025" |
| Time range | Subtitle near title | "Data from Jan 2023 - Dec 2025" |
| Generation date | Footer | "Generated: 2026-04-02" |
| Definitions | Notes section | "Revenue = Net sales excluding returns" |

## Quality Checklist (verify before delivering)

- [ ] **Data accuracy** — spot-check 3-5 values against source data
- [ ] **Zero formula errors** — no #REF!, #DIV/0!, #VALUE!, #N/A, #NAME?, #NULL!
- [ ] **Formatting consistency** — same number format for same data type across all sheets
- [ ] **Column widths** — no truncated text, no excessively wide empty columns
- [ ] **Print preview** — content fits page, headers repeat, no orphan rows
- [ ] **Formula validation** — test with edge cases (zero, negative, blank)
- [ ] **Cross-sheet references** — all links resolve, no broken sheet names
- [ ] **Data validation rules** — dropdowns work, constraints reject invalid input
- [ ] **Chart accuracy** — data ranges correct, labels readable, no overlapping elements
- [ ] **File opens cleanly** — open in Excel / LibreOffice to verify no corruption warnings
