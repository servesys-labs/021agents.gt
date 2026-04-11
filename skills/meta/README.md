# Meta-agent-only skills

Files under `skills/meta/<name>/SKILL.md` are **control-plane-only** — they are
consumed by the meta-agent prompt builder (`control-plane/src/prompts/meta-agent-chat.ts`),
never surfaced to user-facing agents.

## Conventions

- **Discovery**: `control-plane/scripts/bundle-skill-catalog.mjs` walks this
  directory and emits `control-plane/src/lib/meta-skill-bodies.generated.ts`,
  a `Record<string, string>` mapping the directory name to the SKILL.md body.
- **Scoping is directory-based, not frontmatter-based.** A skill under
  `skills/meta/` is meta-only by virtue of its location. The bundler will not
  emit these entries into `skill-catalog.generated.ts` (the public catalog),
  and the deploy-side bundler at `deploy/scripts/bundle-skills.mjs` does not
  walk this directory at all. A meta skill cannot leak into `BUILTIN_SKILLS`
  or `NON_BUILTIN_BUNDLED` by accident.
- **No `BUILTIN_SKILL_ORDER` membership.** Meta skills are not slash-commands
  and never appear in `formatSkillsPrompt` output. The meta-agent prompt
  builder reads them directly from `META_SKILL_BODIES` by key.
- **No allowlist entry.** The phase-3 orphan guard (`NON_BUILTIN_ALLOWLIST` in
  `deploy/test/refactor-phase3.test.ts`) only applies to `skills/public/`. Meta
  skills are not orphans — their contract is "exist on disk, appear in
  `META_SKILL_BODIES`, consumed by the prompt builder."

## Phase 7 inventory — complete

Phase 7 closed at prompt file size **16,597** code units (down from
31,714 at Phase 5 end — a 47.7% cut). 19 meta skills live, all
consumed by `buildMetaAgentChatPrompt`:

| # | Name | Consumer | Commit |
|---|---|---|---|
| 1 | `mode-demo` | `${META_SKILL_BODIES['mode-demo']}` when `mode="demo"` | 7.2b |
| 2 | `mode-live` | `${META_SKILL_BODIES['mode-live']}` when `mode="live"` | 7.3 |
| 3 | `diagnose-session` | `## Diagnostic Mindset` section body | 7.5 |
| 4 | `infra-summary` | `## Runtime Infrastructure (summary)` section body | 7.6 |
| 5 | `wf-health-check` | `## Common workflows` via `WORKFLOW_ORDER` + `join("\n")` | 7.4 |
| 6 | `wf-improve` | ↑ | 7.4 |
| 7 | `wf-bad-answers` | ↑ | 7.4 |
| 8 | `wf-start-training` | ↑ | 7.4 |
| 9 | `wf-marketplace-publish` | ↑ | 7.4 |
| 10 | `wf-test-suite` | ↑ | 7.4 |
| 11 | `wf-add-connector` | ↑ | 7.4 |
| 12 | `wf-delegate` | ↑ | 7.4 |
| 13 | `wf-mid-task-stop` | ↑ | 7.4 |
| 14 | `wf-forgot-context` | ↑ | 7.4 |
| 15 | `wf-truncated-results` | ↑ | 7.4 |
| 16 | `wf-tool-blocked` | ↑ | 7.4 |
| 17 | `wf-audit-log` | ↑ | 7.4 |
| 18 | `wf-feature-flags` | ↑ | 7.4 |
| 19 | `wf-cost-analysis` | ↑ (with `{{AGENT_NAME}}` substitution) | 7.4 |

**Uniform trailing whitespace convention (Phase 7-exit normalization):**
every `wf-*/SKILL.md` file ends with exactly `\n\n` at EOF, so after
the bundler's trailing-newline strip each body ends with a single `\n`.
The workflow builder joins with `"\n"` to produce the blank-line
separator between subsections. Adding a new workflow: write the file
ending with one blank line, add the slug to `WORKFLOW_ORDER`, add the
`wf-<slug>` entry to `REQUIRED_META_SKILLS`, regenerate the bundle.

**Deferred to Phase 9:** the `## Your tools` catalog (~5,428 chars)
is load-bearing for tool-use quality and cannot be safely extracted
without behavioral evals. Phase 9's `tools.ts` consolidation
(40 tools → ~10 verbs) will shrink the catalog description
proportionally and unlock the final ~3,000-char drop to ~13,500.

## Adding a meta skill

1. Create `skills/meta/<name>/SKILL.md` with YAML frontmatter (`name`, `description`
   required; `scope: meta` optional-for-clarity but not authoritative).
2. Put the prompt body after the closing `---`.
3. Run `node control-plane/scripts/bundle-skill-catalog.mjs` to regenerate
   both `skill-catalog.generated.ts` and `meta-skill-bodies.generated.ts`.
4. Extend any `REQUIRED_META_SKILLS` assertions in
   `control-plane/src/prompts/meta-agent-chat.ts` if the prompt builder
   hard-depends on the new key.
5. Reference the key from the prompt builder via
   `META_SKILL_BODIES["<name>"]`.

## Template placeholders

Meta skill bodies are **plain markdown** — TypeScript template literal
syntax like `${variable}` does **not** get interpolated when the bundled
body is spliced back into the meta-agent prompt. If a skill body needs
a runtime value (for example, the current agent name in a SQL query),
use the `{{UPPERCASE_SNAKE}}` placeholder convention and substitute
explicitly at splice time.

**Why a placeholder rather than raw `${...}`?**

- `${…}` in a SKILL.md body is just literal characters to the bundler.
  At splice time the chars pass through unchanged and the model sees
  a broken template — a silent failure the freshness gate cannot catch.
- `{{PLACEHOLDER}}` matches the convention deploy's `getSkillPrompt`
  already uses for public skills (`{{ARGS}}` / `{{INPUT}}` substitution
  in `deploy/src/runtime/skills.ts`). Consistent mental model across
  public and meta.
- A future editor making markdown-only changes cannot accidentally
  introduce a `${...}` that silently fails — there's nothing for the
  TypeScript compiler to evaluate.

**Currently in use:**

| Placeholder | Substituted by | Consumers |
|---|---|---|
| `{{AGENT_NAME}}` | `buildMetaAgentChatPrompt`'s `agentName` parameter | `skills/meta/wf-cost-analysis/SKILL.md` |

**Adding a new placeholder:**

1. Document it in the table above.
2. Add the `.replace(/\{\{NEW_NAME\}\}/g, value)` call in the prompt
   builder where the meta skill body is spliced in. Substitution
   happens on the concatenated workflow bundle AFTER
   `META_SKILL_BODIES.join("")`, so it covers every meta skill in one
   pass.
3. The byte-identity test in `meta-agent-chat.test.ts` computes
   `EXPECTED_SHA` against a fixed test value for each placeholder.
   Update that fixture if a new placeholder is introduced.
