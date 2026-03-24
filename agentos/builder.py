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
from agentos.defaults import DEFAULT_MODEL, slugify as _slugify
from agentos.llm.provider import LLMProvider, LLMResponse, StubProvider
from agentos.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

BUILDER_SYSTEM_PROMPT = """\
You are the AgentOS Agent Builder. Your job is to help users create AI agents
by understanding their requirements through conversation.

You will have a multi-turn conversation with the user. Your goal is to produce
a complete agent definition as a JSON object.

## What you need to determine:

1. **Purpose**: What should this agent do? (becomes the description)
2. **Personality**: How should it behave? Tone, style, constraints.
3. **Tools**: What capabilities does it need? Select from available tools below.
4. **Guardrails**: Budget limits, blocked actions, confirmation requirements.
5. **Name**: A short, lowercase, hyphenated identifier.

## Available tools (by category):

### Code & Execution
- **dynamic-exec**: Execute JavaScript/TypeScript in a secure Cloudflare Dynamic Worker sandbox (<10ms, isolated V8). \
Use console.log() for output. Preferred over bash/python-exec for computation, API calls, data transforms, and logic. \
The LLM should write JS/TS code — it is the most efficient and secure execution path.
- **bash**: Execute shell commands (ls, git, npm, etc.) — use only when shell is required (file ops, git, system commands)
- **python-exec**: Execute Python code — use only when Python-specific libraries are needed (pandas, numpy, ML)
- **read-file**: Read file contents with line numbers
- **write-file**: Create or overwrite files
- **edit-file**: Find-and-replace in files

### Search & Discovery
- **grep**: Search file contents by regex pattern
- **glob**: Find files by glob pattern (e.g., **/*.py)
- **web-search**: Search the web via DuckDuckGo
- **knowledge-search**: Search the local knowledge store

### Web Browsing (use in this order of preference)
- **web-crawl**: Crawl websites and return clean markdown. Fast, respects robots.txt, \
perfect for RAG ingestion. Use FIRST for any web content extraction.
- **browser-render**: Full headless browser (Puppeteer on Cloudflare edge). Use ONLY when \
web-crawl is blocked — for JS-heavy sites, auth-gated content, or anti-bot bypass. \
Supports: text extraction, screenshots, HTML capture, link discovery.
- **browse**: Basic HTTP fetch with text extraction. Cheapest fallback, no JS rendering.

### Data & APIs
- **http-request**: Make HTTP requests (GET, POST, PUT, DELETE)
- **browse**: Fetch web pages and extract text, HTML, or links
- **store-knowledge**: Store facts in semantic memory

### Multimodal (via GMI Cloud)
- **image-generate**: Generate images from text prompts (Nano Banana 2, Seedream, FLUX)
- **text-to-speech**: Convert text to speech (ElevenLabs, MiniMax TTS)
- **speech-to-text**: Transcribe audio files (Whisper large v3)

### External Integrations (3,000+ apps via Pipedream)
- **connector**: Call external apps — Slack, GitHub, Jira, Notion, Google Sheets, \
Linear, HubSpot, Gmail, Stripe, and 3,000+ more. OAuth is managed automatically.
  Example: connector(tool_name="slack-send-message", arguments={{"channel": "#alerts", "text": "Done"}})

### Planning & Management
- **todo**: Task list for planning and tracking work
- **run-agent**: Delegate a task to another agent within this project
- **a2a-send**: Send a message to an external A2A agent (LangChain, CrewAI, AWS Bedrock)
- **create-agent**: Create new agents
- **eval-agent**: Evaluate an agent with test cases
- **evolve-agent**: Analyze and improve an agent
- **list-agents**: List all agents in the project
- **list-tools**: List all available tools

## IMPORTANT — Tool-aware system prompts:

When you write the system_prompt for the agent, you MUST:
1. Tell the agent what tools it has and what each one does
2. Give specific instructions on WHEN and HOW to use each tool
3. Include examples of tool usage patterns for the agent's task
4. Tell the agent to plan with 'todo' before complex multi-step work

Example for a coding agent:
```
You have these tools: dynamic-exec, bash, read-file, write-file, edit-file, grep, glob, todo.

Workflow:
1. Use 'todo' to plan your tasks before starting
2. Use 'glob' and 'grep' to explore the codebase
3. Use 'read-file' to understand existing code
4. Use 'write-file' for new files, 'edit-file' for changes
5. Use 'dynamic-exec' to run JS/TS code for computation, data transforms, and API calls
6. Use 'bash' only when shell commands are needed (git, npm, file system)
7. Mark todo items complete as you finish them
```

## IMPORTANT — Code Execution Strategy:

When an agent needs to execute code (compute, transform data, call APIs, parse/format):
- **ALWAYS prefer 'dynamic-exec' with JavaScript/TypeScript** — runs in <10ms on Cloudflare edge, \
strongly isolated, costs almost nothing, and LLMs produce higher quality JS than any other language.
- **Use 'bash' only for shell operations** — git, npm, file system commands, system utilities.
- **Use 'python-exec' only when Python-specific libraries are required** — pandas, numpy, ML models.
- Never use python-exec or bash for tasks that JS can handle (string manipulation, JSON parsing, \
math, API calls, data filtering). JS is faster, cheaper, and more secure.

## Recommended tools by agent type:
{tool_recommendations}

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
  "system_prompt": "You are... (MUST reference tools and how to use them)",
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
- ALWAYS assign at least 'todo' for planning unless the agent is trivial
- For any agent that works with files/code, include file tools (read-file, write-file, edit-file, grep, glob)
- For agents that need to test or run things, include 'bash' and/or 'python-exec'
- For agents that fetch external data, include 'http-request' and/or 'web-search'
- For agents that delegate to other agents, include 'run-agent' and 'list-agents'
- Write a detailed system_prompt that references each tool by name and explains WHEN to use each
- Keep names lowercase with hyphens (no spaces or underscores)
- Be concise in conversation — don't over-explain
"""

