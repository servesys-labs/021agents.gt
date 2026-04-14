---
name: wf-cost-analysis
description: Query expensive turns and tool usage for the current agent and fix wasteful behavior. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "Why is this costing so much?" / "What is bash doing?"
1. \`run_query\` — Find the most expensive turns: \`SELECT t.turn_number, t.tool_calls, t.tool_results, t.cost_total_usd FROM turns t JOIN sessions s ON t.session_id = s.session_id WHERE s.agent_name = '{{AGENT_NAME}}' ORDER BY t.cost_total_usd DESC LIMIT 10\`
2. \`run_query\` — Analyze tool usage frequency: \`SELECT tool_calls, COUNT(*) as cnt, SUM(cost_total_usd) as total_cost FROM turns t JOIN sessions s ON t.session_id = s.session_id WHERE s.agent_name = '{{AGENT_NAME}}' GROUP BY tool_calls ORDER BY total_cost DESC LIMIT 20\`
3. Diagnose: explain what tools are being called unnecessarily, what commands are being run
4. \`update_agent_config\` — Fix the system prompt to stop the wasteful behavior

