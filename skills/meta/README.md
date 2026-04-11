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
| _(empty — bundler scaffolding only)_ | — | 7.2a |
| `mode-demo` | `buildMetaAgentChatPrompt(mode="demo")` | 7.2b |
| `mode-live` | `buildMetaAgentChatPrompt(mode="live")` | 7.3 |
| `wf-*` (workflows) | workflow index in the main prompt | 7.4 |
| `diagnose-session` | `Diagnostic Mindset` section activation | 7.5 |

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
