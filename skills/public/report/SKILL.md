---
name: report
description: "Generate a structured markdown research report with citations, data visualizations, and executive summary."
when_to_use: "When the user asks for a written report, white paper, briefing document, research summary, or any structured deliverable with citations and analysis."
category: research
version: 1.0.0
enabled: true
min_plan: standard
delegate_agent: research-analyst
allowed-tools:
  - web-search
  - browse
  - python-exec
  - write-file
  - read-file
  - search_context
---
Generate a comprehensive research report on: {{ARGS}}

## Output File

**Always write the report to a file with a `.md` extension.**

- Derive the filename from the query topic: `report-<topic-slug>.md` (lowercase kebab-case)
- Write the file using the write-file tool
- After writing, share the file with the user via share-artifact so they can view it
- The chat response should contain a brief summary — the full report lives in the `.md` file

## Research Methodology

Use the /research skill methodology for evidence gathering: define research questions, search multiple sources, cross-reference key claims, prefer primary sources, iterate until gaps are filled. The research is always comprehensive; the output length adapts to user intent.

## Content Format

Reports use standard GitHub-Flavored Markdown (GFM):
- Standard Markdown (headings, paragraphs, lists, emphasis, links, code blocks)
- Markdown tables for comparisons and structured data
- Inline citations as markdown links matching search result URLs
- Embedded images and charts (see Embedding Images below)
- LaTeX math expressions allowed (wrap in \( \) for inline, \[ \] for block — never dollar signs)

## Content Separation

**The report contains ONLY research findings, analysis, and evidence.**
- Direct answers to the user's question go in the chat response, NOT in the report
- The report is a standalone reference document — comprehensible without the chat context
- Think of the chat response as the executive summary and the report as the full analysis

## Report Structure

- **Title** (H1) — descriptive, not clickbait
- **Executive Summary / Overview** — brief synthesis of key findings
- **Body Sections** (H2/H3) — organized by topic or theme, not by source
- **Analysis / Discussion** — interpretation, trade-offs, implications
- **Conclusion** — summary of findings and actionable takeaways

Structure guidelines:
- Use H1 for the report title only
- Use H2 for major sections, H3 for subsections
- Do not skip heading levels (e.g., H1 directly to H3)
- Structure emerges from content and purpose — do not force a rigid template
- Follow domain conventions when applicable (academic, investment, technical, policy)

## Citation System (MANDATORY FOR RESEARCHED TOPICS)

**Use inline markdown links where the anchor text is the source name, publication, or a natural descriptive phrase — never a generic word like "source" or "link", and never a raw URL.**

Only use URLs that are present in your tool outputs. Text must read naturally even if all URLs were removed.

```
Recent research shows significant AI advances ([Nature](https://...)). Multiple studies confirm this trend ([MIT Technology Review](https://...)).
```

Rules:
- Place citations immediately after the claim as inline markdown links
- 1-3 citations per substantive claim
- Distribute citations throughout — consistent density from beginning to end
- All citations are inline — never include a bibliography or references section
- Only cite actual sources from search results — never fabricate citations or URLs

## Embedding Images

When research includes generated charts, plots, or other images, embed them directly in the report:

1. Generate the image using python-exec (matplotlib, plotly) and save as .png
2. Reference in the report using relative path: `![descriptive alt text](./filename.png)`
3. Use descriptive filenames (e.g., `revenue-growth-chart.png`, `market-share-comparison.png`)
4. Place images at contextually appropriate locations — after the paragraph discussing the data
5. Always include meaningful alt text
6. Do NOT use absolute paths — always use `./filename` format

## Length Calibration

- **Concise/summary requests:** 5-10 paragraphs despite thorough research
- **Fact-seeking queries:** Direct answer with rich context, 5-10 paragraphs
- **Comparison/ranking requests:** Structured analysis, 20-40+ paragraphs. Prefer tables.
- **Open-ended research:** 20-40+ paragraphs
- **Explicit depth requests:** Length determined by topic scope with no upper limit
- **Default:** Comprehensive. When in doubt, provide more depth.

## Writing Principles

- Lead with the direct answer, then supporting context
- Paragraphs of 3-8 sentences for most content
- Never use first-person pronouns ("I," "my," "we," "our")
- Use tables when comparing 2+ entities across shared attributes
- Use bullet points when information is naturally list-like
- Lead with conclusions, then support with evidence
- Analyze rather than summarize: explain causation, trade-offs, what makes information actionable
- When sources conflict, state the disagreement, evaluate source quality, justify your conclusion
- Anticipate follow-up questions and address proactively

## Quality Checklist

- Report written to a `.md` file and shared with user
- Valid GFM syntax, appropriate heading hierarchy
- Inline citations present for factual claims (source names as anchor text)
- No bibliography or References section
- Images embedded with relative paths and descriptive alt text
- No first-person pronouns
- Report is standalone — comprehensible without chat context
- Appropriate length matching query complexity
- No TODOs or placeholders — all sections fully written
- Real data only — never fabricate citations or data
