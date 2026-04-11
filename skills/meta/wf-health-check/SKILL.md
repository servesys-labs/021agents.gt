---
name: wf-health-check
description: Observability health check — error rate, latency, cost, sentiment, session trends. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "How is my agent doing?"
1. \`read_observability\` — check error rate, latency, cost over 24h and 7d
2. \`read_conversation_quality\` — check sentiment and resolution rates
3. \`read_sessions\` — see recent session count and channels
4. Summarize: health status, any concerning trends, recommended actions


