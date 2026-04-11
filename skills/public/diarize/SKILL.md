---
name: diarize
description: Structured cross-source profile (SAYS / ACTUALLY DOES / CHANGED / CONTRADICTIONS) for one subject across multiple sources
category: analysis
version: 1.0.0
enabled: true
allowed-tools:
  - read-file
  - knowledge-search
  - session-search
  - store-knowledge
tags:
  - analysis
  - synthesis
  - meta
---
You are executing the /diarize skill. Input: {{ARGS}}

# Diarize: Cross-Source Profile Synthesis

You read multiple sources about one subject and produce a structured profile that separates what the subject SAYS from what it ACTUALLY DOES, tracks what has CHANGED over time, and surfaces CONTRADICTIONS between sources. Every claim is cited. You never invent or smooth over disagreements.

---

## Phase 1: PARSE INPUT

The input blob MUST contain three fields. Parse them from the input above:

```
SUBJECT: <entity — person, agent, process, concept>
SOURCES:
  - <source_id or path>
  - <source_id or path>
  - <source_id or path>
RUBRIC: <frame to apply, e.g. "leadership", "safety posture", "tool use">
```

If any field is missing or SOURCES has fewer than 2 entries, STOP and ask the user to supply it. Do not guess. Do not proceed with incomplete input.

---

## Phase 2: LOAD SOURCES

For each entry in SOURCES, load the content using the tool that matches its shape:

- File paths → `read-file`
- Knowledge keys (`k:...`) → `knowledge-search`
- Session IDs (`s:...`) → `session-search`

If a source fails to load, report which one and ask the user to correct it. Do not silently drop sources — a missing source changes what CHANGED and CONTRADICTIONS can mean.

---

## Phase 3: EXTRACT CLAIMS

From each loaded source, pull every claim, action, or timestamp that references SUBJECT. Record each as a tuple:

| source_id | timestamp | claim_type | text |

Claim types:
- **stated** — the subject (or narrator describing the subject) says it
- **did** — an observed action
- **promised** — a future commitment
- **denied** — an explicit refusal
- **observed_by_third_party** — someone else describes the subject's behavior

---

## Phase 4: BUILD STRUCTURED PROFILE

Produce exactly four sections:

### SAYS
What SUBJECT claims about itself. Every item cited with `[source_id]`.

### ACTUALLY DOES
Observed behavior, not self-reported. Every item cited.

### CHANGED
Deltas over time (earliest → latest). Only populate if two or more sources span different timestamps. Format: `from X [s1] → to Y [s2]`.

### CONTRADICTIONS
Pairs where SAYS disagrees with ACTUALLY DOES, or where sources disagree with each other. Quote BOTH sides with their citations. Never resolve the contradiction — surface it.

---

## Phase 5: APPLY RUBRIC

Read RUBRIC as a lens: "Viewed through this frame, what matters?" Produce two lists:

- **gaps** — rubric dimensions the sources are silent on
- **disagreements** — explicit contradictions that matter under this rubric

---

## Phase 6: PERSIST PROFILE

Call `store-knowledge` with:

- **key**: `subject:<SUBJECT_slug>` (lowercase, spaces → hyphens)
- **value**: the full profile as JSON matching this schema:

```json
{
  "subject": "<SUBJECT>",
  "rubric": "<RUBRIC>",
  "source_ids": ["<id1>", "<id2>", "<id3>"],
  "says": [{"claim": "<text>", "citations": ["<id>"]}],
  "actually_does": [{"observation": "<text>", "citations": ["<id>"]}],
  "changed": [{"from": "<text>", "to": "<text>", "citations": ["<id>", "<id>"]}],
  "contradictions": [{"says": "<text>", "does": "<text>", "citations": ["<id>", "<id>"]}],
  "rubric_flags": {"gaps": ["<dimension>"], "disagreements": ["<dimension>"]}
}
```

Report the key back to the caller so they can reference the profile later.

---

## Rules

- **Every claim cited** — no entry in any section without at least one `[source_id]` that you actually loaded in Phase 2.
- **Never merge sources silently** — if two sources disagree, it goes in CONTRADICTIONS, not in a smoothed-over single claim.
- **Never invent timestamps** — if a source doesn't have one, leave the timestamp column empty. Don't guess.
- **CHANGED and CONTRADICTIONS may be empty** — if SOURCES has only 2 entries and they agree, CHANGED is `[]` and that's correct. Don't pad.
- **Output is the JSON profile, not a narrative** — the downstream caller (e.g. /improve) parses it programmatically.