# Tool recommendations by detected keywords in the description
TOOL_RECOMMENDATIONS: dict[str, list[str]] = {
    "code|program|develop|software|debug|fix|implement|refactor": [
        "dynamic-exec", "bash", "read-file", "write-file", "edit-file", "grep", "glob", "todo",
    ],
    "research|analyze|investigate|study|find|search": [
        "web-search", "web-crawl", "browser-render", "http-request", "dynamic-exec", "read-file", "grep", "glob", "store-knowledge", "todo",
    ],
    "data|csv|json|api|fetch|scrape|extract": [
        "dynamic-exec", "http-request", "web-crawl", "browser-render", "read-file", "write-file", "todo",
    ],
    "review|audit|check|inspect|quality": [
        "read-file", "grep", "glob", "dynamic-exec", "edit-file", "todo",
    ],
    "write|document|report|summarize|content": [
        "write-file", "read-file", "web-search", "browse", "todo",
    ],
    "devops|deploy|ci|docker|kubernetes|infra": [
        "bash", "read-file", "write-file", "edit-file", "grep", "glob", "http-request", "todo",
    ],
    "test|qa|verify|validate": [
        "dynamic-exec", "bash", "read-file", "grep", "glob", "todo",
    ],
    "manage|coordinate|delegate|orchestrate|project": [
        "run-agent", "create-agent", "list-agents", "eval-agent", "todo",
    ],
    "improve|evolve|optimize|self-improve|autoresearch|research loop|self-evolve": [
        "autoresearch", "eval-agent", "evolve-agent", "todo",
    ],
    "notify|alert|slack|jira|github|notion|email|integration": [
        "connector", "todo",
    ],
    "report|dashboard|spreadsheet|google|sheets": [
        "connector", "dynamic-exec", "write-file", "todo",
    ],
    "image|visual|picture|generate image|design|mockup": [
        "image-generate", "write-file", "todo",
    ],
    "voice|audio|speech|transcribe|tts|stt": [
        "text-to-speech", "speech-to-text", "read-file", "write-file", "todo",
    ],
}


def recommend_tools(description: str) -> list[str]:
    """Recommend tools based on keywords in the agent description."""
    import re
    desc_lower = description.lower()
    recommended: set[str] = set()
    for pattern, tools in TOOL_RECOMMENDATIONS.items():
        if re.search(pattern, desc_lower):
            recommended.update(tools)
    # Always include todo for non-trivial agents
    if recommended:
        recommended.add("todo")
    return sorted(recommended)


def format_tool_recommendations() -> str:
    """Format tool recommendations for the builder system prompt."""
    lines = []
    for pattern, tools in TOOL_RECOMMENDATIONS.items():
        keywords = pattern.replace("|", ", ")
        lines.append(f"- **{keywords}** agents → {', '.join(tools)}")
    return "\n".join(lines)


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
        return {
            "role": "system",
            "content": BUILDER_SYSTEM_PROMPT.format(
                tool_recommendations=format_tool_recommendations(),
                default_model=DEFAULT_MODEL,
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

        # Fallback: generate a sensible config from the description with auto-assigned tools
        name = _slugify(description)
        tools = recommend_tools(description)
        tool_section = ""
        if tools:
            tool_section = (
                f"\n\nYou have these tools available: {', '.join(tools)}.\n"
                "Use 'todo' to plan multi-step work. Use the right tool for each step."
            )
        self._result = AgentConfig(
            name=name,
            description=description,
            system_prompt=f"You are an AI assistant specialized in: {description}. "
            f"Be helpful, accurate, and concise.{tool_section}",
            tools=tools,
        )
        self._complete = True
        return self._result

    def save(self, directory: str | None = None) -> str:
        """Save the built agent config to disk. Returns the file path."""
        if self._result is None:
            raise RuntimeError("No agent config to save — builder not complete")
        path = save_agent_config(self._result, directory)
        return str(path)


