---
name: wf-delegate
description: Create a sub-agent via create_sub_agent using enabled_skills, wire run-agent at the parent. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "My agent needs to delegate tasks"
1. \`create_sub_agent\` — for sub-agents that map to a known skill (pdf, research, chart, etc.), use \`enabled_skills: ["<name>"]\` + a 1-3 sentence \`system_prompt\` role + a \`tools\` array that supersets the skill's allowed_tools. Do NOT paste the skill's workflow into system_prompt.
2. Ensure parent agent has run-agent tool
3. Update parent's system prompt to mention the sub-agent: "For research tasks, delegate to the research_assistant agent using the run-agent tool."


