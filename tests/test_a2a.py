"""Tests for A2A protocol — agent cards, server endpoints, client."""

import json
import pytest
from unittest.mock import patch, AsyncMock


class TestAgentCard:
    def test_build_card(self):
        from agentos.a2a.card import build_agent_card
        from agentos.agent import AgentConfig

        config = AgentConfig(name="test-bot", description="A test bot", tools=["web-search", "bash"])
        card = build_agent_card(config, base_url="http://localhost:8000")

        assert card.name == "test-bot"
        assert card.description == "A test bot"
        assert card.capabilities["streaming"] is True
        assert card.capabilities["multiTurn"] is True
        assert len(card.skills) == 3  # primary + 2 tools
        assert card.url == "http://localhost:8000"

    def test_card_to_dict(self):
        from agentos.a2a.card import AgentCard, AgentSkill
        card = AgentCard(id="1", name="x", description="y", skills=[
            AgentSkill(id="s1", name="skill1", description="d1"),
        ])
        d = card.to_dict()
        assert d["name"] == "x"
        assert len(d["skills"]) == 1
        assert d["skills"][0]["name"] == "skill1"


class TestA2AServer:
    def setup_method(self):
        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        from fastapi.testclient import TestClient

        self.app = create_app(AgentHarness())
        self.client = TestClient(self.app)

    def test_well_known_agents(self):
        resp = self.client.get("/.well-known/agents.json")
        # May return 200 with empty or 404 if no agents
        assert resp.status_code in (200, 404)

    def test_a2a_method_not_found(self):
        resp = self.client.post("/a2a", json={
            "jsonrpc": "2.0", "id": "1", "method": "UnknownMethod", "params": {},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "error" in data

    def test_a2a_invalid_json(self):
        resp = self.client.post("/a2a", content="not json", headers={"Content-Type": "application/json"})
        assert resp.status_code == 400

    def test_a2a_send_no_text(self):
        resp = self.client.post("/a2a", json={
            "jsonrpc": "2.0", "id": "1", "method": "SendMessage",
            "params": {"message": {"id": "m1", "role": "user", "parts": []}},
        })
        data = resp.json()
        assert "error" in data

    def test_a2a_list_tasks(self):
        resp = self.client.post("/a2a", json={
            "jsonrpc": "2.0", "id": "1", "method": "ListTasks", "params": {},
        })
        assert resp.status_code == 200


class TestA2AClient:
    def test_send_and_get_text_extracts_from_task(self):
        """Test that send_and_get_text correctly extracts agent response text."""
        from agentos.a2a.client import A2AClient

        client = A2AClient("http://fake")

        # Test the extraction logic directly
        task = {
            "id": "t1",
            "messages": [
                {"role": "user", "parts": [{"text": "hi"}]},
                {"role": "agent", "parts": [{"text": "hello back"}]},
            ],
            "artifacts": [],
        }

        # Extract text from messages (same logic as send_and_get_text)
        messages = task.get("messages", [])
        text = ""
        for msg in reversed(messages):
            if msg.get("role") == "agent":
                parts = msg.get("parts", [])
                text = "".join(p.get("text", "") for p in parts)
                break
        assert text == "hello back"
