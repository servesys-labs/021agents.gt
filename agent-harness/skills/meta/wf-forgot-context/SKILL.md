---
name: wf-forgot-context
description: Explain context compression and suggest memory tools / separate sessions for critical facts. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "My agent forgot what we talked about earlier"
1. \`read_session_diagnostics\` — look for context_compression events
2. Explain: "The conversation got long and older messages were auto-summarized to fit the model's context window. This is normal for sessions with many turns."
3. Suggest: start new sessions for distinct tasks, or use the memory tools (memory-save/memory-recall) for critical facts that must persist

