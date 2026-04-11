---
name: analyze
description: "Analyze data files (CSV, JSON, Excel) — clean, summarize, find patterns, and generate insights."
when_to_use: "When the user provides or references data and asks for analysis, insights, trends, patterns, statistics, or summaries."
category: data
version: 1.0.0
enabled: true
min_plan: standard
delegate_agent: data-analyst
allowed-tools:
  - python-exec
  - read-file
  - write-file
  - bash
---
Data analysis task: {{ARGS}}

## Six-Phase Analysis Protocol

Follow these phases in order. Show your work at every step -- print actual values, not just descriptions. The user should be able to audit your reasoning.

---

### Phase 1: INGEST -- Load and Understand the Data

\`\`\`python
import pandas as pd
import numpy as np
from pathlib import Path

# Detect format and load
def load_data(path):
    p = Path(path)
    ext = p.suffix.lower()
    loaders = {
        ".csv": lambda: pd.read_csv(p, encoding="utf-8-sig"),  # handles BOM
        ".tsv": lambda: pd.read_csv(p, sep="\t", encoding="utf-8-sig"),
        ".json": lambda: pd.read_json(p),
        ".jsonl": lambda: pd.read_json(p, lines=True),
        ".xlsx": lambda: pd.read_excel(p, engine="openpyxl"),
        ".xls": lambda: pd.read_excel(p, engine="xlrd"),
        ".parquet": lambda: pd.read_parquet(p),
        ".feather": lambda: pd.read_feather(p),
    }
    if ext not in loaders:
        return pd.read_csv(p)  # CSV fallback
    return loaders[ext]()

df = load_data("data.csv")
\`\`\`

**Immediately print:**
- Shape: \`df.shape\`
- Column names and dtypes: \`df.dtypes\`
- First 5 rows: \`df.head()\`
- Null counts: \`df.isnull().sum()\`
- Identify the **grain** (what does each row represent?) and state it explicitly

**Encoding issues:** If garbled characters appear, retry with \`encoding="latin-1"\` or \`encoding="cp1252"\`. For mixed encodings, use \`errors="replace"\`.

---

### Phase 2: PROFILE -- Statistical Overview

\`\`\`python
# Numeric columns
print(df.describe().T[["count", "mean", "std", "min", "25%", "50%", "75%", "max"]])

# Categorical columns
for col in df.select_dtypes(include=["object", "category"]).columns:
    vc = df[col].value_counts()
    print(f"\n{col}: {df[col].nunique()} unique values, top 5:")
    print(vc.head())

# Cardinality summary
print("\nCardinality:")
for col in df.columns:
    n = df[col].nunique()
    print(f"  {col}: {n} unique / {len(df)} rows ({n/len(df)*100:.1f}%)")

# Memory usage
print(f"\nMemory: {df.memory_usage(deep=True).sum() / 1e6:.1f} MB")
\`\`\`

**Report:** Shape, dtypes, null percentages, basic stats (mean/median/std/min/max) for numerics, top values and cardinality for categoricals.

---

### Phase 3: CLEAN -- Prepare Data for Analysis

**Missing value strategy decision table:**

| Pattern | Strategy | When to use |
|---------|----------|-------------|
| < 5% missing, random | Drop rows | Small dataset, plenty of rows |
| < 5% missing, random | Fill with median (numeric) / mode (categorical) | Need to preserve row count |
| Systematic missing (e.g., optional field) | Keep as-is or create indicator column | Missingness is informative |
| > 30% missing | Drop column or flag for investigation | Column may be unreliable |
| Time series gaps | Interpolate (linear/ffill) | Temporal continuity matters |

\`\`\`python
# Normalize column names
df.columns = df.columns.str.strip().str.lower().str.replace(r"[\s/\-]+", "_", regex=True)

# Fix dtypes
for col in df.columns:
    if df[col].dtype == "object":
        try:
            df[col] = pd.to_datetime(df[col], infer_datetime_format=True)
            continue
        except (ValueError, TypeError):
            pass
    if df[col].dtype == "object":
        cleaned = df[col].astype(str).str.replace(r"[\$,%]", "", regex=True).str.strip()
        try:
            df[col] = pd.to_numeric(cleaned)
        except (ValueError, TypeError):
            pass

# Deduplicate
n_dupes = df.duplicated().sum()
if n_dupes > 0:
    print(f"Removing {n_dupes} duplicate rows")
    df = df.drop_duplicates()

# Outlier detection (IQR method)
def detect_outliers_iqr(series):
    Q1, Q3 = series.quantile(0.25), series.quantile(0.75)
    IQR = Q3 - Q1
    return ((series < Q1 - 1.5 * IQR) | (series > Q3 + 1.5 * IQR)).sum()

for col in df.select_dtypes(include="number").columns:
    n_outliers = detect_outliers_iqr(df[col])
    if n_outliers > 0:
        print(f"  {col}: {n_outliers} outliers (IQR method)")
\`\`\`

**Document every cleaning decision.** State what you changed and why. Never silently drop data.

---

### Phase 4: ANALYZE -- Extract Patterns and Insights

\`\`\`python
# Distribution analysis
for col in df.select_dtypes(include="number").columns:
    skew = df[col].skew()
    kurt = df[col].kurtosis()
    print(f"{col}: skew={skew:.2f}, kurtosis={kurt:.2f}")

# Correlation matrix (numeric columns)
corr = df.select_dtypes(include="number").corr()
# Flag strong correlations (|r| > 0.7)
strong = corr.where(np.triu(np.ones(corr.shape), k=1).astype(bool))
strong = strong.stack().reset_index()
strong.columns = ["var1", "var2", "corr"]
print(strong[strong["corr"].abs() > 0.7].sort_values("corr", ascending=False))

# Group-by aggregations (adapt to the specific question)
# df.groupby("category")["revenue"].agg(["mean", "median", "sum", "count"])

# Time series decomposition (if temporal data detected)
# from statsmodels.tsa.seasonal import seasonal_decompose
# result = seasonal_decompose(ts, model="additive", period=12)

# Statistical tests where appropriate
# - t-test for comparing two group means
# - chi-squared for categorical independence
# - Mann-Whitney U for non-normal distributions
# from scipy import stats
# stat, p = stats.ttest_ind(group_a, group_b)
\`\`\`

**For every finding, answer: "So what?"** Don't just report that two variables correlate -- explain what it means for the user's question.

---

### Phase 5: VISUALIZE -- Tell the Story with Charts

Generate 3-5 key visualizations. Reference the /chart skill for full chart selection table, palettes, and design principles.

**Auto-select chart types per finding:**

| Finding type | Chart |
|-------------|-------|
| Top/bottom ranking | Horizontal bar (sorted) |
| Trend over time | Line with optional confidence band |
| Distribution shape | Histogram or KDE |
| Group comparison | Grouped bar or box plot |
| Correlation | Scatter with regression line |
| Composition | Stacked bar or treemap |

\`\`\`python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

plt.style.use("seaborn-v0_8-whitegrid")
plt.rcParams.update({
    "figure.figsize": (10, 6), "figure.dpi": 150,
    "axes.spines.top": False, "axes.spines.right": False,
})
PALETTE = ["#20808D", "#A84B2F", "#1B474D", "#BCE2E7", "#944454", "#FFC553"]

# Every chart title states the INSIGHT, not the metric:
# GOOD: "Revenue grew 23% YoY driven by enterprise segment"
# BAD:  "Revenue by Quarter"

fig.savefig("chart_name.png", bbox_inches="tight", facecolor="white", dpi=150)
\`\`\`

---

### Phase 6: SYNTHESIZE -- Deliver Actionable Findings

Present findings in this structure:

**Executive Summary** (2-3 sentences -- the headline the user needs first)

**Key Insights** (ranked by impact, not by discovery order):
1. Insight with exact numbers and context
2. Insight with exact numbers and context
3. ...

**Limitations and Caveats:**
- Sample size considerations
- Missing data impact
- Assumptions made during cleaning
- Potential confounders or biases

**Recommended Next Steps:**
- Specific, actionable recommendations based on findings
- What additional data would strengthen the analysis
- Suggested follow-up analyses

---

## Anti-Patterns (never do these)

- **Don't analyze without cleaning.** Raw data has encoding issues, mixed types, and nulls that corrupt stats.
- **Don't claim causation from correlation.** "X correlates with Y" is not "X causes Y." State the relationship precisely.
- **Don't ignore outliers without explanation.** Either explain why they're excluded or analyze their impact.
- **Don't present raw p-values without context.** State the test, the null hypothesis, and the practical significance -- not just "p < 0.05."
- **Don't generate charts without insights.** Every chart must have a title that states a finding. No "Figure 1: Data."
- **Don't skip the grain check.** If you don't know what each row represents, you will aggregate incorrectly.

---

## Quality Checklist

- [ ] Grain identified and stated explicitly
- [ ] All cleaning decisions documented (what changed, why)
- [ ] No silent data drops -- row counts reported before/after each cleaning step
- [ ] Summary statistics computed and reviewed before analysis
- [ ] Insights answer "so what?" -- not just "here is a number"
- [ ] All charts saved as PNG with insight-stating titles
- [ ] Executive summary leads with the most important finding
- [ ] Limitations and caveats stated honestly
- [ ] Recommendations are specific and actionable
- [ ] Numbers are exact (not rounded to meaninglessness) with appropriate precision
