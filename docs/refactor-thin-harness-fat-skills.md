# Plan: Thin Harness, Fat Skills

A comprehensive phased refactor to invert this repo from "fat harness, thin skills" to the architecture Yegge / YC "thin harness, fat skills" describes. Every phase has entry criteria, work items pinned to file:line, an exit audit, and a rollback lever. The plan is greedy: this is a prototype with no users and no production data, so canary rollouts and 30-day gates are omitted; correctness gates (golden hashes, eval pass-rate, LoC budgets) remain.

## ▶︎ Resume here (2026-04-11)

**Status:** Phases 0, 1, 2, 3, 4, 5, 6, 7, **6.5 ✅ done**. **Resume at the meta-agent eval harness prerequisite** — a fixed-input grader that scores "did the meta-agent produce a better/worse agent configuration" against a canonical input set. Phase 8 (latent logic extraction — `reasoning-strategies.ts`, `intent-router.ts`, `permission-classifier.ts` → `skills/meta/`) is blocked on this prerequisite because unlike Phase 7, those extractions will not be byte-identical and byte-identity tests cannot catch semantic regressions. Phase 9 (`tools.ts` consolidation to ~10 verbs) is structurally unblocked but also wants the eval harness first so "we shrunk the tool catalog without regressing agent-creation quality" can be proven rather than asserted.

### Phase 6.5 snapshot — complete

Phase 6.5 activated the skill learning loop end-to-end. The auto-fire detector now scans `evolve-agent` analyzer output for recurring failure clusters and routes proposals through the control-plane `/append-rule` endpoint, which enforces dual-bucket rate limiting (5/day auto, 10/day human), prompt-injection scanning, tamper-checked audit, admin revert, and a server-side dedup guard against click-spam. Written under `agentName=""` (org-wide overlay scope) so the rule loads under any agent's `/improve` invocation — the meta-agent's in particular.

| # | Commit | Ref | Scope |
|---|---|---|---|
| 0 | Advisory xact lock in `appendRule` rate limiter | `998522a7` | race-fix prerequisite — serializes `(org, skill)` COUNT→INSERT pair via `pg_advisory_xact_lock` |
| 0-hot | Pass lock through deploy round-trip mock | `f7970c83` | hotfix for deploy-side stateful mock that fails-closed on unknown queries |
| 6.5.1 | Dual-bucket rate limit — 5/day auto, 10/day human | `4571e737` | partitioned `COUNT(*) FILTER (...)` query; prevents auto-fire runaway from starving human admin calls |
| 6.5.2 | `skill-feedback` detector + `/append-rule` route | `74b450d3` | new `deploy/src/runtime/skill-feedback.ts` + sibling route on `skills-admin.ts`; org-wide overlay scope asserted by a round-trip test that writes with `agentName=""` and reads with a different agent |
| 6.5.3 | Wire auto-fire into `evolve-agent` + server-side dedup `[fixture-bump]` | `4b36a92b` | capability activation at `tools.ts:3099` (ceiling 8080 → 8092); 7-day dedup window on `pattern=X` in audit reason; fail-open on both detector and fire throws |

**Architectural shifts in Phase 6.5:**

- **Dual-bucket rate limit** — `skill-mutation.ts` now partitions by `source LIKE 'auto-fire%'`. Human bucket is 10/day (unchanged from Phase 6), auto bucket is 5/day (new, tighter). The `SKILL_MUTATION_RATE_LIMIT_PER_DAY` constant survives as a `@deprecated` alias to `HUMAN_PER_DAY` for backwards-compat with Phase 6 tests.
- **Org-wide overlay scope** — the Phase 6.5 correctness load-bearer. Rules are written with `agentName=""` so `loadSkillOverlays(hyperdrive, orgId, X)`'s `WHERE agent_name = X OR agent_name = ''` query matches them for any agent `X`, including the meta-agent's `/improve` runs (which use a different agent name than the analyzed target). Asserted by a round-trip test at `deploy/test/skill-learning-loop.test.ts` that writes under `""` and reads under `"completely-different-agent"`.
- **PII scrub + session-ID drop** — `example_errors` embedded in rule text are truncated to 120 chars and run through a secret-pattern scrubber (Anthropic/OpenAI keys, Bearer tokens, emails, Slack/GitHub/AWS keys). Affected session IDs are dropped entirely — inference-useless at `/improve` time and belong in `skill_audit` forensics, not overlays shipped to the model.
- **Fail-open detector** — all detector and fire calls are wrapped in try/catch with `log.warn`. A broken detector cannot break the analyzer response path. Asserted by two integration tests that force throws at each boundary and verify `evolve-agent` still returns its report.
- **Server-side dedup, auto-fire-only** — `/append-rule` extracts `pattern=X` from the `reason` field and runs a 7-day `SELECT 1 FROM skill_audit WHERE source LIKE 'auto-fire%' AND reason LIKE '%pattern=X%'` guard before calling `appendRule`. Human admin calls bypass dedup entirely (re-appending is intentional override). Fallthrough is graceful — missing `pattern=` token defers to the rate limiter as the structural safety net. Dedup returns 200 with `{ appended: false, skipped: "duplicate_within_7_days", pattern }` (not 4xx) because the client request was valid and the server chose not to create a duplicate.
- **Dynamic import at the hook point** — `tools.ts` uses `await import("./skill-feedback")` inside a try/catch rather than a top-of-file import. Keeps the import section clean and gives the try/catch the widest possible fail-open surface (import-failure, type mismatch, or runtime throw all degrade to `log.warn` + analyzer response unchanged).
- **Service-binding auth synthesis** — the deploy-side `fireSkillFeedback` POSTs via `env.CONTROL_PLANE.fetch` with `Authorization: Bearer ${SERVICE_TOKEN}` + `X-Org-Id: ${orgId}`. The control-plane auth middleware at `auth.ts:48-63` synthesizes a `{ role: "owner", org_id: <X-Org-Id> }` user for the route handler, so no new role type or schema change was needed. Attribution happens via the `source` field (`auto-fire:evolve`), which is also the rate-limiter partition key.

**Validation at Phase 6.5 close:**

- control-plane: **815/815** tests green (was 766 at Phase 7 close; +49 = 28 from orthogonal credit-holds landings + 21 from Phase 6.5)
- deploy: **513/513** tests green (was 481 at Phase 6 round-trip; +32 = 25 new detector + 1 overlay-scope round-trip + 6 auto-fire integration)
- Both `tsc --noEmit` clean on control-plane and deploy
- `tools.ts`: **8092/8092** at ceiling (Phase 6.5 consumed the 2-line headroom and added 10 real lines)
- `skills.ts`: 180/180 unchanged
- `meta-agent-chat.ts`: **16,597/16,597** unchanged — Phase 7 floor preserved, no Phase 6.5 work touched the meta prompt
- `prompt_budget.json`: untouched
- `skill_hashes.json`, `skill_manifest.json`: untouched
- Phase 7 byte-identity invariants: all 19 meta skills still byte-identical to their pre-extraction source

### Phase 7 snapshot — complete

Phase 7 landed in 8 commits on main between `325242f1` (7.1) and the Phase 7-exit commit. Cumulative cut: **31,714 → 16,597 code units (−47.7%)**. The original aspirational target of 14,000 was replaced with a measured floor: Phase 7's real floor without touching the 5,428-char "Your tools" catalog is ~16,600. The remaining ~3,000-char gap to 13,500 is gated on Phase 9's `tools.ts` consolidation (40 tools → ~10 verbs), which will shrink the catalog description proportionally.

| # | Commit | Ref | Cut | Cumulative |
|---|---|---|---|---|
| 7.1 | Delete dead `TOOL_CATALOG_DOCS` + `read_tool_catalog` reference | `325242f1` | −2,512 | −2,512 |
| 7.2a | `skills/meta/` scaffold + bundler walker + `META_SKILL_BODIES` empty map | `f811ca3e` | +168 | −2,344 |
| 7.2b | Extract `DEMO_MODE_INSTRUCTIONS` + Path B regex fix (`[ \t]*\n` symmetric) | `910edd17` | −2,489 | −4,833 |
| 7.3 | Extract `LIVE_MODE_INSTRUCTIONS` + collapse mode ternary to pure lookup | `40adb7f2` | −3,797 | −8,630 |
| 7.4 | Extract 15 Common workflows + `WORKFLOW_ORDER` + `{{AGENT_NAME}}` placeholder | `27c02468` | −3,683 | −12,313 |
| 7.5 | Extract `## Diagnostic Mindset` body | `ebfd3900` | −1,073 | −13,386 |
| 7.6 | Extract `## Runtime Infrastructure (summary)` body | `444978a6` | −1,330 | −14,716 |
| 7-exit | Normalize workflow whitespace + `join("\n")` + remove 5 byte-identity tests + docs | _this commit_ | −401 | −15,117 |

**Architectural shifts in Phase 7:**

- **`skills/meta/` as a new root** (7.2a) — meta-agent-only skills, discovered by control-plane bundler ONLY (never by `deploy/scripts/bundle-skills.mjs`). Directory-based scoping, not frontmatter-based — a typo on a `scope: meta` field cannot misroute a file into the public catalog.
- **Path B regex fix** (7.2b) — `control-plane/scripts/bundle-skill-catalog.mjs`'s `FRONTMATTER_RE` changed from `\s*\n` to `[ \t]*\n` symmetrically. Preserves leading newlines in bodies. Deploy bundler intentionally untouched (Phase 0 hash-locked).
- **`META_SKILL_BODIES` generated map** — 19 entries at Phase 7 end (2 modes + 2 sections + 15 workflows), consumed via direct lookup (`${META_SKILL_BODIES[key]}`) in `buildMetaAgentChatPrompt`. `REQUIRED_META_SKILLS` module-load assert fails loudly at worker boot if any entry is missing.
- **`{{AGENT_NAME}}` placeholder convention** (7.4) — meta skill bodies are plain markdown, not TS template literals. `${…}` interpolation does not evaluate when bodies are spliced back into the prompt. Runtime values use `{{UPPERCASE_SNAKE}}` placeholders substituted explicitly at build time. First consumer: `wf-cost-analysis` SQL queries.
- **`WORKFLOW_ORDER` + uniform `\n` trailing + `join("\n")`** (7.4 → 7-exit) — explicit semantic ordering at the consumer site, uniform trailing whitespace across all 15 workflow bodies, explicit separator in the join. Reordering workflows is a one-line array swap.
- **CI freshness gate** (extended at 7.2a) — the existing skill-catalog freshness step in `.github/workflows/ci.yml` now also runs `git diff --exit-code` on `meta-skill-bodies.generated.ts`. This is the ongoing drift guard for all 19 meta skills after the 5 byte-identity tests were removed in Phase 7-exit.

