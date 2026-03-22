"""A2A Client — invoke external A2A-compatible agents.

Enables AgentOS agents to discover and communicate with agents
built in any framework (LangChain, CrewAI, AutoGen, AWS Bedrock, etc.)
as long as they implement the A2A protocol.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class A2AClient:
    """Client for invoking external A2A agents."""

    def __init__(self, base_url: str, api_key: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._card: dict[str, Any] | None = None

    async def discover(self) -> dict[str, Any]:
        """Fetch the agent card from /.well-known/agent.json."""
        import httpx

        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{self.base_url}/.well-known/agent.json",
                headers=headers,
            )
            resp.raise_for_status()
            self._card = resp.json()
            return self._card

    async def send_message(
        self,
        text: str,
        agent_name: str = "",
        task_id: str = "",
    ) -> dict[str, Any]:
        """Send a message to the A2A agent and get a response.

        Args:
            text: The message text to send
            agent_name: Optional agent name (for multi-agent servers)
            task_id: Optional task ID to continue a conversation

        Returns:
            The task dict with status, messages, and artifacts.
        """
        import httpx

        if not task_id:
            task_id = uuid.uuid4().hex[:16]

        payload = {
            "jsonrpc": "2.0",
            "id": uuid.uuid4().hex[:8],
            "method": "SendMessage",
            "params": {
                "taskId": task_id,
                "message": {
                    "id": uuid.uuid4().hex[:16],
                    "role": "user",
                    "parts": [{"text": text}],
                },
            },
        }
        if agent_name:
            payload["params"]["agentName"] = agent_name

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        # Determine A2A endpoint — from card or default
        a2a_url = f"{self.base_url}/a2a"
        if self._card:
            for iface in self._card.get("interfaces", []):
                if iface.get("type") == "jsonrpc" and iface.get("url"):
                    a2a_url = iface["url"]
                    if not a2a_url.startswith("http"):
                        a2a_url = f"{self.base_url}{a2a_url}"
                    break

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(a2a_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        if "error" in data:
            raise RuntimeError(f"A2A error: {data['error'].get('message', data['error'])}")

        result = data.get("result", {})
        task = result.get("task", result)
        return task

    async def send_and_get_text(self, text: str, agent_name: str = "") -> str:
        """Send a message and return just the response text."""
        task = await self.send_message(text, agent_name=agent_name)
        messages = task.get("messages", [])
        for msg in reversed(messages):
            if msg.get("role") == "agent":
                parts = msg.get("parts", [])
                return "".join(p.get("text", "") for p in parts)
        # Try artifacts
        for artifact in task.get("artifacts", []):
            parts = artifact.get("parts", [])
            text_parts = [p.get("text", "") for p in parts]
            if any(text_parts):
                return "".join(text_parts)
        return ""
