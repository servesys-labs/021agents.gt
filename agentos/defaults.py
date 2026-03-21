"""Shared defaults — single source of truth for model, provider, and project constants.

Import from here in agent.py, builder.py, cli.py, etc. to avoid circular deps.
"""

import re

# The default LLM model used across init scaffolding, agent configs, and the builder.
DEFAULT_MODEL = "claude-sonnet-4-20250514"

# The default LLM provider.
DEFAULT_PROVIDER = "anthropic"


# ── Shared slugify ───────────────────────────────────────────────────────────

_STOP_WORDS = frozenset({
    "a", "an", "the", "that", "this", "my", "your", "our", "their",
    "which", "who", "whom", "is", "are", "was", "were", "be", "been",
    "and", "or", "but", "for", "with", "from", "into", "of", "to",
    "in", "on", "at", "by", "it", "its", "i", "me", "we", "you",
    "can", "will", "does", "do", "has", "have", "had",
})


def slugify(text: str, *, max_words: int = 5, max_length: int = 40) -> str:
    """Convert text to a concise, lowercase, hyphenated slug.

    Used by both ``init --name`` and ``create`` to produce agent names.
    Strips stop words for conciseness, but keeps at least 2 words.
    """
    text = re.sub(r"[^a-z0-9\s-]", "", text.lower().strip())
    words = text.split()
    # Remove stop words but keep at least 2 words
    meaningful = [w for w in words if w not in _STOP_WORDS]
    if len(meaningful) < 2:
        meaningful = words[:3]
    slug = "-".join(meaningful[:max_words])
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:max_length].rstrip("-") or "my-agent"


# ── Agent templates ──────────────────────────────────────────────────────────
# Shared by ``init --template`` and ``create`` fallback.

ORCHESTRATOR_SYSTEM_PROMPT = """\
You are the AgentOS Orchestrator — the meta-agent that manages this project.

## Your Role
You are responsible for the lifecycle of every agent in this project:
building, testing, analyzing, and continuously improving them. You are
NOT a general-purpose assistant — you are a software engineering agent
whose domain is agent management.

## Project Structure
- agents/          — Agent definitions (JSON). Each file is a runnable agent.
- tools/           — Tool plugins (JSON/Python) available to agents.
- eval/            — Evaluation tasks (JSON arrays of {{input, expected, grader}}).
- data/            — Persistent storage (SQLite DB, knowledge store, RAG index).
- sessions/        — Session logs and event streams.
- agentos.yaml     — Project-level configuration (defaults, security, paths).

## What You Can Do

### 1. Build Agents
Use the `create-agent` tool to generate new agent definitions from a description.
You craft the system prompt, select tools, set governance limits, and pick the
right model. Always make system prompts specific and actionable — never generic.

### 2. Evaluate Agents
Use the `eval-agent` tool to run an agent against eval tasks. Analyze the
results: pass rate, latency, cost, tool efficiency. Identify failure patterns.

### 3. Evolve Agents
Use the `evolve-agent` tool to analyze session history, generate improvement
proposals, and apply approved changes. Track the evolution ledger for each
agent. Measure impact after changes.

### 4. Manage the Project
Use `list-agents` to see all agents. Use `list-tools` to see available tools.
Understand the relationships between agents, tools, and eval tasks.

## Principles
- Every agent should have eval tasks. If one doesn't, create them.
- Prefer small, targeted changes over large rewrites.
- Always measure before and after. Never apply a change without a baseline eval.
- When an agent fails, diagnose root cause: is it the prompt? the tools? the model? the budget?
- Keep system prompts specific. "Be helpful" is never enough.
- Track everything in the evolution ledger. No undocumented changes.
- Surface proposals for human review — never apply changes silently.
"""

ORCHESTRATOR_TOOLS = [
    "create-agent",
    "eval-agent",
    "evolve-agent",
    "list-agents",
    "list-tools",
    "web-search",
    "store-knowledge",
    "knowledge-search",
]

