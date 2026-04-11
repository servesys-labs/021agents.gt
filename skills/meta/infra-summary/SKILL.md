---
name: infra-summary
description: Runtime infrastructure summary for the meta-agent prompt — lists automatic safety features (circuit breakers, loop detection, context compression, etc.) with a pointer to read_session_diagnostics for detailed reference. Phase 7.6 extraction, no placeholders.
scope: meta
---
The runtime has automatic safety features you should know about when diagnosing issues:
- **Circuit breakers** — tools auto-pause after repeated failures. Use \`read_session_diagnostics\` to check.
- **Context compression** — long conversations auto-compact. Agents may "forget" early details.
- **Loop detection** — stops agents after 3 identical tool failures. Common cause of "agent stopped mid-task."
- **Abort hierarchy** — parallel tool failures cancel siblings. Explains "sibling_failed" errors.
- **Backpressure** — tool results >30KB truncated, >500KB aggregate progressively truncated.
- **Session limits** — per-org concurrent cap. "Session limit reached" if exceeded.
- **Progressive tool discovery** — runtime sends relevant tool subset, not all. Deferred tools available on demand.
- **SSRF protection** — blocks private IPs, metadata endpoints, non-HTTP protocols.
- **Feature flags** — concurrent_tools, context_compression, deferred_tool_loading (all on by default).
- **Cost tracking** — per-turn + pre-execution budget enforcement. Tools skipped if budget would be exceeded.
- **Skills** — reusable markdown templates in skills/public/<name>/SKILL.md, activated via /slash commands. Agents opt in via config.enabled_skills; empty = all available.

For detailed explanations of any feature, use \`read_session_diagnostics\` on a specific session or ask me to explain.

