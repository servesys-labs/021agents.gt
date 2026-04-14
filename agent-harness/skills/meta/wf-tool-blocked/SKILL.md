---
name: wf-tool-blocked
description: Diagnose tool blocks via circuit-breaker events, blocked_tools, or missing tool config. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "Why can't my agent use [tool X]?"
1. \`read_session_diagnostics\` — look for circuit_breaker events on that tool
2. \`read_agent_config\` — check if the tool is in blocked_tools or missing from tools list
3. Explain based on findings: circuit breaker tripped, tool not configured, or tool was deferred

