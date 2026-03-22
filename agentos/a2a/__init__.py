"""A2A (Agent-to-Agent) protocol support for AgentOS.

Implements the Google/Linux Foundation A2A protocol for agent interoperability.
Agents can be discovered and invoked by external systems, and can invoke
external A2A agents.

See: https://a2a-protocol.org/latest/specification/
"""

from agentos.a2a.card import AgentCard, build_agent_card
from agentos.a2a.server import mount_a2a_routes
from agentos.a2a.client import A2AClient

__all__ = ["AgentCard", "build_agent_card", "mount_a2a_routes", "A2AClient"]