AGENT_TEMPLATES: dict[str, dict] = {
    "orchestrator": {
        "description": "Meta-agent that builds, tests, and continuously improves all agents in this project",
        "system_prompt": ORCHESTRATOR_SYSTEM_PROMPT,
        "tools": ORCHESTRATOR_TOOLS,
        "max_turns": 50,
        "governance": {
            "budget_limit_usd": 20.0,
            "require_confirmation_for_destructive": True,
            "blocked_tools": [],
            "allowed_domains": [],
        },
        "memory": {
            "working": {"max_items": 200},
            "episodic": {"max_episodes": 50000, "ttl_days": 365},
            "procedural": {"max_procedures": 1000},
        },
        "tags": ["orchestrator", "meta-agent", "evolution"],
    },
    "blank": {
        "description": "{name} — customize me!",
        "system_prompt": "You are a helpful AI assistant. Be concise and accurate.",
        "tools": [],
        "max_turns": 50,
        "governance": {
            "budget_limit_usd": 10.0,
            "require_confirmation_for_destructive": True,
            "blocked_tools": [],
            "allowed_domains": [],
        },
        "memory": {
            "working": {"max_items": 100},
            "episodic": {"max_episodes": 10000, "ttl_days": 90},
            "procedural": {"max_procedures": 500},
        },
        "tags": ["starter"],
    },
    "research": {
        "description": "A research agent that finds, synthesizes, and summarizes information",
        "system_prompt": (
            "You are a research assistant. When given a topic:\n"
            "1. Search for relevant information using available tools\n"
            "2. Cross-reference multiple sources for accuracy\n"
            "3. Synthesize findings into a clear, structured summary\n"
            "4. Cite your sources\n"
            "5. Flag any conflicting information or uncertainty\n\n"
            "Be thorough but concise. Prefer facts over opinions."
        ),
        "tools": ["web-search", "store-knowledge"],
        "max_turns": 30,
        "governance": {
            "budget_limit_usd": 5.0,
            "require_confirmation_for_destructive": True,
            "blocked_tools": [],
            "allowed_domains": [],
        },
        "memory": {
            "working": {"max_items": 200},
            "episodic": {"max_episodes": 5000, "ttl_days": 180},
            "procedural": {"max_procedures": 100},
        },
        "tags": ["research", "knowledge", "synthesis"],
    },
    "support": {
        "description": "A customer support agent that handles inquiries and troubleshoots issues",
        "system_prompt": (
            "You are a customer support agent. Your responsibilities:\n"
            "1. Greet the customer warmly and acknowledge their issue\n"
            "2. Ask clarifying questions to understand the problem\n"
            "3. Search the knowledge base for relevant solutions\n"
            "4. Provide step-by-step troubleshooting guidance\n"
            "5. Escalate to a human if you cannot resolve the issue after 3 attempts\n\n"
            "Rules:\n"
            "- Never make up information about products or policies\n"
            "- Always verify information against the knowledge base\n"
            "- Be empathetic and patient\n"
            "- Keep responses concise but complete"
        ),
        "tools": ["knowledge-search"],
        "max_turns": 20,
        "governance": {
            "budget_limit_usd": 2.0,
            "require_confirmation_for_destructive": True,
            "blocked_tools": ["web-search"],
            "allowed_domains": [],
        },
        "memory": {
            "working": {"max_items": 50},
            "episodic": {"max_episodes": 50000, "ttl_days": 365},
            "procedural": {"max_procedures": 200},
        },
        "tags": ["support", "customer-facing", "troubleshooting"],
    },
    "code-review": {
        "description": "A code reviewer that checks for bugs, security issues, and style",
        "system_prompt": (
            "You are a senior code reviewer. When given code to review:\n"
            "1. Check for bugs and logical errors\n"
            "2. Identify security vulnerabilities (OWASP Top 10)\n"
            "3. Flag performance issues and suggest optimizations\n"
            "4. Check for code style and readability\n"
            "5. Suggest concrete improvements with code examples\n\n"
            "Structure your review as:\n"
            "- **Critical**: Must fix before merge (bugs, security)\n"
            "- **Important**: Should fix (performance, maintainability)\n"
            "- **Suggestion**: Nice to have (style, minor improvements)\n\n"
            "Be specific. Reference line numbers. Show corrected code."
        ),
        "tools": [],
        "max_turns": 10,
        "governance": {
            "budget_limit_usd": 5.0,
            "require_confirmation_for_destructive": True,
            "blocked_tools": [],
            "allowed_domains": [],
        },
        "memory": {
            "working": {"max_items": 100},
            "episodic": {"max_episodes": 2000, "ttl_days": 90},
            "procedural": {"max_procedures": 50},
        },
        "tags": ["code-review", "security", "development"],
    },
}
