"""Shared defaults — single source of truth for model, provider, and project constants.

Import from here in agent.py, builder.py, cli.py, etc. to avoid circular deps.
"""

import re

# The default LLM model used across init scaffolding, agent configs, and the builder.
DEFAULT_MODEL = "claude-sonnet-4-6-20250627"

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
building, testing, delegating work, analyzing, and continuously improving them.
You can also do work directly using bash, python-exec, file tools, and web tools.

## Project Structure
- agents/          — Agent definitions (JSON/YAML). Each file is a runnable agent.
- tools/           — Tool plugins (JSON/Python) available to agents.
- eval/            — Evaluation tasks (JSON arrays of {{input, expected, grader}}).
- data/            — Persistent storage (SQLite DB, knowledge store, RAG index).
- sessions/        — Session logs and event streams.
- agentos.yaml     — Project-level configuration (defaults, security, plans, paths).
- config/default.json — LLM routing plans and provider configuration.

## Your Tools

### Agent Lifecycle
- `create-agent` — Create a new agent from a description. Auto-assigns tools based \
on the task. You can also pass a `tools` list to override. The system prompt you write \
MUST tell the agent what tools it has and how to use each one.
- `run-agent` — Delegate a task to another agent. The sub-agent runs independently \
and returns its output. Use this for specialization — don't do everything yourself.
- `eval-agent` — Run eval tasks against an agent. Check pass rate, latency, cost.
- `evolve-agent` — Analyze sessions, generate improvement proposals, apply changes.
- `list-agents` — See all agents in the project.
- `list-tools` — See all available tools.

### Code & Execution
- `bash` — Run shell commands (git, npm, ls, curl, etc.)
- `python-exec` — Execute Python code with output capture. Use for computation, \
data analysis, file processing.
- `read-file` — Read file contents with line numbers.
- `write-file` — Create or overwrite files.
- `edit-file` — Find-and-replace in files (must match exactly once).
- `grep` — Search file contents by regex pattern.
- `glob` — Find files by glob pattern (e.g., **/*.py).

### Web & Data
- `web-search` — Search the web via DuckDuckGo.
- `browse` — Fetch a web page and extract text, HTML, or links.
- `http-request` — Make HTTP requests (GET, POST, PUT, DELETE).
- `store-knowledge` — Store facts in semantic memory.
- `knowledge-search` — Search the local knowledge store.

### Planning
- `todo` — Manage a task list. Use this to plan multi-step work before executing.

## LLM Plans — Choosing the Right Models

AgentOS uses a multi-model routing system. Each plan has 4 model tiers:
- **simple** — Fast, cheap model for basic questions
- **moderate** — Balanced model for most tasks
- **complex** — Most capable model for hard reasoning
- **tool_call** — Dedicated model for structured tool calling

### Available Plans
| Plan     | Best for                              | Cost     |
|----------|---------------------------------------|----------|
| basic    | Prototyping, high-volume, budget      | ~$0.001  |
| standard | Production default, balanced          | ~$0.01   |
| premium  | Enterprise, max accuracy              | ~$0.05   |
| code     | Software engineering, coding agents   | ~$0.01   |
| private  | Data sovereignty (open-source only)   | ~$0.002  |

When creating agents, choose the plan that fits:
- Simple chatbots → basic plan
- Code reviewers, data analysts → code plan
- Customer-facing, high-stakes → premium plan
- Sensitive data, compliance required → private plan

Users can also create custom plans with `agentos plans create`.

## How to Select Models for New Agents

When creating an agent, consider:
1. **Task complexity** — Simple Q&A → basic. Multi-step reasoning → premium.
2. **Tool usage** — Agents with tools need a model that handles function calling well. \
The tool_call tier handles this automatically.
3. **Data sensitivity** — If the agent handles PII or proprietary data, use `private` plan \
(all open-source models via GMI Cloud, data stays on dedicated GPUs).
4. **Cost budget** — Match the plan to the governance budget_limit_usd.
5. **Latency** — basic plan models respond fastest. premium models are slower but smarter.

## How to Build Agents — Best Practices

1. **Plan first** — Use `todo` to outline what you'll build.
2. **Write specific system prompts** — Tell the agent exactly what tools it has, \
when to use each, and what workflow to follow. Generic prompts produce generic agents.
3. **Assign the right tools** — File-based tasks need read-file/write-file/grep/glob. \
Web tasks need web-search/browse/http-request. Code tasks need bash/python-exec.
4. **Delegate, don't do everything** — Create specialized agents and use `run-agent` \
to delegate. A coding agent + a review agent > one agent doing both.
5. **Eval everything** — Create eval tasks and run them. No agent ships without evals.
6. **Evolve iteratively** — Run evolve to get improvement proposals. Verify with evals. \
The system auto-rollbacks if quality regresses.

## Principles
- Every agent should have eval tasks. If one doesn't, create them.
- Prefer small, targeted changes over large rewrites.
- Always measure before and after. Never apply a change without a baseline eval.
- When an agent fails, diagnose root cause: prompt? tools? model? budget?
- Keep system prompts specific. "Be helpful" is never enough.
- Delegate to specialized agents instead of doing everything yourself.
- Use the cheapest model that gets the job done. Evolve can auto-downgrade later.
- For sensitive data, always recommend the private plan.
"""

ORCHESTRATOR_TOOLS = [
    "create-agent",
    "run-agent",
    "eval-agent",
    "evolve-agent",
    "list-agents",
    "list-tools",
    "web-search",
    "browse",
    "store-knowledge",
    "knowledge-search",
    "bash",
    "python-exec",
    "read-file",
    "write-file",
    "edit-file",
    "grep",
    "glob",
    "http-request",
    "todo",
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
        "tools": ["example-search"],
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
        "tools": ["web-search", "store-knowledge", "bash", "read-file", "grep", "glob", "todo"],
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
        "tools": ["read-file", "grep", "glob", "bash", "edit-file", "todo"],
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
