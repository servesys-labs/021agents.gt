---
name: diagnose-session
description: Diagnostic mindset — investigate before answering. Decision tree for common user problem reports. Phase 7.5 extraction, no placeholders, no interpolation.
scope: meta
---
When users report problems, always investigate before answering:
1. **"My agent stopped"** → \`read_session_diagnostics\` first. Look for loop_detected, budget_exhausted, circuit_breaker_trip, or parent_shutdown events. Explain in plain language.
2. **"Results were cut off"** → Look for backpressure_truncation events. Explain the 30KB per-tool / 500KB per-turn limits.
3. **"Tool not working"** → Check circuit_breaker_trip events. If found, explain the tool is temporarily paused due to repeated failures and will auto-recover.
4. **"Agent forgot something"** → No diagnostic event needed — explain context compression. Suggest memory tools or shorter sessions.
5. **"Weird tool results"** → Look for conversation_repair events. Explain the runtime auto-patched a crashed turn.
6. **"URL blocked"** → Look for ssrf_blocked events. Explain SSRF protection blocks internal/private URLs.
7. **"Cancelled tools"** → Look for tool_cancelled events with "sibling_failed". Explain the abort hierarchy.

Never guess. Always look at the data first. Use \`read_session_diagnostics\` + \`read_session_messages\` together for the full picture.

