---
name: wf-truncated-results
description: Explain backpressure / 30KB truncation and recommend more targeted queries. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "Why are my tool results cut off?"
1. \`read_session_diagnostics\` — look for backpressure events
2. Explain: "Tool results exceeding 30KB are auto-truncated. Very large results are stored in R2 with a preview. This prevents context overflow."
3. Suggest: have the agent use more targeted queries/searches instead of fetching entire pages


