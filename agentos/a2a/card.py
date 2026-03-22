"""A2A Agent Card — describes agent capabilities for discovery.

Published at /.well-known/agent.json so other agents and systems
can discover what this agent can do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentSkill:
    """A capability the agent can perform."""
    id: str
    name: str
    description: str
    tags: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "name": self.name, "description": self.description}
        if self.tags:
            d["tags"] = self.tags
        if self.examples:
            d["examples"] = self.examples
        return d


@dataclass
class AgentCard:
    """A2A Agent Card — the public identity of an agent."""
    id: str
    name: str
    description: str
    version: str = "0.1.0"
    provider: dict[str, str] = field(default_factory=lambda: {"organization": "AgentOS"})
    capabilities: dict[str, bool] = field(default_factory=lambda: {
        "streaming": True,
        "pushNotifications": False,
        "multiTurn": True,
    })
    skills: list[AgentSkill] = field(default_factory=list)
    security_schemes: list[dict[str, Any]] = field(default_factory=list)
    interfaces: list[dict[str, Any]] = field(default_factory=list)
    url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "provider": self.provider,
            "capabilities": self.capabilities,
            "skills": [s.to_dict() for s in self.skills],
            "securitySchemes": self.security_schemes,
            "interfaces": self.interfaces,
            "url": self.url,
        }


def build_agent_card(config: Any, base_url: str = "") -> AgentCard:
    """Build an A2A Agent Card from an AgentConfig.

    Args:
        config: AgentConfig instance
        base_url: The URL where this agent is served (e.g., http://localhost:8340)
    """
    # Build skills from tools
    skills = []
    for i, tool in enumerate(config.tools):
        tool_name = tool if isinstance(tool, str) else tool.get("name", f"tool-{i}")
        skills.append(AgentSkill(
            id=f"{config.name}-{tool_name}",
            name=tool_name,
            description=f"Tool: {tool_name}",
            tags=[tool_name],
        ))

    # Add a primary skill for the agent itself
    skills.insert(0, AgentSkill(
        id=config.name,
        name=config.name,
        description=config.description,
        tags=config.tags if hasattr(config, "tags") else [],
    ))

    return AgentCard(
        id=config.agent_id or config.name,
        name=config.name,
        description=config.description,
        version=config.version,
        capabilities={
            "streaming": True,
            "pushNotifications": False,
            "multiTurn": True,
        },
        skills=skills,
        security_schemes=[{"type": "http", "scheme": "bearer"}],
        interfaces=[{
            "type": "jsonrpc",
            "url": f"{base_url}/a2a" if base_url else "/a2a",
        }],
        url=base_url,
    )
