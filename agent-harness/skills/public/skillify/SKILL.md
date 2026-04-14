---
name: skillify
description: "Create, update, or validate reusable skill packages. Covers the full lifecycle: understand → plan resources → scaffold → implement → validate → deliver. Use when creating new skills, improving existing skills, or packaging a repeatable process into a skill."
when_to_use: "When the user asks to create a skill, make a skill, package a workflow as a skill, or improve an existing skill."
category: meta
version: 2.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - write-file
  - edit-file
  - execute-code
  - python-exec
  - web-search
---

# Skill Creator

Create effective, token-efficient skill packages that extend the agent's capabilities with specialized knowledge, workflows, and bundled resources.

## About Skills

Skills are modular, self-contained packages. They transform a general-purpose agent into a specialist with domain-specific procedural knowledge. A skill is NOT a prompt — it's an onboarding guide for a specific domain.

### What Skills Provide

1. **Specialized workflows** — multi-step procedures for specific domains
2. **Tool integrations** — instructions for APIs, file formats, external services
3. **Domain expertise** — schemas, business logic, company-specific knowledge
4. **Bundled resources** — scripts, references, templates for complex tasks

### Anatomy

```
skill-name/
├── SKILL.md              (required — frontmatter + instructions)
├── scripts/              (optional — executable code for repetitive tasks)
├── references/           (optional — docs loaded on demand)
└── templates/            (optional — output assets: code templates, fonts, icons)
```

## Core Principles

### 1. Concise is Key

The context window is shared. Only add information the agent doesn't already have. Challenge each paragraph: "Does the agent need this explanation?" and "Does this justify its token cost?"

**Prefer concise examples over verbose explanations.**

### 2. Set Appropriate Freedom

| Freedom Level | When | Format |
|---|---|---|
| High (text instructions) | Multiple approaches valid, context-dependent | Natural language guidance |
| Medium (pseudocode/params) | Preferred pattern exists, some variation ok | Pseudocode with parameters |
| Low (specific scripts) | Fragile operations, consistency critical | Exact scripts, few params |

Think of it as a path: a narrow bridge needs guardrails (low freedom), an open field allows many routes (high freedom).

### 3. Progressive Disclosure

Three-level loading:
1. **Metadata** — always in context (~100 words): name + description in frontmatter
2. **SKILL.md body** — loaded when skill triggers (keep under 500 lines)
3. **Bundled resources** — loaded on demand via `load_context`

**Keep SKILL.md under 500 lines.** When approaching the limit, split variant-specific details into reference files.

## Creation Process

### Step 1: Understand with Concrete Examples

Skip only when usage patterns are already clear.

Gather examples of how the skill will be used:
- "What functionality should this skill support?"
- "Can you give examples of how it would be used?"
- "What are the inputs and expected outputs?"

Don't ask too many questions at once. Conclude when functionality is clear.

### Step 2: Plan Resources

For each example, identify reusable resources:

| Resource Type | When | Example |
|---|---|---|
| `scripts/` | Code rewritten repeatedly | `rotate_pdf.py`, `validate_schema.py` |
| `templates/` | Same boilerplate each time | React component template, theme tokens |
| `references/` | Docs needed repeatedly | API schemas, dependency matrices |

### Step 3: Scaffold

Run the init script to create the skill directory structure:

```bash
python /workspace/skills/public/skillify/scripts/init_skill.py <skill-name>
```

This creates:
```
/workspace/skills/<skill-name>/
├── SKILL.md          # Template with TODO placeholders
├── scripts/          # For executable code
├── references/       # For documentation
└── templates/        # For output assets
```

### Step 4: Implement

#### Start with Resources

Create the `scripts/`, `references/`, and `templates/` files identified in Step 2. Test scripts by running them. Delete unused example files.

#### Write SKILL.md

**Frontmatter** (YAML):
```yaml
---
name: skill-name
description: "What it does AND when to use it. This is the primary trigger."
when_to_use: "Explicit trigger conditions for activation."
category: development | design | research | meta | productivity
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - write-file
  # ... only tools this skill needs
---
```

**Body** (Markdown):
- Write in imperative form ("Create the file", "Run the command")
- Include workflow steps as numbered phases
- Reference bundled resources: `See templates/component.tsx for the starter template`
- Add quality gates and error recovery
- Document gotchas and pitfalls that waste time

#### Progressive Disclosure Patterns

**Pattern 1: High-level guide with references**
```markdown
## Quick Start
[Core workflow here]

## Advanced
- **Form filling**: See `references/forms.md`
- **API reference**: See `references/api.md`
```

**Pattern 2: Domain-specific organization**
```
skill/
├── SKILL.md (overview + routing)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

When user picks AWS, agent only reads `references/aws.md`.

**Pattern 3: Conditional workflows**
```markdown
1. Determine the type:
   **Creating new?** → Follow "Creation workflow"
   **Editing existing?** → Follow "Editing workflow"
```

See `references/patterns.md` for more examples.

### Step 5: Validate

Run the validation script:

```bash
python /workspace/skills/public/skillify/scripts/validate_skill.py <skill-name>
```

This checks:
- SKILL.md exists with valid frontmatter (name, description)
- Body under 500 lines
- All referenced files exist
- No TODO placeholders remain
- Scripts are executable

### Step 6: Deliver

After validation passes:

1. **Upload to R2** for immediate availability:
```bash
# Public skill (available to all agents)
wrangler r2 object put STORAGE/skills/public/<skill-name>/SKILL.md --file /workspace/skills/<skill-name>/SKILL.md --remote

# Upload bundled resources
for f in scripts/* references/* templates/*; do
  wrangler r2 object put STORAGE/skills/public/<skill-name>/$f --file /workspace/skills/<skill-name>/$f --remote
done
```

2. **Tell the user** the skill is active and how to use it:
```
Skill "<name>" is now available. Activate it with: load_context("skills", "<name>")
```

3. **Save to memory** for future reference.

### Step 7: Iterate

After testing the skill on real tasks:
1. Notice struggles or inefficiencies
2. Identify what to update in SKILL.md or resources
3. Implement changes, re-validate, re-upload
4. Learned rules automatically persist via skill overlay system

## Anti-Patterns

- **Don't explain what the agent already knows.** "Use Python to process files" is noise. "Use `pdfplumber` not `PyPDF2` because PyPDF2 drops form fields" is signal.
- **Don't include README, CHANGELOG, or user docs.** Skills are for AI agents, not humans.
- **Don't deeply nest references.** Keep one level deep from SKILL.md.
- **Don't duplicate.** Information lives in SKILL.md OR references, not both.
- **Don't include secrets or credentials.** Reference the agent's secret store instead.

## Output Patterns

### Template Pattern (strict)
For consistent output format, provide exact templates:
```markdown
ALWAYS use this structure:
# [Title]
## Executive Summary
[One paragraph]
## Key Findings
- Finding 1
```

### Example Pattern (flexible)
For style guidance, provide input/output pairs:
```markdown
**Input:** Added JWT auth
**Output:** feat(auth): implement JWT-based authentication
```

Examples help the agent understand style better than descriptions.

## Resources

- `scripts/init_skill.py` — Scaffold a new skill directory
- `scripts/validate_skill.py` — Validate skill structure and content
- `references/patterns.md` — Progressive disclosure and workflow patterns
