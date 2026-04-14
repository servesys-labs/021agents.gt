---
name: plan
description: "Produce a structured `plan.v1` artifact before execution for complex tasks. Use when the task is multi-step, multi-file, build/deploy, migration, refactor, or explicitly asks for a plan or roadmap."
when_to_use: "When the task is complex, multi-step, multi-file, build/deploy, migration, refactor, or the user explicitly asks for a plan or roadmap before execution."
category: orchestration
version: 1.0.0
enabled: true
---
You are executing the /plan skill. Planning target: {{ARGS}}

# Plan: Structured Planning Artifact

For complex tasks, produce a visible checklist plus a machine-readable `plan.v1` artifact before any tool calls.

## Output Contract

1. Start with `## Plan` and a numbered checklist in plain text.
2. Then emit one fenced `json` block containing exactly one `plan.v1` object.
3. Do not call any tools until that artifact is present.
4. Keep the JSON concise, complete, and specific to the current task.

## plan.v1 schema

```json
{
  "schema_version": "plan.v1",
  "goal": "One-sentence goal.",
  "steps": [
    { "id": "1", "title": "First step", "acceptance": "Observable success condition." }
  ],
  "assumptions": ["Important assumption"],
  "alternatives": [
    { "option": "Alternative path", "rationale": "Why it was not chosen." }
  ],
  "tradeoffs": ["Important tradeoff"]
}
```

## Authoring Rules

- `goal` must be specific and scoped to the user's request.
- `steps` should be actionable and ordered; each step must include a concrete acceptance condition.
- `assumptions` should capture constraints, unknowns, or dependencies that matter to execution.
- `alternatives` should be real options considered, not filler.
- `tradeoffs` should describe meaningful costs or risks in the chosen approach.
- If the user asked for a plan only, stop after the checklist and JSON artifact.
- If the user also wants execution, emit the artifact first and wait until the next turn before using tools.
