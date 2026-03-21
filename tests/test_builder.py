"""Tests for the AgentBuilder — the meta-agent that builds agents."""

import pytest

from agentos.builder import AgentBuilder, _extract_json, _slugify
from agentos.llm.provider import LLMResponse, StubProvider


class FakeBuilderProvider:
    """A fake LLM that simulates the builder conversation."""

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self._call_count = 0

    @property
    def model_id(self) -> str:
        return "fake-builder"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        idx = min(self._call_count, len(self._responses) - 1)
        content = self._responses[idx]
        self._call_count += 1
        return LLMResponse(content=content, model="fake-builder")


class TestExtractJson:
    def test_extract_from_code_block(self):
        text = 'Here is your agent:\n```json\n{"name": "test", "description": "A test"}\n```'
        result = _extract_json(text)
        assert result is not None
        assert result["name"] == "test"

    def test_extract_raw_json(self):
        text = 'Result: {"name": "raw", "description": "Raw JSON"}'
        result = _extract_json(text)
        assert result is not None
        assert result["name"] == "raw"

    def test_extract_no_json(self):
        text = "This is just plain text with no JSON"
        result = _extract_json(text)
        assert result is None


class TestSlugify:
    def test_basic(self):
        assert _slugify("My Cool Agent") == "cool-agent"

    def test_special_chars(self):
        assert _slugify("Agent #1 (test)!") == "agent-1-test"

    def test_empty(self):
        assert _slugify("") == "my-agent"

    def test_truncation(self):
        long = "a" * 100
        result = _slugify(long)
        assert len(result) <= 40
        assert not result.endswith("-")

    def test_strips_stop_words(self):
        result = _slugify("an email summarizer that reads my inbox and gives me a morning brief")
        assert result == "email-summarizer-reads-inbox-gives"
        assert "an" not in result.split("-")
        assert "that" not in result.split("-")
        assert "my" not in result.split("-")

    def test_no_trailing_dash(self):
        result = _slugify("a long description with many stop words that should be removed")
        assert not result.endswith("-")


class TestAgentBuilder:
    @pytest.mark.asyncio
    async def test_one_shot_with_json_response(self):
        provider = FakeBuilderProvider([
            '```json\n{"name": "support-bot", "description": "Customer support"}\n```'
        ])
        builder = AgentBuilder(provider=provider)
        config = await builder.build_from_description("customer support agent")
        assert config.name == "support-bot"
        assert builder.is_complete

    @pytest.mark.asyncio
    async def test_one_shot_fallback(self):
        """When LLM doesn't produce valid JSON, falls back to template."""
        provider = FakeBuilderProvider(["I need more information..."])
        builder = AgentBuilder(provider=provider)
        config = await builder.build_from_description("a research assistant")
        assert config.name is not None
        assert "research" in config.description.lower()
        assert builder.is_complete

    @pytest.mark.asyncio
    async def test_conversational_flow(self):
        provider = FakeBuilderProvider([
            "What kind of tasks should this agent handle?",
            '```json\n{"name": "task-bot", "description": "Handles tasks"}\n```',
        ])
        builder = AgentBuilder(provider=provider)

        response1 = await builder.start("I want a task management agent")
        assert not builder.is_complete
        assert "tasks" in response1.lower()

        response2 = await builder.step("It should manage my todo list and deadlines")
        assert builder.is_complete
        assert builder.result.name == "task-bot"

    @pytest.mark.asyncio
    async def test_save(self, tmp_path):
        provider = FakeBuilderProvider([
            '```json\n{"name": "saved-agent", "description": "Test"}\n```'
        ])
        builder = AgentBuilder(provider=provider)
        await builder.build_from_description("test agent")

        path = builder.save(str(tmp_path / "saved-agent.json"))
        assert "saved-agent" in path

    @pytest.mark.asyncio
    async def test_save_raises_if_not_complete(self):
        builder = AgentBuilder()
        with pytest.raises(RuntimeError):
            builder.save()

    @pytest.mark.asyncio
    async def test_start_completes_in_one_shot(self):
        """If the LLM produces a complete config on the first message, builder is done."""
        provider = FakeBuilderProvider([
            '```json\n{"name": "instant", "description": "Instant agent"}\n```'
        ])
        builder = AgentBuilder(provider=provider)
        await builder.start("Build me a quick agent")
        assert builder.is_complete
        assert builder.result.name == "instant"
