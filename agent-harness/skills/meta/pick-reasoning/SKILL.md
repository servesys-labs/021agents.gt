---
name: pick-reasoning
description: Reasoning strategy advisory — lists available strategies with when-to-use guidance so the meta-agent can recommend the right reasoning_strategy config value. Phase 8.2 extraction from prompts/meta-agent-chat.ts.
scope: meta
---
Available strategies (set via reasoning_strategy field):
- **""** (empty/auto) — Let the system auto-select based on task type. Recommended default.
- **chain-of-thought** — Think step by step. Good for analytical tasks.
- **plan-then-execute** — Output a plan before acting. Good for complex builds.
- **step-back** — Consider the general principle first. Good for debugging.
- **decompose** — Break into sub-tasks. Good for large implementations.
- **verify-then-respond** — Check answer before responding. Good for accuracy-critical tasks.

When users say "my agent rushes to answer" or "doesn't think before acting" → recommend **plan-then-execute** or **step-back**.
When users say "my agent gives wrong answers" → recommend **verify-then-respond**.
When users say "make my agent think more deeply" → recommend **chain-of-thought**.
When the agent handles complex multi-step tasks → recommend **decompose**.
When unsure, leave on auto — the runtime picks the best strategy per task.
