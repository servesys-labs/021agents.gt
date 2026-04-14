# Skill Design Patterns

## Sequential Workflows

For complex tasks, break into clear steps with an overview first:

```markdown
Processing a PDF form involves:
1. Analyze the form (run analyze_form.py)
2. Create field mapping (edit fields.json)
3. Validate mapping (run validate_fields.py)
4. Fill the form (run fill_form.py)
5. Verify output (run verify_output.py)
```

## Conditional Workflows

For branching logic, guide through decision points:

```markdown
1. Determine the modification type:
   **Creating new content?** → Follow "Creation workflow" below
   **Editing existing content?** → Follow "Editing workflow" below

2. Creation workflow: [steps]
3. Editing workflow: [steps]
```

## Progressive Disclosure

### Pattern 1: High-level + references

Keep SKILL.md lean, push variant details to reference files:

```markdown
## Quick Start
[Core workflow]

## Advanced
- **AWS deployment**: See `references/aws.md`
- **GCP deployment**: See `references/gcp.md`
```

### Pattern 2: Domain-specific organization

```
bigquery-skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
```

Agent loads only the relevant reference.

### Pattern 3: Conditional details

```markdown
## Creating Documents
Use docx-js for new documents. See `references/docx-js.md`.

## Editing Documents
For simple edits, modify XML directly.
**For tracked changes**: See `references/redlining.md`
```

## Output Patterns

### Template Pattern (strict output)

```markdown
ALWAYS use this exact structure:

# [Title]
## Executive Summary
[One paragraph]
## Key Findings
- Finding 1 with data
```

### Example Pattern (style guidance)

```markdown
**Example 1:**
Input: Added user authentication
Output:
  feat(auth): implement JWT authentication
  Add login endpoint and token validation

**Example 2:**
Input: Fixed date bug in reports
Output:
  fix(reports): correct timezone conversion
```

## Guidelines

- Keep references one level deep from SKILL.md
- For files >100 lines, include a table of contents
- Avoid duplication — info lives in ONE place
- Test scripts by running them before delivery
