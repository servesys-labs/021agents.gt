---
name: wf-add-connector
description: Add an MCP connector (Slack, HubSpot, Jira, etc.) and ensure mcp-call is in the tool list. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "My agent needs to connect to Slack/HubSpot/Jira"
1. \`manage_connectors\` action="add" app="slack" — add the connector
2. Explain: "Added Slack connector. Your agent can now send/read messages via the mcp-call tool. OAuth will be prompted on first use."
3. Ensure mcp-call is in the agent's tool list


