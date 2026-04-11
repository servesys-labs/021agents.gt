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

## Phase 7 inventory

| Name | Consumer | Added in commit |
|---|---|---|
| _(bundler scaffolding)_ | — | 7.2a ✅ |
| `mode-demo` | `buildMetaAgentChatPrompt(mode="demo")` | 7.2b ✅ |
| `mode-live` | `buildMetaAgentChatPrompt(mode="live")` | 7.3 ✅ |
| `wf-health-check`, `wf-improve`, `wf-bad-answers`, `wf-start-training`, `wf-marketplace-publish`, `wf-test-suite`, `wf-add-connector`, `wf-delegate`, `wf-mid-task-stop`, `wf-forgot-context`, `wf-truncated-results`, `wf-tool-blocked`, `wf-audit-log`, `wf-feature-flags`, `wf-cost-analysis` | Concatenated via `WORKFLOW_ORDER` into the `## Common workflows` section | 7.4 ✅ |
| `diagnose-session` | `## Diagnostic Mindset` section | 7.5 ✅ |
| `infra-summary` | `## Runtime Infrastructure (summary)` section | 7.6 ✅ |
| _(deferred)_ | `## Your tools` catalog — deferred to Phase 9 alongside tool consolidation | — |

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
