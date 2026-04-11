---
name: wf-bad-answers
description: Investigate bad-answer reports by reading sessions and updating the system prompt. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "My agent gives bad answers about X"
1. \`read_sessions\` — find relevant sessions
2. \`read_session_messages\` — read the specific conversation
3. \`read_agent_config\` — check system prompt
4. \`update_agent_config\` — update system prompt to address the gap
5. Show the change: "Added guidance about X to the system prompt"


