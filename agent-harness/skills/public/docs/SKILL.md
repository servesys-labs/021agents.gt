---
name: docs
description: Load relevant API documentation, SDK reference, or framework guides based on the current project context.
category: reference
version: 1.0.0
enabled: true
allowed-tools:
  - read-file
  - web-search
  - grep
  - glob
---
You are executing the /docs skill. Topic: {{ARGS}}

## Documentation Lookup

### Step 1: Detect Project Context
Scan the workspace to identify:
- Languages used (check file extensions, package.json, pyproject.toml, go.mod, etc.)
- Frameworks (React, Express, Django, FastAPI, etc.)
- APIs referenced (check imports, config files)

### Step 2: Find Relevant Docs
Based on the topic and detected context:
1. Search the workspace for existing documentation (README, docs/, wiki/)
2. Search for inline documentation (JSDoc, docstrings, comments)
3. If the topic is about an external API or library, search the web for the official docs

### Step 3: Present
Format the documentation in a clear, scannable way:
- Start with a one-paragraph summary
- Include code examples specific to the user's language/framework
- Link to official documentation when available
- Highlight common gotchas or breaking changes

RULES:
- Always prefer the project's OWN documentation over generic web results.
- If docs conflict with the codebase, trust the codebase.
- Show code examples that match the project's style (imports, naming conventions, etc.).