**Validation at Phase 7 close:**
- control-plane: 766/766 tests green (was 771 at 7.6; −5 byte-identity tests retired into the freshness gate)
- deploy phase-0 drift guards: all green (prompt budget, LoC, snapshots)
- Every Phase 7 commit green in CI on push (8 consecutive, starting from the lockfile fix at `183b4f86`)
- 19/19 meta skill bodies byte-identical to their pre-extraction source at every commit, verified by byte-identity tests during the chain before retirement in 7-exit

---

### Original resume (historical, 2026-04-11 preserved for context)

### Phase 6 progress snapshot

Phase 6 was originally scoped as 8 commits. Commits 1-5 are on main. Commit 6 (deploy-side `skill-mutation.ts` client + `tools.ts` wiring) was **deliberately skipped** as Shape A — see the "Commit 6 skip rationale" block below. Phase 6 therefore shrinks to **7 commits total**:

| # | Commit | Status | Git ref |
|---|---|---|---|
| 1 | `skill_overlays` + `skill_audit` migration (002_skill_learning.sql + inline into 001_init.sql) | ✅ | `fe05a716` |
| 2 | `/diarize` + `/improve` SKILL.md + fixtures + bundle regen | ✅ | `1ec1fc9b` |
| 3 | `manage_skills append_rule` handler + rate limiter + injection guard (reuses `detectInjection` from `prompt-injection.ts`) + audit writer. New helper at `control-plane/src/logic/skill-mutation.ts` | ✅ | `2427c60c` |
| 4 | `loadSkillOverlays` + `getSkillPrompt` overlay merge in `deploy/src/runtime/skills.ts` (lands at 180/180 ceiling after JSDoc trims) | ✅ | `7486598b` |
| 5 | ~~Deploy-side `skill-mutation.ts` client + `tools.ts` wiring~~ | ⏭ **skipped (Shape A)** | — |
| 6 | Admin revert endpoint (reads `before_content` from `skill_audit`, asserts `sha256(before_content) === before_sha` before restoring, uses `overlay_id` for clean DELETE) | ⏳ next | — |
| 7 | Round-trip regression test (imports `appendRule` directly from `control-plane/src/logic/skill-mutation` — no HTTP, vitest in-process) | ⏳ | — |

**Deviations from the original Phase 6 plan (all auditable):**
- `skill_audit` schema gained `before_content TEXT NOT NULL` AND `after_content TEXT NOT NULL` (not just SHAs — revert needs the bytes, audit needs a linear `SELECT` for historical reconstruction). Also gained a nullable `overlay_id TEXT` FK to `skill_overlays` so commit 6's revert is `DELETE FROM skill_overlays WHERE overlay_id = $1` instead of reverse-lookup by content hash.
- Learned rules are stored in a new `skill_overlays` table, **not** appended into the existing `skills` DB table. Separating them avoids the shadow bug in `formatSkillsPrompt` (`[...BUILTIN_SKILLS, ...skills]` emitting duplicates when a DB row shares a BUILTIN name) and keeps row semantics single-purpose.
- Audit content is **overlay-state**, not full effective body. Rationale in `skill-mutation.ts:1-37`: disk SKILL.md is git-versioned and can drift independently, control-plane catalog stays ~2KB (no bundled bodies), history reconstruction joins audit rows with `git show <date>:skills/public/X/SKILL.md`.
- Rate limiter enforced **control-plane-side** in the `append_rule` handler, not deploy-side — a deploy-side limiter can be bypassed by calling `manage_skills` directly from the UI.
- Second-ask auto-fire detection is deferred to **Phase 6.5**. Commit 5 (the deploy-side client) was the wire-up for that detector, and without the detector there's nothing to route.

### Commit 6 skip rationale (Shape A)

The plan originally called for `deploy/src/runtime/skill-mutation.ts` — a deploy-side HTTP client that posts to a control-plane RPC route, to be called from `tools.ts:3072 evolve-agent` and `tools.ts:3135 autoresearch` when they detect a "second-ask" pattern. This was skipped after reading the actual bodies of both tools:

