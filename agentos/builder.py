"""AgentBuilder — a meta-agent that builds other agents via conversation.

When a user runs `agentos create`, this module drives a conversational flow
with an LLM to understand what the user wants and generate a complete agent
definition. It's an agent that builds agents.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from agentos.agent import AgentConfig, save_agent_config, AGENTS_DIR
from agentos.llm.provider import LLMProvider, LLMResponse, StubProvider
from agentos.tools.registry import ToolRegistry

# Default model used when generating agent definitions.
# Kept in sync with cli.DEFAULT_MODEL — imported here to avoid a circular dep.
DEFAULT_BUILDER_MODEL = "claude-sonnet-4-20250514"

logger = logging.getLogger(__name__)

BUILDER_SYSTEM_PROMPT = """\
You are the AgentOS Agent Builder. Your job is to help users create AI agents
by understanding their requirements through conversation.

You will have a multi-turn conversation with the user. Your goal is to produce
a complete agent definition as a JSON object.

## What you need to determine:

1. **Purpose**: What should this agent do? (becomes the description)
2. **Personality**: How should it behave? Tone, style, constraints.
3. **Tools**: What capabilities does it need? (web search, file access, APIs, etc.)
4. **Guardrails**: Budget limits, blocked actions, confirmation requirements.
5. **Name**: A short, lowercase, hyphenated identifier.

## Available tools in the registry:
{available_tools}

## Output format:

When you have enough information, output EXACTLY a JSON block wrapped in
```json
{{ ... }}
```

The JSON must conform to this schema:
```
{{
  "name": "my-agent",
  "description": "What this agent does",
  "system_prompt": "You are... (full system prompt for the agent)",
  "personality": "Brief personality description",
  "model": "{default_model}",
  "max_tokens": 4096,
  "temperature": 0.0,
  "tools": ["tool-name-1", "tool-name-2"],
  "governance": {{
    "budget_limit_usd": 10.0,
    "blocked_tools": [],
    "require_confirmation_for_destructive": true
  }},
  "max_turns": 50,
  "tags": ["tag1", "tag2"]
}}
```

## Rules:
- Ask clarifying questions if the user's request is vague
- Suggest tools from the available list when relevant
- Write a detailed, specific system_prompt tailored to the agent's purpose
- Keep names lowercase with hyphens (no spaces or underscores)
- Be concise in conversation — don't over-explain
- When the user confirms they're happy, output the final JSON
"""


def _extract_json(text: str) -> dict[str, Any] | None:
    """Extract a JSON object from LLM output (may be wrapped in ```json blocks)."""
    import re

    # Try to find ```json ... ``` block first (most reliable)
    match = re.search(r"```json\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Fallback: find outermost balanced braces using a simple brace counter.
    # This handles arbitrary nesting depth unlike the previous regex approach.
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    # This brace pair wasn't valid JSON — keep searching
                    next_start = text.find("{", start + 1)
                    if next_start == -1:
                        return None
                    # Restart from next opening brace
                    return _extract_json(text[next_start:])

    return None


class AgentBuilder:
    """Conversational agent builder powered by an LLM.

    Usage:
        builder = AgentBuilder(provider=my_llm)
        # Start the conversation
        response = await builder.start("I want an agent that does customer support")
        # Continue until we get a config
        while not builder.is_complete:
            user_input = input("> ")
            response = await builder.step(user_input)
        # Save the result
        path = builder.save()
    """

    def __init__(
        self,
        provider: LLMProvider | None = None,
        tools_dir: str | None = None,
    ) -> None:
        self._provider = provider or StubProvider()
        self._registry = ToolRegistry(tools_dir) if tools_dir else ToolRegistry()
        self._messages: list[dict[str, str]] = []
        self._result: AgentConfig | None = None
        self._complete = False

    @property
    def is_complete(self) -> bool:
        return self._complete

    @property
    def result(self) -> AgentConfig | None:
        return self._result

    def _system_message(self) -> dict[str, str]:
        available = self._registry.list_all()
        if available:
            tools_text = "\n".join(
                f"- **{t.name}**: {t.description}" for t in available
            )
        else:
            tools_text = "(No tools registered yet. The user can add tools later.)"

        return {
            "role": "system",
            "content": BUILDER_SYSTEM_PROMPT.format(
                available_tools=tools_text,
                default_model=DEFAULT_BUILDER_MODEL,
            ),
        }

    async def _call_llm(self) -> str:
        """Send current messages to the LLM and return the response."""
        messages = [self._system_message()] + self._messages
        response = await self._provider.complete(
            messages, max_tokens=4096, temperature=0.3
        )
        return response.content

    async def start(self, user_request: str) -> str:
        """Begin the agent building conversation with the user's initial request."""
        self._messages.append({"role": "user", "content": user_request})
        response = await self._call_llm()
        self._messages.append({"role": "assistant", "content": response})

        # Check if the LLM produced a complete config in one shot
        extracted = _extract_json(response)
        if extracted and "name" in extracted:
            self._result = AgentConfig.from_dict(extracted)
            self._complete = True

        return response

    async def step(self, user_input: str) -> str:
        """Continue the conversation with user input."""
        self._messages.append({"role": "user", "content": user_input})
        response = await self._call_llm()
        self._messages.append({"role": "assistant", "content": response})

        # Check if this response contains a complete config
        extracted = _extract_json(response)
        if extracted and "name" in extracted:
            self._result = AgentConfig.from_dict(extracted)
            self._complete = True

        return response

    async def build_from_description(self, description: str) -> AgentConfig:
        """One-shot: build an agent config from a description without conversation.

        Uses the LLM to generate a complete agent definition in a single call.
        Falls back to a template-based approach if LLM produces invalid output.
        """
        prompt = (
            f"Create a complete agent definition for the following request. "
            f"Output ONLY the JSON block, no conversation:\n\n{description}"
        )
        self._messages.append({"role": "user", "content": prompt})
        response = await self._call_llm()

        extracted = _extract_json(response)
        if extracted and "name" in extracted:
            self._result = AgentConfig.from_dict(extracted)
            self._complete = True
            return self._result

        # Fallback: generate a sensible config from the description
        name = _slugify(description)
        self._result = AgentConfig(
            name=name,
            description=description,
            system_prompt=f"You are an AI assistant specialized in: {description}. "
            "Be helpful, accurate, and concise.",
        )
        self._complete = True
        return self._result

    def save(self, directory: str | None = None) -> str:
        """Save the built agent config to disk. Returns the file path."""
        if self._result is None:
            raise RuntimeError("No agent config to save — builder not complete")
        path = save_agent_config(self._result, directory)
        return str(path)


_STOP_WORDS = frozenset({
    "a", "an", "the", "that", "this", "my", "your", "our", "their",
    "which", "who", "whom", "is", "are", "was", "were", "be", "been",
    "and", "or", "but", "for", "with", "from", "into", "of", "to",
    "in", "on", "at", "by", "it", "its", "i", "me", "we", "you",
    "can", "will", "does", "do", "has", "have", "had",
})


def _slugify(text: str) -> str:
    """Convert text to a concise, lowercase, hyphenated slug."""
    import re
    text = re.sub(r"[^a-z0-9\s-]", "", text.lower().strip())
    words = text.split()
    # Remove stop words but keep at least 2 words
    meaningful = [w for w in words if w not in _STOP_WORDS]
    if len(meaningful) < 2:
        meaningful = words[:3]
    slug = "-".join(meaningful[:5])  # Max 5 meaningful words
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:40].rstrip("-") or "my-agent"
