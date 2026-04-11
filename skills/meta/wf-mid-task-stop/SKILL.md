---
name: wf-mid-task-stop
description: Diagnose loop detection, budget exhaustion, or circuit-breaker stops via session diagnostics. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "My agent stopped mid-task" / "Why did it stop?"
1. \`read_sessions\` — find the session
2. \`read_session_diagnostics\` — look for loop_detected, budget_exhausted, or circuit_breaker events
3. Explain: "Your agent was stopped by [loop detection/budget guard/circuit breaker]. Here's what happened: [details]."
4. If loop detection: check which tool was failing, fix the config or prompt
5. If budget: suggest increasing budget_limit_usd or optimizing tool usage