1. **Neither function has a hook point today.** `evolve-agent` (L3072-3133) is an on-demand analyzer that calls `CONTROL_PLANE.fetch(/api/v1/evolve/:agent/analyze)` and returns a report + proposals. `autoresearch` (L3135-3159) inserts a pending `eval_runs` row and returns the `run_id` — the actual iteration happens elsewhere. Neither has a "second-ask detected" signal to react to.
2. **The detector itself is Phase 6.5 scope**, deferred by design because the heuristic (exact match vs embedding similarity vs tool-call pattern) needs real session-log calibration.
3. **The reference deploy→control-plane fetch pattern already exists** at `tools.ts:3088-3097`:
   ```ts
   const controlPlane = (env as any).CONTROL_PLANE;
   if (controlPlane) {
     const resp = await controlPlane.fetch(
       `https://internal/api/v1/skill/append-rule`,
       { method: "POST", headers: { ... }, body: JSON.stringify({ ... }) },
     );
     if (resp.ok) { ... }
   }
   ```
   When Phase 6.5 needs a caller, copy-pasting that 8-line snippet is the reference implementation. A dedicated client module adds indirection with zero payoff.
4. **The round-trip regression test (new commit 7)** runs in-process under vitest and imports `appendRule` directly from `control-plane/src/logic/skill-mutation`. No HTTP, no deploy-side client. Proves the full loop: failing eval → `appendRule` → `loadSkillOverlays` → `getSkillPrompt` merge → passing eval.
5. **Budget**: `tools.ts` is at **8078/8080** (2 lines headroom). Adding an `append-skill-rule` tool case would force a fixture bump on a file Phase 9 is explicitly trying to slash to 2500. That's the wrong direction.

**Phase 6.5 handoff note.** When wiring second-ask auto-fire:
- **Detection** (the heuristic itself) lives in a NEW file like `deploy/src/runtime/skill-feedback.ts`. Do **not** grow `skills.ts` — it is at **180/180** after commit 4, zero headroom. Any addition needs a `-fixture-bump` against `loc_budget.json`.
- **Routing** (calling `append_rule` from the detected hook) uses the `CONTROL_PLANE.fetch` pattern at `tools.ts:3088-3097` as the template. The control-plane RPC route to call is the new admin revert endpoint's sibling — add `POST /api/v1/skill/append-rule` at the same time if needed, or (easier) reuse the existing `manage_skills append_rule` tool via the meta-agent-chat loop.
- **Hook points** are `tools.ts:3072` (evolve-agent, after the analyzer returns with a failure_clusters field ≥ 3 occurrences of the same root cause) and `tools.ts:3135` (autoresearch, when a run repeats the same fix path it applied in a prior run within N days).

### Phase 6 validation at commit-4 handoff (main @ `7486598b`)

- **control-plane:** 749/749 tests green (was 726 pre-branch; +21 mutation unit tests + 2 schema assertions via `it.each`)
- **deploy:** 477/477 tests green (was 469; +8 Phase 6 skill tests), 18 benchmark skips unchanged
- **LoC budgets:** `skills.ts` 180/180 (at ceiling, no headroom — Phase 7 or later must fixture-bump), `tools.ts` 8078/8080 (unchanged, 2 lines headroom preserved for Phase 6.5)
- **Prompt budget:** `meta-agent-chat.ts` 31714/31714 unchanged (edits were in `logic/meta-agent-chat.ts`, budget measures `prompts/meta-agent-chat.ts`)
- **Phase 0/3/4 drift guards:** all green — 19 BUILTIN skill hashes unchanged (diarize + improve opt-in via `NON_BUILTIN_ALLOWLIST`), `formatSkillsPrompt([], plan)` snapshots byte-identical (Phase 6 only touched `getSkillPrompt`), phase-3 orphan allowlist updated

---

### Original Phase 6 plan (preserved for history)

**Status:** Phases 0, 1, 2, 3, 4, 5 ✅ done. **Resume at Phase 6.**

**What was done (Phase 5 — meta-agent composes skills):**

- **Skill catalog bundler for control-plane.** New script `control-plane/scripts/bundle-skill-catalog.mjs` reads every `skills/public/<name>/SKILL.md` frontmatter and emits `control-plane/src/lib/skill-catalog.generated.ts` with metadata only (name, description, when_to_use, min_plan, delegate_agent). Exports: `SKILL_CATALOG`, `SKILL_CATALOG_BY_NAME`, `SKILL_CATALOG_NAMES` (fast validation allowlist). Paired with `deploy/scripts/bundle-skills.mjs` — both read the same SKILL.md source of truth. Wired into control-plane `package.json` as `predev`/`predeploy`/`pretest` hooks.
- **CI skill-catalog freshness gate** added to `.github/workflows/ci.yml` control-plane job, mirroring the existing gate in the deploy job.
- **Tool schemas extended** (`control-plane/src/logic/meta-agent-chat.ts`):
  - `update_agent_config` gained `enabled_skills: string[]` property.
  - `create_sub_agent` gained `enabled_skills: string[]` property + the `system_prompt` description was tightened to "1-3 sentences. Prefer enabled_skills to load full workflows — don't duplicate skill bodies in prose here." + the `tools` description adds "Must be a superset of the enabled skills' allowed_tools".
- **Handler validation.** New `normalizeEnabledSkills(raw)` helper (exported) that:
  - coerces non-array input to empty
  - drops names not in `SKILL_CATALOG_NAMES`
  - de-dupes while preserving first-seen order
  - trims whitespace, skips empty strings
  - returns `{ valid, dropped }` so callers can surface warnings
  Both `update_agent_config` and `create_sub_agent` handlers call it and surface dropped names as a `warning` + `dropped_skills` field in the JSON response so the LLM sees its own mistake.
- **Prompt awareness** (`control-plane/src/prompts/meta-agent-chat.ts`):
  - Runtime-infrastructure "Skills" bullet expanded from "slash commands: /batch..." to "reusable markdown templates in skills/public/<name>/SKILL.md, activated via /slash commands. Agents opt in via config.enabled_skills; empty = all available."
  - New **Skill selection** section after Tool selection explaining enabled_skills semantics, unknown-name filtering, and the tool-superset invariant.
  - "My agent needs to delegate tasks" workflow rewritten to lead with the `enabled_skills: ["pdf"]` pattern rather than the old inline-prose pattern.
  - **prompt_budget.json ratcheted** 30795 → 31714 code units (+919). `-fixture-bump` label on the commit; `post_phase_5: 31714` added to phase_targets for audit trail. Phase 7 still targets 8000 (this addition is among the first blocks Phase 7 will extract to `skills/meta/`).
- **17 new tests** in `control-plane/test/meta-agent-chat.test.ts`:
  - 7 cases for `SKILL_CATALOG` shape (all 19 BUILTIN skills present, alphabetically sorted, min_plan ⇒ delegate_agent, delegate targets reference real skill-agents, etc.)
  - 8 cases for `normalizeEnabledSkills` (non-array input, known/unknown mix, de-dup, whitespace, coercion, skill-AGENT vs skill-name confusion)
  - 4 cases for tool schemas + prompt content (static source scans for `enabled_skills` property + anti-pattern nudges + Skill selection section)
- **`normalizeEnabledSkills` exported** from `meta-agent-chat.ts` so the test can exercise it directly without a dispatch harness.

**What's NOT in Phase 5 (deferred):**
- **Domain SKILL.md files for the 13 untouched skill-agents** (calendar-manager, email-drafter, expense-tracker, fitness-coach, flight-search, legal-assistant, meal-planner, news-briefing, shopping-assistant, smart-home, social-media-manager, translator, travel-planner). Authoring those is orthogonal to Phase 5's "teach the meta-agent about enabled_skills" goal. Natural parallel Phase 5.b work — each skill is 1-3 hours, 13 × that is a separate sprint. Track as `SKILL-LIBRARY-EXPANSION` when ready.
- **Fixture test for meta-agent prompt→enabled_skills fidelity** (Jaccard similarity on 20 prompts). The original plan wanted this as a Phase 5 exit item, but it requires either an LLM mock with canned outputs or a real model call — non-trivial scaffolding and high flake risk. Left for Phase 5 follow-up when we know the actual meta-agent model calibration.
- **Phase 4.5 (R2 per-agent bundles with version-pinning)** — still held for after Phase 6 when the learning loop needs the substrate.

**Validation at handoff:**
- 19/19 skill hashes match (byte-identity preserved — Phase 5 touched zero SKILL.md files).
- Phase 0 snapshot file untouched since `8e5710d`.
- LoC budgets: `skills.ts` 175/180 (5-line headroom), `tools.ts` 8080/8080, `reasoning-strategies.ts` 223/223, `intent-router.ts` 246/246, `permission-classifier.ts` 140/140.
- Prompt budget: `meta-agent-chat.ts` 31714/31714 (at ceiling, ratcheted in this phase).
- `deploy/test/refactor-phase4.test.ts`: tool-superset invariant 8/8 deduped agents still pass.
- `control-plane/test/meta-agent-chat.test.ts`: 17 new Phase 5 test cases alongside the existing suite.
- Both bundlers regenerate clean (`bundle-skills.mjs` and `bundle-skill-catalog.mjs` both write files with zero git diff).

**Pick up at Phase 6 — diarize + learning loop.** The article's central missing primitive: read multiple sources about one subject, write a structured profile (SAYS / ACTUALLY DOES / CHANGED / CONTRADICTIONS), wire the `/improve` loop to append learned rules back into SKILL.md via `manage_skills`.

Specific Phase 6 work items:
1. **Create `skills/public/diarize/SKILL.md`** with params `{SUBJECT, SOURCES, RUBRIC}`. Structured profile output. This creates the first SKILL.md with real `{{ARGS}}` parameters, so Phase 6 also validates the skill-as-method-call primitive end-to-end.
2. **Create `skills/public/improve/SKILL.md`** with params `{FEEDBACK_SOURCE, TARGET_SKILL}`. Diarizes mediocre responses → extracts patterns → appends rules to the target skill → bumps version.
3. **Add `skill_audit` table** — append-only log: `{id, skill, before_sha, after_sha, reason, agent_id, created_at}`. Migration in `control-plane/src/db/migrations/`.
4. **Wire `evolve-agent` and `autoresearch` tools** in `deploy/src/runtime/tools.ts` to call `manage_skills` when they detect a "second-ask" pattern. Append to the relevant SKILL.md, bump skill version, log audit row.
5. **Rate limit**: max 10 mutations / day / skill. Enforced in `manage_skills` RPC.
6. **Admin revert endpoint** — reads `before_sha` from audit, restores. Not exposed to agents, only to human admins.
7. **Round-trip regression test**: known-failing eval case → `/improve` → SKILL.md changed → eval passes.

**Phase 6 requires rebuilding the bundler + catalog when new SKILL.md files land**, so the existing `predev`/`pretest` hooks will cover it automatically. No new infrastructure needed — Phase 5 built the catalog pipeline; Phase 6 adds entries.

**Before touching Phase 6:**
1. Run `cd control-plane && npm test && cd ../deploy && pnpm test -- refactor-phase0 refactor-phase4 memory-tools skills` — must be green.
2. **Never modify the frontmatter schema or the bundler's trailing-newline trim logic** — both are load-bearing for byte-identity across 19 existing skills.
3. When adding skills to `skills/public/`, **do NOT add them to `BUILTIN_SKILL_ORDER`** unless you also plan to extend the Phase 0 hash fixture — new skills default to "bundled but not in BUILTIN" (same as `code-review` and `deep-research` on the `NON_BUILTIN_ALLOWLIST`). Agents can still reference them via `enabled_skills`; they just don't show up in `formatSkillsPrompt([], plan)` by default.
4. `tools.ts` has **zero LoC headroom** at 8080. Phase 6 tool additions (for `manage_skills`, rate limiter, audit log writer) need to live in a new file like `deploy/src/runtime/skill-mutation.ts`.
5. `meta-agent-chat.ts` has **zero code-unit headroom** at 31714. Any Phase 6 prompt additions need a `-fixture-bump` commit + a corresponding `_post_phase_6_note` in `prompt_budget.json`.
6. `normalizeEnabledSkills` is exported from `control-plane/src/logic/meta-agent-chat.ts` — Phase 6 can reuse it for `manage_skills` input validation.

---

## 1. Repo audit — where each article concept lives today

### 1.1 Skill files → partially present, badly inverted

**Fat-harness anti-pattern (the problem).** `deploy/src/runtime/skills.ts` is **3,626 lines** with a `BUILTIN_SKILLS: Skill[]` array hardcoded into the worker binary. Every entry has its full `prompt_template` as a TS template literal. Editing a skill requires a worker redeploy.

19 skills, at these line numbers:
- `batch` (L153), `review` (L319), `debug` (L441), `verify` (L606), `remember` (L770), `skillify` (L924), `schedule` (L966), `docs` (L1013), `research` (L1053), `report` (L1120), `design` (L1243), `chart` (L1496), `pdf` (L1718), `spreadsheet` (L1813), `analyze` (L2165), `website` (L2427), `game` (L2528), `docx` (L2987), `pptx` (L3345).

**Thin-skill directory (right idea, starved).** `skills/public/` contains exactly 2 live SKILL.md files: `code-review/` and `deep-research/`. The Python `SkillLoader` at `agentos/skills/loader.py` already parses frontmatter correctly and builds a prompt injection — but it is referenced only by tests and `agentos/skills/__init__.py`. No live code path calls it.

**Duplication tier 1 — skill-agents.** `agents/skill-agents/` has **20 specialist JSON configs** (app-builder, calendar-manager, data-analyst, deep-research, document-generator, email-drafter, expense-tracker, fitness-coach, flight-search, legal-assistant, meal-planner, news-briefing, pdf-specialist, research-analyst, shopping-assistant, smart-home, social-media-manager, translator, travel-planner). Each one inlines its skill body in the `system_prompt` field — the same content that lives in `BUILTIN_SKILLS`. Example: `agents/skill-agents/pdf-specialist.json:6` duplicates `skills.ts:1718` (`pdf` skill).

**Duplication tier 2 — agents root.** `agents/` has 15+ more agent configs (`orchestrator.json`, `personal-assistant.json`, `coordinator.json`, `code-reviewer.json`, `data-analyst.json`, `customer-support.json`, `research-assistant.json`, `my-assistant.json`, two `meta-playbook-v2/v3` pairs, `cleanup-meta-agent-meta-agent.json`, `dispatch-test-bot.json`). Same pattern: big `system_prompt` strings, giant `tools` arrays.

**Skill-as-method-call wiring exists but unused.** `deploy/src/runtime/skills.ts:141` already does `prompt.replace("{{ARGS}}", args)`. The primitive for the article's `/investigate <TARGET> <QUESTION> <DATASET>` pattern is in place — but no agent config uses it, no builder promotes it, and no SKILL.md parameterizes around it.

### 1.2 The harness → inverted fat

Article prescribes "about 200 lines of code, JSON in, text out." Current reality under `deploy/src/runtime/`:

| File | LoC | What it is |
|---|---:|---|
| `tools.ts` | **7,716** | 40 tool definitions in cost table; **119** `case` branches in executor |
| `skills.ts` | **3,626** | Loader + 19 inlined skill templates |
| `db.ts` | **2,390** | Harness reaches directly into SQL (violates "application owns data") |
| `codemode.ts` | **1,041** | V8 sandbox for user-authored code |
| `fast-agent.ts` | **838** | The actual model loop |
| `reasoning-strategies.ts` | **222** | Latent logic in TS (should be a skill) |
| `intent-router.ts` | **245** | Latent logic in TS (should be a skill) |
| `permission-classifier.ts` | **139** | Latent logic in TS (should be a skill) |

**Runtime total: 28,076 LoC across 60 TS files.** Article target: a few hundred lines of plumbing. 100× over budget.

**Tool sprawl.** Confirmed 30 agent JSON files contain `"tools": [...]` arrays. Sample counts:
- `agents/orchestrator.json` → 54 tools
- `agents/meta-playbook-v3-*.json` → 26 tools
- Article ceiling: ~10

**Dead Python tree.** `agentos/agent.py:482` raises `NotImplementedError("Python runtime removed. Use 'agentos deploy' ...")`, but the entire `agentos/tools/` tree (and its test suite) is still on disk and still imported by live code:

| File | LoC | Status |
|---|---:|---|
| `agentos/tools/builtins.py` | 1,951 | dead (raises via agent.py) |
| `agentos/tools/platform_tools.py` | 1,469 | dead |
| `agentos/tools/registry.py` | ~400 | dead, still imported by `agentos/builder.py:19` and `agentos/cli.py:1270` |
| `agentos/tools/executor.py` | ~200 | dead |
| `agentos/tools/mcp.py` | ~300 | dead |
| `agentos/tools/__init__.py` | ~50 | dead |
| `tests/test_builtin_tools.py` | ~600 | imports dead code (tombstoned) |
| `tests/test_tools.py` | ~300 | imports dead code (tombstoned) |
| `tests/test_orchestrator_tools.py` | ~600 | imports dead code (tombstoned) |
| `tests/test_teardown.py` | ~400 | imports dead code (tombstoned) |
| `tests/test_bug_fixes.py` | ~400 | imports dead code (tombstoned) |
| `tests/test_registry.py` | ~200 | imports dead code (tombstoned) |
| `agentos/cli.py` | 3,755 | L1270 imports `agentos.tools.registry` |
| `agentos/builder.py` | 515 | L19 imports `agentos.tools.registry` |

**Total dead weight:** ~8,500 lines of dead source + ~2,500 lines of tombstoned tests, still cluttering grep results and the codemap the meta-agent reads.

**Stale codemaps.** `data/codemap.json`, `data/demo-codemap.json`, `docs/codemap.dot`, `docs/codemap.svg` all reference `agentos/tools/*` — they need regeneration (or deletion) when the tree goes.

### 1.3 Resolvers → only half-implemented

**Good examples (already in repo).**
- `deploy/src/runtime/skills.ts:84` — `formatSkillsPrompt()` injects only `description + when_to_use` (~1 line/skill), defers full `prompt_template` to `getSkillPrompt()` on activation. This is the article's exact resolver pattern.
- `control-plane/src/prompts/meta-agent-chat.ts:261` — `RUNTIME_INFRASTRUCTURE_DOCS` with comment "injected on-demand… saves ~600 tokens per turn."
- `control-plane/src/prompts/meta-agent-chat.ts:310` — `TOOL_CATALOG_DOCS` with comment "saves ~1,800 tokens per turn."

Proof of concept works. Pattern is known.

**Bad examples (in the same file).**
- `control-plane/src/prompts/meta-agent-chat.ts` is 440 lines and the stated design principle at the top is **"Tool-comprehensive: document every tool the meta-agent has"** — the literal opposite of the article's thesis. Workflow sections, reasoning strategies, named workflows, 30+ tools are all inlined.
- `deploy/src/runtime/tools.ts:5706–5748` — a regex→tool keyword table classifying intent. This is a resolver masquerading as code; it should be a skill description field matched by the LLM.

**Untouched by resolver pattern today.**
- `reasoning-strategies.ts` (222 lines of branching heuristics) — should be `skills/meta/reason-*/SKILL.md` with a `description` index.
- `intent-router.ts` (245 lines of keyword classification) — same.
- `permission-classifier.ts` (139 lines of rule tables) — same.
- `connectors.ts` — long provider list that could be deferred.

### 1.4 Latent vs deterministic → blended in the wrong places

**Correctly deterministic (leave alone).** `rag-hybrid.ts`, `rag-rerank.ts`, `embeddings.ts`, `db.ts`, `pricing.ts`, `ssrf.ts`. These are the foundation layer — SQL, vector ops, safety gates. The article says these belong in the deterministic layer, and they do.

**Wrongly latent (in the harness, should be in skills).**
- `reasoning-strategies.ts` — picks how the model should think. That's a judgment task. Belongs in markdown the model reads.
- `intent-router.ts` — classifies user intent from keywords. The model is better at this than regex.
- `permission-classifier.ts` — rule table for "is this action dangerous?" The policy is stable (deterministic) but the classification is latent.
- `tools.ts:5706–5748` — regex→tool keyword classifier. Same problem.

**Missing capability.**
- **Diarization is absent.** No skill, tool, or code path reads multiple documents about one subject and writes a structured profile (`SAYS` / `ACTUALLY DOES` / `CHANGED` / `CONTRADICTIONS`). `rag-transforms.ts` chunks and summarizes single documents; it does not synthesize across sources. This is the article's central missing primitive, and it blocks the learning loop.

### 1.5 Builder is skill-blind

`agentos/builder.py` has **zero references to "skill"**. When a user runs `agentos create "build me a research agent"`, the builder:
1. Keyword-matches `TOOL_RECOMMENDATIONS` in `builder.py:166`.
2. Emits a giant tool-aware `system_prompt`.
3. Saves the result via `persistAgentPackage` at `control-plane/src/routes/agents.ts:1008`.

There is no path by which the meta-agent composes an agent from reusable skills. Every created agent is a unique prose blob.

---

## 2. Scorecard — article concept → today → target

| Concept | Today | Target |
|---|---|---|
| Harness LoC | 28,076 TS runtime + ~8,500 dead Python | `skills.ts ≤ 250`; dead Python deleted; `tools.ts ≤ 2,500` |
| Skill source-of-truth | TS template literals in `BUILTIN_SKILLS` | `skills/public/*/SKILL.md` on disk, bundled at build |
| Live SKILL.md files | 2 (code-review, deep-research) | ≥ 25 (19 extracted + diarize + improve + 4 meta/) |
| Skill duplication | Same body in `skills.ts` + 20 `skill-agents/*.json` | Single source; agent JSONs reference by name |
| Agent tool counts | orchestrator 54, meta-playbook 26, many 15–30 | All ≤ 10, most 3–8 |
| Meta-agent-chat prompt | 440 lines, ~6,000 tokens always-on | ≤ 2,000 tokens base + resolver-loaded sections |
| Resolver sites | 2 (runtime docs, tool catalog) | ≥ 6 (add workflows, reasoning, routing, connectors) |
| Skill-as-method-call | `{{ARGS}}` wired, no callers | At least 5 skills take parameters; builder promotes this |
| Diarization | Absent | `/diarize` skill + 1 real use (session analysis) |
| Learning loop | `evolve-agent` exists but can't edit SKILL.md | `/improve` rewrites SKILL.md files via `manage_skills` |
| Latent logic in TS | `reasoning-strategies`, `intent-router`, `permission-classifier`, `tools.ts:5706` | Moved to SKILL.md with resolver indices |
| Builder composes skills | No | `AgentConfig.enabled_skills`; builder emits both skills + tools |
| Median meta-agent turn cost | baseline | ↓ ≥ 30% (from prompt slimming alone) |

---

## 3. Invariants (never violated during the refactor)

1. **No dual-path shims.** Every extraction is one-way: delete the TS source in the same PR that adds the SKILL.md. CI proves the swap is byte-safe. If you're tempted to add a fallback, the test is wrong.
2. **Golden hashes gate every skill move.** Any byte drift in the concatenated prompt text that reaches the model fails CI. Updating a hash requires an explicit `-fixture-bump` commit label.
3. **Markdown is load-bearing.** `skills/public/*/SKILL.md` is the source of truth. The DB `skills` table is a cache populated from disk. The bundled `skills-manifest.generated.ts` is a build artifact.
4. **Harness never injects logic into skill bodies.** It loads `description + when_to_use` for indexing and fetches `prompt_template` on activation. No in-TS templating, no conditional surgery on markdown content.
5. **Eval pass-rate is the merge gate, not vibes.** Every PR runs the reference eval suite; any drop >2% on any agent blocks merge (the article's own threshold).
6. **Prototype mode.** No canary rollouts, no feature flags for flipping, no deprecation windows. When a phase is done, the old path is deleted. Rollback = `git revert`.
7. **LoC budgets are hard ceilings.** `skills.ts ≤ 250`, `meta-agent-chat.ts` base prompt ≤ 2,000 tokens, `tools.ts` non-growing. CI fails if exceeded.
8. **No new abstractions.** `SkillLoader`, `formatSkillsPrompt`, `manage_skills`, and the resolver pattern all already exist. The refactor connects wires; it does not invent primitives.

---

## 4. Phase sequence

### Phase 0 — Instrumentation & baselines

**Goal:** make drift detectable. Nothing touches code until baselines exist.

**Work items**
- [ ] Create `deploy/test/fixtures/skill_hashes.json` — SHA-256 of `name|description|when_to_use|prompt_template` for each of the 19 `BUILTIN_SKILLS` entries. Computed from `deploy/src/runtime/skills.ts:150–3626`.
- [ ] Create `deploy/test/runtime/skills-prompt-snapshot.test.ts` (vitest) — calls `formatSkillsPrompt(BUILTIN_SKILLS, plan)` for `basic | standard | premium`, asserts exact string equality against committed `.snap` files.
- [ ] Create `deploy/test/runtime/tool-catalog-snapshot.test.ts` — serializes the 40-tool cost-table names + the 119 `case` branch names from `tools.ts` into a sorted JSON manifest. Commit current manifest.
- [ ] Create `deploy/test/fixtures/prompt_budget.json` — measure token count of `control-plane/src/prompts/meta-agent-chat.ts` base prompt (with resolver stubs stripped). Commit current number as the budget ceiling.
- [ ] Create `deploy/test/fixtures/loc_budget.json` — current LoC of `deploy/src/runtime/skills.ts` (3,626), `tools.ts` (7,716), `control-plane/src/prompts/meta-agent-chat.ts` (440). Commit as upper bounds.
- [ ] Create `deploy/test/runtime/budgets.test.ts` — reads `loc_budget.json`, asserts current LoC ≤ ceiling.
- [ ] Optional (skip if cost-prohibitive): run `eval-agent` against `orchestrator`, `personal-assistant`, `deep-research`, `code-review`, `pdf-specialist` → commit `deploy/test/fixtures/eval_baseline.json`. If eval harness is not wired, note `TODO: wire eval gate` and proceed.
- [ ] Add `deploy/scripts/compute-skill-hashes.mjs` — reproducible script that reads `skills.ts` (or the manifest once it exists) and prints hashes. Used to update fixtures after intentional moves.

**Exit audit — "Baseline Sealed"**
- [ ] All fixtures committed.
- [ ] A deliberately-broken local edit to `skills.ts` (e.g. change one whitespace) fails `skills-prompt-snapshot.test.ts`. If it doesn't, the test is wrong — fix before proceeding.
- [ ] Budget tests pass at exactly the current LoC (off-by-one bugs caught here).
- [ ] `pnpm vitest run` green in `deploy/`.

**Rollback:** n/a (purely additive).

---

### Phase 1 — Dead-code sweep ✅ DONE (full Python nuke)

**Scope expanded twice mid-execution.** Final state: **the entire Python lineage has been deleted.** The repo is now pure TypeScript on Cloudflare Workers.

**First sweep:** delete `agentos/tools/`, `agentos/builder.py`, rewrite `agentos/cli.py` to codemap-stub, delete tombstoned tests, delete `scripts/showcase_cli_lifecycle.sh`. Net −25,756 lines.

**Second sweep (subdir audit):** delete 7 zero-ref `agentos/` subdirs (`a2a`, `config`, `dashboard`, `integrations`, `observability`, `security`, `issues`), plus `tests/test_issues.py`, the top-level `tools/` (14 stale JSON plugin defs), `docs/misc/portal-definitive-blueprint.md`, `docs/misc/WORKFLOW_ANALYSIS.md`, `archive/mvp_depricated-donotuse/` (~500 MB).

**Third sweep (full nuke):** delete `agentos/` entirely (including `analysis/codemap.py`), delete `tests/` entirely, delete `pyproject.toml`, `agentos.egg-info/`, `uv.lock`, delete the already-broken `Dockerfile` + `docker-compose.yml` (they referenced `agentos.api.app` which stopped existing long ago), delete `scripts/prod_check.sh` (pytest driver), delete `cli/src/commands/codemap.ts` (broken stub calling `/api/v1/codemap` which doesn't exist), delete stale `data/codemap.json` + `data/agent.db` + `data/rag_chunks.db` + `docs/codemap.dot` + `docs/codemap.svg`.

**Final Python surface:** zero. The repo has no `agentos` package, no `pyproject.toml`, no `Dockerfile`, no Python tests. Residual `python3` invocations in `scripts/*.sh` are stdlib-only JSON-parsing helpers in shell heredocs — they need the interpreter, not any package.

**Codemap decision.** The Python `agentos/analysis/codemap.py` was the only working codemap generator; its TS twin at `cli/src/commands/codemap.ts` was a thin stub calling a non-existent control-plane endpoint. Since `data/codemap.json` has zero live consumers in runtime/CLI/control-plane code, both sides were deleted.

**README.md truncated** from 845 lines to 133 lines — the bottom 700 lines described Python-era subsystems that no longer exist. Kept: title, quick start, architecture, CLI reference, subsystems, license.

**Validation post-nuke:**
- Python tests: N/A (deleted)
- Deploy tests: 414/414 green
- oneshots CLI: `tsc --noEmit` clean, smoke test updated
- Phase 0 drift guards: 10/10 green (the guards live in `deploy/test/`, not Python)

**Goal:** delete the entire `agentos/tools/` tree and its tombstoned tests. Refactor the two live imports (`builder.py`, `cli.py`) so they no longer depend on the dead tree.

**Pre-check**
- [ ] Confirm `agentos/agent.py:482` still raises `NotImplementedError`.
- [ ] `rg "from agentos\.tools|import agentos\.tools" -g '!*.md' -g '!data/codemap*' -g '!docs/codemap*'` returns only the files listed below.

**Work items**
- [ ] **Refactor `agentos/builder.py:19`.** Remove `from agentos.tools.registry import ToolRegistry`. Replace any `ToolRegistry` usage with a static tool name list read from a small JSON file (e.g. `agentos/tool_names.json`) that we can keep in sync with `deploy/src/runtime/tools.ts`. Alternative: hardcode the ~10 tool names the builder actually recommends, since the tool catalog will shrink in Phase 9 anyway.
- [ ] **Refactor `agentos/cli.py:1270`.** Same pattern — the import is in a CLI subcommand; if the subcommand is dead, delete it; if it's live, replace with a direct call to the TS control-plane.
- [ ] **Delete the Python tree:**
  - `agentos/tools/__init__.py`
  - `agentos/tools/builtins.py`
  - `agentos/tools/executor.py`
  - `agentos/tools/mcp.py`
  - `agentos/tools/platform_tools.py`
  - `agentos/tools/registry.py`
- [ ] **Delete tombstoned tests:**
  - `tests/test_builtin_tools.py`
  - `tests/test_tools.py`
  - `tests/test_orchestrator_tools.py`
  - `tests/test_registry.py`
  - Audit `tests/test_teardown.py` and `tests/test_bug_fixes.py` — they have *some* imports from `agentos.tools.builtins`; either delete those tests or stub them. If the rest of the file is still valuable, delete only the affected test cases.
- [ ] **Regenerate or delete codemaps.** `data/codemap.json`, `data/demo-codemap.json`, `docs/codemap.dot`, `docs/codemap.svg` all reference deleted files. If a regen script exists, run it; otherwise delete them — the meta-agent will just read files directly.
- [ ] Delete any other `agentos/` files that are only reachable from the dead tree (run a reachability scan from `agentos/agent.py`, `agentos/builder.py`, `agentos/skills/loader.py`, `agentos/defaults.py`, and the live parts of `cli.py`).

**Exit audit — "Dead Weight Removed"**
- [ ] `rg -n "agentos\.tools" -g '!*.md'` returns zero hits.
- [ ] `pytest` green.
- [ ] `ruff --select F401,F811` clean.
- [ ] `git diff --stat HEAD~1` shows ≥ 8,000 lines removed.
- [ ] `agentos create "test"` still works (builder smoke test).

**Rollback:** `git revert`.

---

### Phase 2 — Skill manifest pipeline + pilot extraction (3 skills) ✅ DONE

**Result:** bundler pipeline works end-to-end on `docs`, `remember`, `skillify`. `deploy/src/runtime/skills.ts` 3627 → 3403 lines (−224). All 19 golden hashes match, all 3 prompt snapshots unchanged, 414 deploy tests green, tsc clean. Drift detector verified by deliberate one-char break (caught + restored). Bundler wired into `predev`/`predeploy`/`pretest` so markdown → manifest stays auto-synced.

**Key design decision.** To preserve byte-identical snapshot output, the 3 pilot entries in `BUILTIN_SKILLS` are replaced with `BUNDLED_SKILLS_BY_NAME["<name>"]` references that retain their original array position. The bundler (`deploy/scripts/bundle-skills.mjs`) reads `skills/public/*/SKILL.md`, parses the same frontmatter schema `agentos/skills/loader.py` already uses, and emits `deploy/src/runtime/skills-manifest.generated.ts`. The body is trimmed by exactly one trailing newline to accommodate markdown convention while matching the TS template literal's original (newline-free) terminal byte.

**Goal:** prove the extraction pipeline end-to-end on the lowest-risk skills.

**Pilot choices:** `docs` (L1013), `remember` (L770), `skillify` (L924). Smallest templates, simplest parameters, used rarely.

**Work items**
- [ ] Create `deploy/scripts/bundle-skills.mjs` — reads `skills/public/**/SKILL.md`, parses frontmatter (`name`, `description`, `when_to_use`, `plan_tier`, optional `params`), extracts the body as `prompt_template`, emits `deploy/src/runtime/skills-manifest.generated.ts` that exports a typed `BUNDLED_SKILLS: Skill[]` constant.
- [ ] Wire `bundle-skills.mjs` into `deploy/package.json` scripts as `prebuild` and also in `dev`. Add `deploy/src/runtime/skills-manifest.generated.ts` to `.gitignore` OR commit it (prototype mode: **commit it** — simpler review, no build-time surprises).
- [ ] Create `skills/public/docs/SKILL.md`, `skills/public/remember/SKILL.md`, `skills/public/skillify/SKILL.md`. Copy the `name`, `description`, `when_to_use`, `prompt_template` fields verbatim from `skills.ts` into frontmatter + body. **Verbatim** — any whitespace or escape change fails the golden hash.
- [ ] Schema: use the same frontmatter shape `agentos/skills/loader.py` already parses so Python tooling and TS bundler read the same files.
- [ ] Refactor `deploy/src/runtime/skills.ts`:
  - `import { BUNDLED_SKILLS } from "./skills-manifest.generated";`
  - Remove the 3 extracted entries from `BUILTIN_SKILLS`.
  - Export combined list: `export const ALL_SKILLS = [...BUILTIN_SKILLS, ...BUNDLED_SKILLS];`
  - All call sites of `BUILTIN_SKILLS` now consume `ALL_SKILLS` (grep + replace).
- [ ] Regenerate `skill_hashes.json` for the 3 moved skills using `deploy/scripts/compute-skill-hashes.mjs`. The new hash (computed from the manifest) must equal the old hash (computed from `BUILTIN_SKILLS`). **Do not normalize the hashes to hide drift.** If they don't match, the markdown is wrong.
- [ ] `skills-prompt-snapshot.test.ts` must pass unchanged (the bytes reaching the model must be byte-identical).

**Exit audit — "Pilot Extraction Clean"**
- [ ] All golden hashes green (19 total: 16 from `BUILTIN_SKILLS`, 3 from manifest).
- [ ] Prompt snapshot tests green.
- [ ] `skills/public/` has 5 directories (2 pre-existing + 3 new).
- [ ] `skills.ts` LoC dropped by the expected amount (~400 lines). Verify budgets test.
- [ ] `pnpm wrangler dev` boots without error.
- [ ] Manual test: trigger the `docs` skill and confirm the prompt delivered to the model is identical to pre-refactor (capture via a logging hook, diff against a pre-recorded snapshot).

**Rollback:** `git revert`.

---

### Phase 3 — Extract the remaining 16 skills

**Goal:** finish the source-of-truth move. After this, `BUILTIN_SKILLS` no longer exists.

**Work items**
- [ ] Extract, one skill per commit (for easy revert): `batch`, `review`, `debug`, `verify`, `schedule`, `research`, `report`, `design`, `chart`, `pdf`, `spreadsheet`, `analyze`, `website`, `game`, `docx`, `pptx`.
- [ ] For each: write `skills/public/<name>/SKILL.md` → re-run `bundle-skills.mjs` → verify golden hash → remove entry from `BUILTIN_SKILLS`.
- [ ] After all 16: `BUILTIN_SKILLS = []` (or deleted entirely). `skills.ts` retains only: the `Skill` interface, `loadSkills()` (DB cache path), `formatSkillsPrompt()`, `getSkillPrompt()`, and the manifest import.
- [ ] Delete the now-dead `{{ARGS}}` substitution if the call path has moved — OR keep it and verify at least one SKILL.md uses `{{ARGS}}` in its body so the primitive stays exercised.
- [ ] Hard budget: `skills.ts ≤ 250 LoC`. Update `loc_budget.json`. CI fails if exceeded.

**Mid-phase drift check (after skill #8)**
- [ ] Re-run golden hash test against the *original* Phase-0 baseline, not the previous step.
- [ ] Compare `sum(len(SKILL.md bodies))` against `len(generated manifest body section)` — they must match within 1% (catches accidental double-loading).

**Exit audit — "Skills on Disk"**
- [ ] `skills/public/` has ≥ 21 directories.
- [ ] `rg "BUILTIN_SKILLS" deploy/src/` returns zero hits (or only an empty `const BUILTIN_SKILLS: Skill[] = [];` line — which should also be deleted).
- [ ] `deploy/src/runtime/skills.ts` ≤ 250 LoC.
- [ ] Prompt snapshot test still green — concatenated output byte-identical to Phase 0.
- [ ] All 19 golden hashes green.
- [ ] `pnpm wrangler dev` boots; `agentos create` smoke works.

**Rollback:** per-skill commit boundary means any single skill can be reverted without touching the others.

---

### Phase 4 — De-duplicate `agents/skill-agents/*.json`

**Goal:** the 20 skill-agents stop inlining skill bodies. They become thin pointers: `{ name, enabled_skills: ["pdf"], tools: [...], ... }`.

**Work items**
- [ ] Extend `AgentConfig` (Python side, `agentos/agent.py:44`) with `enabled_skills: list[str] = Field(default_factory=list)`. Default empty = backward-compatible.
- [ ] Extend the TS agent schema (wherever `agents/*.json` is parsed — likely `control-plane/src/routes/agents.ts`) with the same field.
- [ ] Extend `control-plane/src/routes/agents.ts:1008` `persistAgentPackage` to persist `enabled_skills`. Check if a DB column exists; if not, add a migration to `control-plane/migrations/`.
- [ ] Extend `deploy/src/runtime/fast-agent.ts` (or wherever the agent's system prompt is assembled) to:
  - Load `enabled_skills` for the running agent.
  - Intersect with tenant's plan-available skills.
  - Pass the subset into `formatSkillsPrompt()` so only those skills' `description + when_to_use` get injected.
  - On activation, `getSkillPrompt(name)` serves the body.
- [ ] Rewrite each of `agents/skill-agents/*.json`:
  - Remove the big `system_prompt` prose (keep only a 2-3 sentence role description).
  - Add `"enabled_skills": ["<name>"]` where `<name>` matches the SKILL.md.
  - Example: `agents/skill-agents/pdf-specialist.json` loses its ~150-line system_prompt, gains `"enabled_skills": ["pdf"]`.
- [ ] Do the same for root `agents/*.json` where the system prompt is obviously a skill body (e.g. `code-reviewer.json` → `enabled_skills: ["review"]`).
- [ ] Delete `agents/cleanup-meta-agent-meta-agent.json`, `agents/meta-playbook-smoke-*.json`, `agents/meta-playbook-v2-*.json`, `agents/meta-playbook-v3-*.json`, `agents/dispatch-test-bot.json` — these are session artifacts, not agents.

**Exit audit — "Skill-Agents Thin"**
- [ ] Every `agents/skill-agents/*.json` is ≤ 50 lines.
- [ ] No `agents/*.json` has a `system_prompt` longer than 500 chars (prose role only).
- [ ] `rg "You are a \w+ expert" agents/` returns only role headers, not full skill bodies.
- [ ] Launching `pdf-specialist` in dev produces a system prompt that includes the `pdf` skill body loaded via the resolver path.
- [ ] `agentos create` still works.

**Rollback:** `git revert` per file (each rewrite is one commit).

---

### Phase 5 — Meta-agent composes skills

**IMPORTANT CORRECTION (discovered mid-execution).** The original plan pointed this phase at `agentos/builder.py` (Python). That file has been deleted — it was vestigial CLI scaffolding replaced by the TypeScript CLI at `cli/` (`@oneshots/cli`) and the in-UI meta-agent. There are **two live meta-agent entry points**, both TypeScript:

1. **UI flow** — user opens the "Improve" panel, UI hits `/agents/:name/meta-chat` → `control-plane/src/logic/meta-agent-chat.ts` (3,095 lines) using the prompt from `control-plane/src/prompts/meta-agent-chat.ts`. Tools like `update_agent_config` / `create_sub_agent` write to Postgres via Hyperdrive.
2. **CLI flow** — user runs `oneshots create` → `cli/src/commands/create.ts` → `apiPost("/api/v1/agents", ...)` → control-plane → Postgres.

Phase 5 must teach **both** entry points about skills. That means updating `control-plane/src/logic/meta-agent-chat.ts`, `control-plane/src/prompts/meta-agent-chat.ts`, AND `cli/src/commands/create.ts` + any control-plane route the CLI calls. No Python involved.

**Goal:** the TS meta-agent emits agent configs with `enabled_skills` populated, and treats skills as first-class composition units alongside tools.

**Work items**
- [ ] **Add `enabled_skills` to the agent config schema.** Find where `agents` rows are written in `control-plane/src/routes/agents.ts` and the DB column — add `enabled_skills text[] NOT NULL DEFAULT '{}'` (migration in `control-plane/migrations/`). Default empty = backward-compatible.
- [ ] **Extend `create_sub_agent` tool** in `control-plane/src/logic/meta-agent-chat.ts` (around L549 where the schema is defined). Add `enabled_skills: { type: "array", items: { type: "string" } }` to the input schema.
- [ ] **Extend `update_agent_config` tool** (around L151 where the schema is defined) with the same field.
- [ ] **Teach the meta-agent system prompt** (`control-plane/src/prompts/meta-agent-chat.ts`) about skills as a first-class composition unit. Add a new resolver block `SKILL_CATALOG_DOCS` mirroring `TOOL_CATALOG_DOCS` (L310). For each SKILL.md, emit `name + description + when_to_use` — body deferred. Explicit instruction: "When a request matches a skill description, emit `enabled_skills: [<name>]` and **do not** rewrite the skill body as prose."
- [ ] **Validation in the tool handler.** Before persisting, check every skill name against the bundled manifest (`deploy/src/runtime/skills-manifest.generated.ts` from Phase 2). On mismatch, drop the unknown name and log a warning. **Never invent a skill.**
- [ ] **Wire `fast-agent.ts`** to load `enabled_skills` for the running agent, intersect with plan-available skills, and pass the subset into `formatSkillsPrompt()`.
- [ ] Create `deploy/test/fixtures/meta_agent_prompts.jsonl` — ~20 user prompts with expected skill sets:
  ```
  {"prompt": "build a PDF summarizer", "expected_skills": ["pdf", "analyze"]}
  {"prompt": "deep research on a topic", "expected_skills": ["research", "report"]}
  {"prompt": "review this PR", "expected_skills": ["review"]}
  ```
- [ ] Meta-agent fixture test: runs `create_sub_agent` via `meta-agent-chat.ts` logic on each prompt, asserts Jaccard similarity ≥ 0.7 vs. expected skill set. Use a stub LLM provider that returns canned outputs, or a real model if the budget allows.
- [ ] **Cut default tool counts in the meta-agent prompt's guidance.** Currently it says "pick 3-8 essential tools." Update to "pick 2-5 essential tools + skills for the rest" — since skills encapsulate complex workflows.

**Exit audit — "Meta-Agent Composes Skills"**
- [ ] Creating an agent via the UI emits a config with ≥ 2 skills and ≤ 8 tools.
- [ ] Meta-agent fixture test green.
- [ ] Inspecting a newly-created agent row in Postgres shows `enabled_skills` populated and `system_prompt` short.
- [ ] Running a fresh agent through `fast-agent.ts` correctly loads only its `enabled_skills` subset into the prompt.

**Rollback:** `git revert`. The DB column defaults to `{}` so pre-Phase-5 agents keep working.

---

### Phase 6 — Diarization + learning loop

**Goal:** add the missing cross-document synthesis primitive + close the self-improvement loop the article describes.

**Work items**
- [ ] **Create `skills/public/diarize/SKILL.md`** with frontmatter params `{SUBJECT, SOURCES, RUBRIC}`. Body:
  ```
  1. For each source in SOURCES, load via read-file / knowledge-search / view-session.
  2. Extract claims, actions, timestamps about SUBJECT.
  3. Build structured profile: SAYS / ACTUALLY DOES / CHANGED / CONTRADICTIONS.
  4. Cite every claim with source ID.
  5. Apply RUBRIC to flag gaps and disagreements.
  6. Write profile via store-knowledge under key subject:<SUBJECT>.
  ```
- [ ] **Create `skills/public/improve/SKILL.md`** with params `{FEEDBACK_SOURCE, TARGET_SKILL}`. Body:
  ```
  1. Load FEEDBACK_SOURCE (NPS, eval outputs, conversation quality).
  2. Diarize the "OK" (mediocre) responses — where the system almost worked but didn't.
  3. Extract patterns ≥ 3 occurrences.
  4. Propose rules as {when, then} pairs.
  5. Call manage_skills to append rules to TARGET_SKILL.md.
  6. Bump skill version.
  ```
- [ ] **Wire `tools.ts:2989` `evolve-agent` and `tools.ts:3052` `autoresearch`** to call `manage_skills` (existing RPC at `control-plane/src/logic/meta-agent-chat.ts:2547`) when they detect a "second-ask" pattern — same question asked twice, same fix applied twice. Append to the relevant SKILL.md, bump version.
- [ ] **Add `skill_audit` table** — append-only log: `{id, skill, before_sha, after_sha, reason, agent_id, created_at}`. Migration in `control-plane/migrations/`.
- [ ] **Rate limit.** Max 10 mutations / day / skill. Enforced in `manage_skills` RPC. Test: trip the limiter in a unit test.
- [ ] **Admin revert endpoint** for `manage_skills` — reads `before_sha` from audit, restores. Not exposed to agents, only to human admins.
- [ ] **Round-trip test:** take a known-failing eval case → run `/improve` against it → verify SKILL.md changed → re-run eval case → case passes. Commit this as a regression test.

**Exit audit — "Loop Closed"**
- [ ] `/diarize` runs end-to-end on a fixture of 3 sessions and produces a structured profile passing a JSON schema check.
- [ ] `evolve-agent`-triggered skill write creates a `skill_audit` row with a valid `before_sha` and `after_sha`.
- [ ] Round-trip test green.
- [ ] Rate-limit test green.

**Rollback:** `git revert` + `DELETE FROM skill_audit WHERE created_at >= <phase start>` to discard learned rules.

---

### Phase 6.6 — Gastown-inspired follow-ups (deferred)

**Origin.** Captured 2026-04-11 after a structural comparison against the gastown repo (Go CLI using Dolt as versioned SQL for multi-agent coordination — see `/Users/ishprasad/code/gastown`). Phase 6 independently reinvented ~80% of gastown's `DOLT_COMMIT`/`DOLT_RESET`/`before_sha` pattern for skill mutations. These three items are the residual value from that comparison that Phase 6 does **not** already capture. None are blocking; all are explicitly deferred until after Phase 6 is sealed (commits 6 + 7) and Phase 7's meta-prompt slimming is done. Phase 7 owns the ceiling on `meta-agent-chat.ts` tokens, so any addition here must not grow that file.

**Why not fold into Phase 6.5?** Phase 6.5 is scoped to the second-ask auto-fire detector (see Phase 6 progress block, L51-54). These three items are orthogonal — they feed the detector a reward signal, but they don't belong in the detector itself.

**Entry criteria**
- [ ] Phase 6 sealed (commits 6 + 7 on main, round-trip regression green).
- [ ] Phase 6.5 second-ask detector has landed and has ≥1 week of `skill_audit` rows to score against. Without real data, picking a scoring function is guessing.
- [ ] Phase 7 ceiling on `meta-agent-chat.ts` holds — nothing in this phase is allowed to grow that file.

#### Item 1 — `skill_audit_score` table (quality signal for mutations)

**The gap.** `skill_audit` records *that* a mutation happened, not *whether it was good*. The Phase 6.5 second-ask detector has no reward signal — it can propose rules but can't learn which past rules were bad ideas. Gastown's `stamps(quality, reliability, creativity)` is the shape to port, minus the federation dimension.

**Design decision owed before implementation.** What populates `quality`? Three candidates, pick exactly one:
1. **Eval delta** — run the reference eval suite before and after; score = `post - pre` on the affected skill. Pro: objective, reuses existing infra. Con: slow (eval is minutes), expensive.
2. **Second-ask frequency** — score = inverse frequency of the same question being asked again within N days after the rule landed. Pro: directly measures the thing we care about. Con: requires N days of latency, noisy for low-traffic skills.
3. **Human review signal** — admin thumbs-up/down on the audit row. Pro: fastest, highest-signal. Con: requires a reviewer UI and ongoing human time.

**Recommendation (tentative, re-decide at entry).** Start with (1) eval delta because the eval suite is the Phase 0 merge gate and already runs — scoring is then a query against existing eval_runs rows, not new infra. Fall back to (3) if eval coverage on the affected skill is thin.

**Work items (sketch, flesh out at entry)**
- [ ] Migration: `skill_audit_score(audit_id FK, score_type TEXT, quality REAL, reliability REAL, reason TEXT, scored_at TIMESTAMPTZ, scorer TEXT)`. One audit row may have multiple score rows (different score types, different scorers). `score_type` is one of `eval_delta | second_ask | human`.
- [ ] **Yearbook rule equivalent** — constraint that the agent that triggered the mutation (`skill_audit.agent_id`) cannot be the `scorer` on its own audit rows. This is gastown's "no self-stamping" constraint (`wl_stamp.go:295-310`) and it matters more than it looks: without it, a buggy `/improve` loop will score its own rules positively and self-reinforce.
- [ ] Scoring writer lives in `control-plane/src/logic/skill-scoring.ts` (NEW file — do NOT grow `skill-mutation.ts`).
- [ ] Phase 6.5 detector reads aggregated score per-skill before proposing a rule. Rule threshold: don't auto-propose if recent avg quality on that skill is below some floor.

**Non-goals**
- No multi-dimensional scoring at first. One `quality` float is enough. Add `reliability` / `creativity` later only if the one-dim signal turns out to be lossy.
- No leaderboard, no charsheet. Gastown surfaces scores in UI; we don't need to.

#### Item 2 — Diff-query tooling over `skill_audit` history

**The gap.** Gastown gets `DOLT_DIFF(from, to, 'skill_name')` for free as a SQL table function. AgentOS can answer "show me all mutations to skill X" with a linear `SELECT`, but can't answer "show me every mutation that changed a line containing 'reasoning'" without full content-diff in app code. This is a known limitation, not a bug.

**Decision:** accept the limitation. Do **not** adopt Dolt to solve it. Instead, if the need becomes real:
- [ ] Build a `skill_audit_diff` view (or `CALL get_skill_audit_diff(skill, from_id, to_id)` stored proc) that computes a line-level diff between `before_content` and `after_content` inside Postgres using `string_agg` tricks — ugly but contained.
- [ ] Surface it in the admin revert UI so a human can see "here's what this mutation changed" before hitting revert.

**Trigger to actually build this.** First time an admin needs to answer "what did `/improve` do last week to the research skill." Until that happens, leave it alone.

#### Item 3 — `skill_audit` compaction strategy

**The gap.** `skill_audit` is append-only with no TTL. At 10 mutations/day/skill × ~25 skills, that's ~91k rows/year — not scary, but grows unbounded, and `before_content`/`after_content` are unbounded TEXT columns. Gastown's compactor-dog (`dolt_flatten.go:149` + `dolt_rebase.go:162`) explicitly treats unbounded history as a bug. Ours will too, eventually.

**Decision:** needed before prod, not now. Queue as a pre-launch item under the "Known Issues" memory doc (already tracked there under "load testing pending").

**Work items (sketch)**
- [ ] Pick a retention window (90 days? Align with eval_runs retention.)
- [ ] Keep the most recent N rows per (skill, scorer) regardless of age, so revert always has *something* to fall back on.
- [ ] Don't delete audit rows that have non-null `skill_audit_score` rows attached — those are still feeding the learning loop.
- [ ] Scheduled compactor runs nightly (reuse existing cron worker infra — no new primitive).
- [ ] Compaction is idempotent and emits its own `skill_audit` row with `reason = 'compaction: retained <N> of <M>'` — gastown's commit-the-compaction pattern.

**Non-goals**
- No Dolt-style history rewrite (we're not rebasing commits, we're just deleting rows). The append-only discipline is only enforced for the retention window.

**Exit audit — "Gastown Follow-ups Closed" (per-item, not all-at-once)**
- [ ] Item 1: `skill_audit_score` rows populated by ≥1 scorer; Phase 6.5 detector reads them before proposing a rule; yearbook constraint in schema and tested.
- [ ] Item 2: deferred acceptance documented in `project_known_issues.md`; no code change.
- [ ] Item 3: compactor lands before first production user (hard gate).

**Rollback:** each item is its own migration + its own file; `git revert` per item. Score rows cascade-delete with audit rows.

---

### Phase 7 — Slim `meta-agent-chat.ts`

**Goal:** the meta-agent's own system prompt practices the architecture it preaches. Base prompt drops from ~6,000 tokens to ≤ 2,000.

**Work items**
- [ ] Inventory `control-plane/src/prompts/meta-agent-chat.ts:32–253`. Section-by-section, classify each block:
  - **Keep inline** (base prompt): role, cost rules, safety invariants, the activation resolver, output format schema.
  - **Extract to SKILL.md** (resolver-loaded): every named workflow, reasoning strategy, tool catalog listing, example sequence.
- [ ] Create `skills/meta/` directory for meta-agent-only skills. Candidates to extract:
  - `skills/meta/build-agent/SKILL.md`
  - `skills/meta/improve-agent/SKILL.md`
  - `skills/meta/debug-agent/SKILL.md`
  - `skills/meta/explain-architecture/SKILL.md`
  - `skills/meta/plan-refactor/SKILL.md`
  - `skills/meta/onboard-user/SKILL.md`
  - + one per named workflow in the current prompt
- [ ] Add new resolver block `WORKFLOWS_INDEX` mirroring `RUNTIME_INFRASTRUCTURE_DOCS` (L261) and `TOOL_CATALOG_DOCS` (L310). Injects name + description of each meta skill; body loads on activation.
- [ ] **Delete the stated design principle "document every tool the meta-agent has"** from the file header comment. Replace with "activate on demand via description match."
- [ ] Hard budget: base prompt ≤ 2,000 tokens. `budgets.test.ts` enforces.
- [ ] Measure median meta-agent turn cost before and after (capture from `read_observability`).

**Exit audit — "Meta-Agent Thin"**
- [ ] Base prompt token count ≤ 2,000 (was ~6,000).
- [ ] Every removed workflow exists as a `skills/meta/*/SKILL.md` referenced by `WORKFLOWS_INDEX`.
- [ ] `control-plane/src/prompts/meta-agent-chat.ts` ≤ 150 LoC.
- [ ] Median meta-agent turn cost ↓ ≥ 30%.
- [ ] Smoke test: create a fresh agent end-to-end via chat; verify behavior matches pre-refactor.

**Rollback:** `git revert`.

---

### Phase 8 — Move latent logic to skills

**Goal:** `reasoning-strategies.ts`, `intent-router.ts`, `permission-classifier.ts`, and the `tools.ts:5706–5748` keyword classifier stop living in TS. The *policy* stays deterministic; the *classification* moves to the model reading a skill.

**Work items**
- [ ] **`skills/meta/pick-reasoning/SKILL.md`** — content from `reasoning-strategies.ts`, reformatted as a decision guide: "When the task is X, use strategy Y because Z."
- [ ] **`skills/meta/route-intent/SKILL.md`** — content from `intent-router.ts` + `tools.ts:5706–5748`, as "When user says X, activate skill Y."
- [ ] **`skills/meta/classify-permission/SKILL.md`** — policy table from `permission-classifier.ts`. The rules stay deterministic; the *judgment* of "does this action match a rule" moves to the model.
- [ ] Update call sites in `fast-agent.ts` and `tools.ts` to activate the meta skill instead of calling the TS function. The resolver loads the skill body, the model reads it, the model makes the call.
- [ ] Delete the three TS files: `reasoning-strategies.ts`, `intent-router.ts`, `permission-classifier.ts`.
- [ ] Delete the keyword table in `tools.ts:5706–5748`.

**Exit audit — "Latent Work Lives in Markdown"**
- [ ] Three TS files gone (~606 LoC removed).
- [ ] `tools.ts:5706–5748` block removed.
- [ ] Eval pass-rate ≥ baseline on all reference agents. **This is the risky phase** — the model's classification must match or beat the keyword router. If it doesn't, the SKILL.md needs more examples, not a revert.
- [ ] Smoke: 5 representative user prompts route to the same tool/skill as before.

**Rollback:** `git revert` per file.

---

### Phase 9 — Tool consolidation (deferred)

**Goal:** collapse 40 tools → ~10 verbs. Highest blast radius; runs last.

**Entry criteria**
- All prior phases done.
- `orchestrator.json` and `personal-assistant.json` still pass eval.
- A config-rewriter script exists that can migrate every `agents/*.json` atomically.

**Work items**
- [ ] Introduce new verbs: `platform { resource, action }` (subsumes `manage-releases`, `manage-workflows`, `manage-rag`, `manage-secrets`, `manage-policies`, `manage-retention`, `manage-voice`, `manage-gpu`, `manage-projects`, `manage-mcp`).
- [ ] `codemode { mode }` subsumes the 6 `codemode-*` tools.
- [ ] `sql { query, args }` subsumes `db-query`, `db-batch`, `db-report`.
- [ ] Old tool names become thin aliases routing to new verbs. Mark them with a `deprecated: true` flag in the cost table.
- [ ] `agentos/builder.py` `TOOL_RECOMMENDATIONS` stops emitting deprecated names.
- [ ] **Config-rewriter script:** reads every `agents/*.json` + every persisted DB config, rewrites tool names to new verbs in one atomic transaction.
- [ ] After rewriter runs: delete the deprecated aliases and their handlers.

**Exit audit — "Verbs Only"**
- [ ] `tools.ts` ≤ 2,500 LoC.
- [ ] Cost table has ≤ 12 entries.
- [ ] No `agents/*.json` references a deprecated name.
- [ ] No DB config references a deprecated name (query the `agents` table).
- [ ] Eval pass-rate ≥ baseline.
- [ ] All reference agents have ≤ 10 tools.

**Rollback:** aliases remain until the final cleanup commit — until then, `git revert` restores old names. After the cleanup, recovery requires a DB snapshot.

---

## 5. Cross-cutting audits (run on every PR, every phase)

| Audit | What it checks | Fail condition |
|---|---|---|
| Golden skill hashes | `skill_hashes.json` | Any hash changes without matching `-fixture-bump` label |
| Prompt snapshot | `formatSkillsPrompt` output byte-identity | Bytes differ from committed snapshot |
| Tool catalog snapshot | Sorted tool-name manifest | Tool added/removed/renamed without `-tool-change` label |
| LoC budgets | `skills.ts`, `meta-agent-chat.ts`, `tools.ts` ceilings | Any file exceeds ceiling |
| Prompt token budget | `meta-agent-chat.ts` base prompt | Exceeds `prompt_budget.json` |
| Dead-code scan | `ruff F401/F811`, `tsc --noEmit` | New unused imports or dead exports |
| Skill audit trail | `skill_audit` rows | Mutation without `agent_id` or `before_sha` |
| No-shim rule | grep `BUILTIN_SKILLS` outside generated manifest | Any hit outside phase-in-flight |
| Builder fixture | `builder_prompts.jsonl` | Jaccard < 0.7 on any prompt |
| Eval pass-rate (if wired) | 5 reference agents | Any agent drops >2% vs. baseline |

---

## 6. Resolver-site inventory (exhaustive list of places to defer)

Goal: every doc-heavy block in the harness uses the `description + when_to_use` resolver pattern, with bodies loaded on demand.

**Already deferred (keep):**
- `control-plane/src/prompts/meta-agent-chat.ts:261` — `RUNTIME_INFRASTRUCTURE_DOCS`
- `control-plane/src/prompts/meta-agent-chat.ts:310` — `TOOL_CATALOG_DOCS`
- `deploy/src/runtime/skills.ts:84` — `formatSkillsPrompt` → `getSkillPrompt`

**To add:**
- `WORKFLOWS_INDEX` — Phase 7 (meta-agent workflows → `skills/meta/`)
- `REASONING_INDEX` — Phase 8 (`reasoning-strategies.ts` → `skills/meta/pick-reasoning`)
- `INTENT_INDEX` — Phase 8 (`intent-router.ts` + `tools.ts:5706` → `skills/meta/route-intent`)
- `PERMISSION_INDEX` — Phase 8 (`permission-classifier.ts` → `skills/meta/classify-permission`)
- `CONNECTOR_INDEX` — optional (`connectors.ts` provider list)
- `SKILL_AGENT_INDEX` — Phase 4 (each `agents/skill-agents/*.json` becomes discoverable by description, not name)

Each resolver injects ~1 line per entry. Bodies load on activation.

---

## 7. Anti-patterns to purge (checklist, with file:line)

| # | Pattern | Location | Fix |
|---|---|---|---|
| 1 | Skill body inlined in TS | `skills.ts:150–3626` | Extract to `skills/public/*/SKILL.md` (Phase 2–3) |
| 2 | Skill body duplicated in agent JSON | `agents/skill-agents/*.json` (20 files) | Replace with `enabled_skills` (Phase 4) |
| 3 | Dead Python tree imported by live code | `agentos/builder.py:19`, `agentos/cli.py:1270` | Delete tree, refactor imports (Phase 1) |
| 4 | Meta-prompt inlines everything | `meta-agent-chat.ts:32–253` | Resolver pattern (Phase 7) |
| 5 | Stated principle contradicts architecture | `meta-agent-chat.ts` header comment "document every tool" | Delete, replace (Phase 7) |
| 6 | Latent classification in TS | `reasoning-strategies.ts`, `intent-router.ts`, `permission-classifier.ts` | Move to `skills/meta/` (Phase 8) |
| 7 | Regex tool router | `tools.ts:5706–5748` | Model reads `skills/meta/route-intent` (Phase 8) |
| 8 | 40 tools in cost table, 119 `case` branches | `tools.ts` | Collapse to ~10 verbs (Phase 9) |
| 9 | Agent configs with 20–54 tools | `orchestrator.json`, `personal-assistant.json`, `meta-playbook-*.json` | Trim via builder + Phase 9 |
| 10 | Session artifacts checked in as agents | `agents/cleanup-meta-agent-*.json`, `meta-playbook-smoke-*.json` | Delete (Phase 4) |
| 11 | Stale codemaps referencing deleted files | `data/codemap.json`, `docs/codemap.dot/svg` | Regen or delete (Phase 1) |
| 12 | `{{ARGS}}` primitive unused | `skills.ts:141` | At least 5 SKILL.md files take params (Phase 2–6) |
| 13 | No diarization primitive | (absent) | Create `skills/public/diarize` (Phase 6) |
| 14 | Learning loop can't write skills | `evolve-agent`, `autoresearch` | Wire to `manage_skills` (Phase 6) |
| 15 | Builder ignores skills | `agentos/builder.py` (zero "skill" references) | Add `format_skill_catalog` (Phase 5) |

---

## 8. Definition of done (whole refactor)

**File-level:**
- [ ] `deploy/src/runtime/skills.ts` ≤ 250 LoC, no `BUILTIN_SKILLS`.
- [ ] `skills/public/` ≥ 21 directories, each with a SKILL.md ≤ 300 lines.
- [ ] `skills/meta/` ≥ 6 directories.
- [ ] `control-plane/src/prompts/meta-agent-chat.ts` ≤ 150 LoC; base prompt ≤ 2,000 tokens.
- [ ] `deploy/src/runtime/tools.ts` ≤ 2,500 LoC, cost table ≤ 12 entries.
- [ ] `agentos/tools/` directory does not exist.
- [ ] `reasoning-strategies.ts`, `intent-router.ts`, `permission-classifier.ts` do not exist.

**Behavior-level:**
- [ ] `agentos create "build a research agent"` → config with `enabled_skills` populated, ≤ 8 tools, ≤ 500-char system prompt.
- [ ] `/diarize` produces a structured profile from a set of sources.
- [ ] `/improve` writes rules back to a SKILL.md and the change appears in `skill_audit`.
- [ ] Failing eval case → `/improve` → passing eval case (the round-trip test).
- [ ] Every `agents/skill-agents/*.json` ≤ 50 lines.
- [ ] `orchestrator.json` has ≤ 10 tools and ≥ 3 skills.

**Metric-level:**
- [ ] Median meta-agent turn cost ↓ ≥ 30%.
- [ ] Eval pass-rate ≥ baseline on all 5 reference agents.
- [ ] Total LoC in `deploy/src/runtime/` ↓ ≥ 30% (target: 28k → ≤ 20k).
- [ ] Total LoC in `agentos/` ↓ ≥ 60% (target: dead Python gone).
- [ ] Golden hashes green across all phases.

**Invariant-level:**
- [ ] Zero `BUILTIN_SKILLS` hits in grep (except in the extraction commits themselves).
- [ ] Zero `agentos.tools` hits in grep.
- [ ] Zero inline skill bodies in `agents/*.json`.
- [ ] Zero shim paths (no "fall back to TS if markdown missing").

---

## 9. What this plan deliberately does not do

- **No new abstractions.** `SkillLoader`, `formatSkillsPrompt`, `manage_skills`, `{{ARGS}}`, and the resolver pattern all already exist. Connecting them, not inventing them.
- **No CLAUDE.md or architecture doc updates.** The SKILL.md files *are* the docs. If the meta-agent can read them, humans can too.
- **No big-bang PR.** Every phase is revertible. Even within Phase 3, every skill extraction is its own commit.
- **No production gates.** No canary, no feature flags, no deprecation windows. This is a prototype; rollback is `git revert`.
- **No tests for tests' sake.** The golden hash + prompt snapshot + budget tests are the minimum viable drift detection. No coverage targets.
- **No rewrites of working deterministic code.** `rag-hybrid.ts`, `rag-rerank.ts`, `embeddings.ts`, `db.ts`, `pricing.ts`, `ssrf.ts` stay untouched. They are correctly placed.

---

## 10. Execution order for a single greedy session

If pushing all the way through in one sitting (prototype mode, no user traffic):

1. **Phase 0** — write the golden hash + snapshot tests first. Don't skip; these catch every later mistake.
2. **Phase 1** — delete the Python tree. Biggest LoC win, zero risk, unblocks navigation.
3. **Phase 2** — pilot 3 skills. Proves the pipeline.
4. **Phase 3** — extract the other 16. Mechanical.
5. **Phase 4** — de-dupe skill-agents. Feels repetitive; do it now while the extraction is warm.
6. **Phase 5** — builder learns skills. Small change, high leverage.
7. **Phase 6** — diarize + improve loop. Additive, unlocks the article's learning loop.
8. **Phase 7** — slim the meta prompt. Biggest token-cost win.
9. **Phase 8** — move latent logic. Highest model-behavior risk; do last before tool consolidation.
10. **Phase 9** — tool consolidation. Only if there's time; skip for now if eval is tight.

Commits: one per sub-task, grouped by phase. Phases land as PRs (or a single branch, since no users).
