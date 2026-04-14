---
name: chart
description: "Generate publication-quality charts, graphs, and data visualizations using Python."
when_to_use: "When the user asks to create a chart, graph, plot, visualization, or visual representation of data."
category: visualization
version: 1.0.0
enabled: true
min_plan: standard
delegate_agent: data-analyst
allowed-tools:
  - python-exec
  - read-file
  - write-file
  - image-generate
---
Create a data visualization: {{ARGS}}

Reference the /design skill for color palettes and foundational design rules.

---

## Chart Selection Table

| What you're showing | Best chart | Alternatives |
|---------------------|-----------|-------------|
| Trend over time | Line | Area (cumulative/composition) |
| Comparison across categories | Vertical bar | Horizontal bar (many categories) |
| Ranking | Horizontal bar | Dot plot, slope chart (two periods) |
| Part-to-whole | Stacked bar | Treemap (hierarchical), waffle chart |
| Composition over time | Stacked area | 100% stacked bar (proportion focus) |
| Distribution (single var) | Histogram | Box plot (group comparison), violin, KDE |
| Distribution (group comparison) | Box plot | Violin (shape), strip/execute-code (parallel) (small N) |
| Correlation (2 vars) | Scatter | Bubble (3rd var as size), hexbin (large N) |
| Correlation (many vars) | Heatmap (correlation matrix) | Pair plot (distributions + scatter) |
| Multiple KPIs | Small multiples | Dashboard with separate charts |
| Flow / conversion | Sankey / funnel | Waterfall (additive breakdown) |
| Geographic | Choropleth | Bubble map (point data) |

**Avoid:** Pie charts (humans compare angles poorly -- use bar or waffle), 3D charts (distortion, zero information gain), dual-axis (implies false correlation -- use two panels instead).

**Decision shortcut:** If in doubt, horizontal bar chart is almost always a safe, readable choice.

---

## Python Setup

