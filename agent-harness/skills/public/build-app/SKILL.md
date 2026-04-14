---
name: build-app
description: "Build a complete application — plan, scaffold, implement, test. Covers CLI tools, APIs, scripts, data pipelines, and general TypeScript/Python projects. For web apps and websites, prefer the /website skill."
when_to_use: "When the user asks to build an app, tool, script, API, CLI, pipeline, or any non-web project. Also when the user says 'build me' something without specifying web."
category: development
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - write-file
  - edit-file
  - grep
  - glob
  - python-exec
  - execute-code
  - save-project
---
Build: {{ARGS}}

## Stack Selection

| Project Type | Default Stack | Override If |
|---|---|---|
| CLI tool / script | TypeScript + tsx | User asks for Python or Go |
| REST API | TypeScript + Hono + Bun | User asks for Express, FastAPI, etc. |
| Data pipeline | Python + pandas | User asks for TypeScript or Rust |
| Automation / cron job | TypeScript | User asks for shell script or Python |
| Library / package | TypeScript + tsup | User asks for Python (setuptools/poetry) |
| Full-stack web app | Use /website skill instead | — |

If the user specifies a stack, use it. Don't ask — just build.

## Workflow

1. **Plan** (visible to user) — list the files you'll create as a checklist. Skip this for trivial scripts (<3 files).
2. **Scaffold** — package.json/pyproject.toml, tsconfig.json, config files. Include ALL dependencies.
3. **Implement** — types/interfaces first, then core logic, then entry point. Every file must be complete — no `// TODO` placeholders.
4. **Install + test** — `npm install && npm run build` (TS) or `pip install -e .` (Python). Fix errors before proceeding.
5. **Save** — `save-project(project_name="<name>")` to persist to R2.
6. **Verify** — run the app/script/tests and confirm it works. If it doesn't, fix it.
7. **Summarize** — show file tree and how to run.

## Rules

- All files in `/workspace/<project-name>/`
- TypeScript with proper types unless user asks otherwise
- Include a README.md with usage instructions
- For APIs: include at least one example request/response
- For CLIs: include `--help` output in the summary
- For scripts: show the actual output of running it
