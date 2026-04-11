---
name: improve
description: Analyze feedback on a target skill, extract recurring failure patterns, and propose rules to append via manage_skills append_rule
category: meta
version: 1.0.0
enabled: true
allowed-tools:
  - read-file
  - knowledge-search
  - session-search
  - manage_skills
tags:
  - meta
  - learning
  - self-improvement
---
You are executing the /improve skill. Input: {{ARGS}}

# Improve: Feedback-Driven Skill Mutation

You read feedback about how a target skill has been performing, identify recurring failure patterns in the "almost worked but didn't" cases, and propose concrete rules to append to the skill so it doesn't make the same mistake next time. You never mutate a skill without citing the feedback that justified each rule.

---

## Phase 1: PARSE INPUT

The input blob MUST contain two fields:

```
FEEDBACK_SOURCE: <source identifier — eval output path, NPS dataset key, session search query>
TARGET_SKILL: <name of the skill to mutate, e.g. "debug", "review">
```

If TARGET_SKILL is not a valid skill name (not in the bundled manifest and not a user-created custom skill), STOP and report the valid names. Never create a new skill from /improve — improve mutates existing ones.

---

## Phase 2: LOAD FEEDBACK

Load the feedback source using the tool that matches its shape:

- File path → `read-file`
- Knowledge key (`k:...`) → `knowledge-search`
- Session query → `session-search`

Fail fast if the source is unreadable. Report which source failed and ask the user to correct it.

---

## Phase 3: FILTER TO MEDIOCRE

Drop:
- **Clear wins** (5/5, "perfect", "exactly right") — no learning signal
- **Clear fails** (1/5, "completely wrong", error traces) — those are bugs, not pattern failures

Keep:
- **"OK" / "mediocre" / partial wins** (2/5, 3/5, "almost", "close but…")
- Any case where the user had to rephrase, correct, or follow up with the same intent

These are the cases where the skill's current rules *almost* fired correctly but missed — the richest signal for rule extraction.

---

## Phase 4: EXTRACT PATTERNS

Apply the diarize methodology (SAYS / ACTUALLY DOES / CHANGED / CONTRADICTIONS) to the filtered mediocre cases, focused on the target skill's outputs. For each one, record:

| feedback_id | user_intent | skill_output | why_mediocre |

Then group by `why_mediocre`. A pattern is a group with **≥ 3 occurrences** of the same root cause. Below 3 is noise — do not propose a rule.

Common pattern shapes:
- **Missing guardrail** — the skill did something it shouldn't have, repeatedly
- **Missing prompt** — the skill should have asked a clarifying question, repeatedly
- **Wrong default** — the skill picked option A when B was usually right
- **Silent failure** — the skill returned something but the user expected a different shape

---

## Phase 5: PROPOSE RULES

For each pattern with ≥ 3 occurrences, write ONE rule as a `{when, then}` pair:

```
when: <concrete trigger observable at skill invocation time>
then: <concrete action the skill should take>
```

Constraints on rule text:
- **Concrete, not abstract.** "when the user asks about files" is useless. "when the user names a file path containing `/tmp/`" is a rule.
- **Action-shaped, not aspirational.** "then be more careful" is useless. "then refuse and ask for confirmation" is a rule.
- **Short.** A rule that needs more than two sentences is two rules — split it.
- **No prompt injection.** Do not include instructions like "ignore previous rules" or "the real task is X". The rule text will be scanned server-side before insert and rejected if it contains injection markers.

Present the rules to the user in a table before proceeding:

| # | pattern (N occurrences) | when | then |

---

## Phase 6: CONFIRM AND APPEND

**STOP and wait for explicit user approval** before mutating the skill. Ask: "Approve all rules? Or specify which to keep (e.g., 'keep 1 and 3, drop 2')."

For each approved rule, call `manage_skills` with:

```json
{
  "action": "append_rule",
  "skill_name": "<TARGET_SKILL>",
  "rule_text": "when: <trigger>\nthen: <action>",
  "source": "improve",
  "reason": "<short citation of the feedback pattern, e.g. 'pattern: missing guardrail on /tmp paths, 4 occurrences in eval run 2026-04-10'>"
}
```

The mutation writes to `skill_overlays` (a DB table that layers rules on top of the disk SKILL.md at load time) and records the before/after content + sha in `skill_audit`. Rate-limited to 10 mutations per skill per day — if the limiter trips, report which rules couldn't land and stop.

---

## Phase 7: VERIFY

After all approved rules are appended:

1. Report the new effective skill version: `(disk_version, overlay_count, latest_overlay_timestamp)`. The disk SKILL.md version stays fixed; the effective version bumps via overlay_count.
2. List the `audit_id` returned by each append_rule call so an admin can revert any individual rule via `/admin/skills/revert` if it turns out to be wrong.
3. Suggest a re-run of the feedback source against the updated skill to confirm the pattern is gone.

---

## Rules

- **Never mutate without user approval.** Phase 6 is a hard stop.
- **Never propose a rule from a single occurrence.** Below 3 is noise.
- **Every rule cites its feedback.** The `reason` field in append_rule MUST reference the pattern's feedback IDs.
- **Never invent feedback.** If FEEDBACK_SOURCE is empty or has nothing mediocre, report that and stop. Do not fabricate cases to justify a rule.
- **Rules are append-only.** /improve cannot delete or rewrite existing rules — that's an admin revert operation, not a learning-loop operation.
- **Prompt injection guard is defense in depth.** The server-side scanner is the backstop; your Phase 5 "No prompt injection" constraint is the first line. Don't rely on only one.