\`\`\`python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import matplotlib.dates as mdates
import matplotlib.patheffects as pe
import seaborn as sns
import numpy as np
import pandas as pd

plt.style.use("seaborn-v0_8-whitegrid")
plt.rcParams.update({
    "figure.figsize": (10, 6),
    "figure.dpi": 150,
    "figure.facecolor": "white",
    "font.family": "sans-serif",
    "font.size": 11,
    "axes.titlesize": 14,
    "axes.titleweight": "bold",
    "axes.labelsize": 12,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "legend.frameon": False,
    "legend.fontsize": 10,
    "xtick.labelsize": 10,
    "ytick.labelsize": 10,
})

# ---- Palettes ----
# Categorical -- distinct hues for unordered categories (max 8 series; use small multiples beyond)
PALETTE_CATEGORICAL = ["#20808D", "#A84B2F", "#1B474D", "#BCE2E7", "#944454", "#FFC553", "#848456", "#6E522B"]
# Sequential -- single hue, varying lightness (for ordered/continuous data)
PALETTE_SEQUENTIAL = sns.color_palette("YlGnBu", n_colors=7)
# Diverging -- two opposing hues through neutral midpoint
PALETTE_DIVERGING = sns.color_palette("RdYlBu", n_colors=7)
# Colorblind-safe fallback -- use when audience is unknown or >3 categories
PALETTE_COLORBLIND = sns.color_palette("colorblind")

# Highlight pattern: accent for key insight, grey for everything else
COLOR_HIGHLIGHT = "#20808D"
COLOR_MUTED = "#BBBBBB"

def highlight_palette(n, highlight_idx=0):
    """Return list of n colors where highlight_idx is accented, rest muted."""
    return [COLOR_HIGHLIGHT if i == highlight_idx else COLOR_MUTED for i in range(n)]
\`\`\`

---

## Number Formatting Helper

\`\`\`python
def format_number(val, fmt="number"):
    """Format numbers for axis labels, annotations, and tooltips.
    fmt: 'number' | 'currency' | 'percent' | 'decimal'"""
    if pd.isna(val):
        return ""
    prefix = "$" if fmt == "currency" else ""
    if fmt == "percent":
        return f"{val:.1f}%"
    if fmt == "decimal":
        return f"{prefix}{val:,.2f}"
    if abs(val) >= 1e9:
        return f"{prefix}{val/1e9:.1f}B"
    if abs(val) >= 1e6:
        return f"{prefix}{val/1e6:.1f}M"
    if abs(val) >= 1e3:
        return f"{prefix}{val/1e3:.1f}K"
    return f"{prefix}{val:,.0f}"

# Apply to axes:
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, p: format_number(x, "currency")))

# Apply to bar labels:
for bar, val in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height(),
            format_number(val), ha="center", va="bottom", fontsize=10)
\`\`\`

---

## Design Principles

1. **Highlight the story**: Bright accent for the key insight; grey (\`#BBBBBB\`) everything else. Use \`highlight_palette()\` to apply this pattern. The viewer's eye goes where color is -- if everything is colored, nothing stands out.
2. **Titles state insights**: "Revenue grew 23% YoY" not "Revenue by Month." Add subtitle with date range and source via \`ax.set_title("Insight", loc="left"); ax.text(0, 1.02, "Subtitle", transform=ax.transAxes, fontsize=9, color="#777")\`.
3. **Sort by value**, not alphabetically, unless a natural order exists (months, funnel stages, time).
4. **Aspect ratio**: Time series wider than tall (16:6 to 16:9); comparisons squarer (8:6). Set via \`figsize\`.
5. **Bar charts start at zero.** Line charts may use non-zero baselines when the value range matters more than absolute position.
6. **Consistent scales across panels** when comparing multiple charts (same y-axis range, same color mapping). Use \`sharey=True\` in \`plt.subplots()\`.
7. **Data-ink ratio**: Every pixel should present data. Remove decorative gridlines, chart borders, and backgrounds. Use \`ax.grid(axis="y", alpha=0.3)\` for subtle horizontal reference lines only.
8. **Label directly**: Place labels on or near data points, not in separate legends. Use \`ax.annotate()\` or \`ax.text()\`. Legends only when direct labeling would clutter (>4 series).
9. **White space is information**: Don't cram charts together. Use \`plt.tight_layout(pad=2.0)\` or \`fig.subplots_adjust()\` for breathing room.
10. **One chart, one message**: If a chart tries to show two things, split it into two charts.

---

## Common Chart Recipes

\`\`\`python
# ---- Annotated bar chart with highlight ----
fig, ax = plt.subplots(figsize=(10, 6))
colors = highlight_palette(len(categories), highlight_idx=top_idx)
bars = ax.barh(categories, values, color=colors)
ax.set_xlabel("")
ax.set_title("Top category outperforms by 2x", loc="left")
for bar, val in zip(bars, values):
    ax.text(bar.get_width() + offset, bar.get_y() + bar.get_height()/2,
            format_number(val), va="center", fontsize=10)

# ---- Time series with confidence band ----
ax.plot(dates, values, color=COLOR_HIGHLIGHT, linewidth=2)
ax.fill_between(dates, lower, upper, color=COLOR_HIGHLIGHT, alpha=0.15)
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))

# ---- Small multiples ----
fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
for ax, (name, group) in zip(axes, df.groupby("category")):
    ax.plot(group["date"], group["value"], color=COLOR_HIGHLIGHT)
    ax.set_title(name, fontsize=12)
fig.suptitle("Trend by category", fontsize=14, fontweight="bold", x=0.05, ha="left")
\`\`\`

---

## Accessibility

- Use \`PALETTE_COLORBLIND\` (or \`sns.color_palette("colorblind")\`) as the default palette when >3 categories or when you don't control the audience.
- Add pattern fills alongside color so the chart works in B&W:
  \`\`\`python
  hatches = ["/", "\\\\", "x", ".", "o", "+", "-", "*"]
  for bar, hatch in zip(bars, hatches):
      bar.set_hatch(hatch)
  \`\`\`
- For line charts, combine color with distinct line styles (\`"-"\`, \`"--"\`, \`"-."\`, \`":"\`) and markers (\`"o"\`, \`"s"\`, \`"^"\`, \`"D"\`).
- Include descriptive alt text that states the key finding, not just "a bar chart." Example: "Bar chart showing Q4 revenue at $4.2M, 23% above Q3."
- Provide a data table alternative when sharing charts in reports or documents.
- **Test:** Does the chart convey its message in grayscale? Is all text readable at standard zoom (font size >= 10)? Print \`fig\` to grayscale: \`fig.savefig("test_bw.png", dpi=72); from PIL import Image; Image.open("test_bw.png").convert("L").save("test_bw.png")\`

---

## Gotchas

- **Truncated y-axis exaggerates differences** -- A bar chart starting at 95 instead of 0 makes a 2% difference look like a 10x gap. Always start bar charts at zero. For line charts, consider a broken axis if the range is extreme.
- **Sequential palettes hide categorical data** -- Using a gradient (light-to-dark) for unordered categories implies a ranking that doesn't exist. Use distinct hues for categorical, sequential shades for ordered/continuous. Quick rule: if the categories have no inherent order, use \`PALETTE_CATEGORICAL\`.
- **Legend order != data order** -- Matplotlib legend order matches plot call order, not the visual stack order in area/stacked charts. Fix: \`handles, labels = ax.get_legend_handles_labels(); ax.legend(handles[::-1], labels[::-1])\` or label directly on the chart.
- **savefig cuts off labels** -- Default \`plt.savefig()\` clips titles and axis labels. Always use \`bbox_inches="tight"\`. Full pattern: \`fig.savefig("chart.png", bbox_inches="tight", facecolor="white", dpi=150)\`.
- **Seaborn mutates global state** -- \`sns.set_theme()\` changes \`rcParams\` globally. Reset with \`plt.rcdefaults()\` after use, or scope changes with \`with plt.rc_context({...}):\`.
- **Number format inconsistency** -- Don't mix "1.2K" and "1,200" on the same chart. Pick one format and apply uniformly via \`FuncFormatter\`.
- **Overlapping labels** -- Long category names on bar charts: use horizontal bars (\`barh\`) or rotate labels (\`plt.xticks(rotation=45, ha="right")\`). For scatter plots, use \`adjustText\` library.
- **Too many colors** -- More than 5-6 colors in a single chart becomes unreadable. Group minor categories into "Other" or switch to small multiples.
- **Date axes crowd** -- Matplotlib auto-ticks dates poorly. Always set explicit locators: \`ax.xaxis.set_major_locator(mdates.MonthLocator())\` and formatters.
- **Tight layout fails with suptitle** -- \`plt.tight_layout()\` ignores \`fig.suptitle()\`. Use \`fig.subplots_adjust(top=0.92)\` to make room.

---

## Quality Checklist (run BEFORE sharing any chart)

- [ ] Title states the insight, not just the metric name
- [ ] Subtitle includes date range, source, or context
- [ ] Key data point highlighted with accent color; supporting data is muted
- [ ] Chart type matches the data question (see selection table)
- [ ] Bar charts start y-axis at zero
- [ ] Text is not clipped or overlapping (check long labels, rotated text)
- [ ] Legend does not overlap data (or labels are applied directly)
- [ ] All axis labels readable (font size >= 10)
- [ ] Number formatting is consistent across axes and annotations
- [ ] Colors have sufficient contrast against background (3:1 minimum between adjacent elements)
- [ ] Colorblind-safe palette used, or patterns/markers supplement color
- [ ] Chart works in grayscale (not relying on color alone)
- [ ] Saved with \`bbox_inches="tight"\`, \`facecolor="white"\`, and \`dpi=150\`
- [ ] Chart answers a specific question -- not just "here's some data"
- [ ] No more than 5-6 series per chart (use small multiples beyond that)
- [ ] Data sorted meaningfully (by value for ranking, by time for trends)
