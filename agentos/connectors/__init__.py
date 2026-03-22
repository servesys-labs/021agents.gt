"""Connector Layer — plug into 3,000+ apps via MCP connector hubs.

Instead of building individual integrations for Slack, GitHub, Notion, etc.,
AgentOS connects to MCP connector providers (Pipedream, Nango, etc.) that
handle OAuth, credential storage, and API normalization.

Usage:
    from agentos.connectors import ConnectorHub

    hub = ConnectorHub(
        provider="pipedream",
        project_id="proj_xxx",
        client_id="...",
        client_secret="...",
    )
    tools = await hub.list_tools(app="slack")
    result = await hub.call_tool("slack_send_message", {"channel": "#general", "text": "hello"})
"""

from agentos.connectors.hub import ConnectorHub, ConnectorProvider

__all__ = ["ConnectorHub", "ConnectorProvider"]
