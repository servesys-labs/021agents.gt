# AgentOS — Agent Control Plane

Build, test, govern, deploy, and observe AI agents. The Vercel for agents.

**CLI + API + Portal** — one platform from local development to production SaaS.

| Metric | Count |
|--------|-------|
| API endpoints | 190+ across 35 routers |
| Builtin tools | 21 + 3,000+ via Pipedream |
| Portal pages | 22 (Refine + Tremor) |
| LLM plans | 6 (basic/standard/premium/code/dedicated/private) |
| Agent templates | 9 pre-built |
| Database tables | 39 (SQLite WAL) |
| Test suite | 597 tests |

## Quick Start

```bash
pip install -e ".[dev]"

# Initialize a new project
agentos init

# Set your LLM provider (GMI Cloud recommended — 41+ models, single API)
export GMI_API_KEY=gmi-...

# Create an agent via conversation with the meta-agent
agentos create

# Or create one in a single command
agentos create --one-shot "a research assistant that finds and summarizes papers"

# Run an agent
agentos run research-assistant "What are the latest advances in RLHF?"

# Interactive chat
agentos chat research-assistant

# Start the API server (190+ endpoints)
agentos serve

# Start the portal UI
cd portal && npm install --legacy-peer-deps && npm run dev
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Portal (React)                           │
│  Dashboard · Agents · Sessions · Eval · Sandbox · Governance    │
│  Memory · RAG · Billing · Integrations · API Explorer · ...     │
├─────────────────────────────────────────────────────────────────┤
│                     API Layer (FastAPI)                          │
│  35 routers · RBAC · Rate limiting · Stripe billing · A2A/MCP   │
├─────────────────────────────────────────────────────────────────┤
│                      Core Engine                                │
│  Harness · LLM Router · Middleware · Memory · Tools · Skills    │
├─────────────────────────────────────────────────────────────────┤
│                    LLM Providers                                │
│  GMI Cloud (primary) · Anthropic · OpenAI · Cloudflare · Local  │
├─────────────────────────────────────────────────────────────────┤
│                     Storage                                     │
│  SQLite (WAL) · 39 tables · Migrations v1-v5                   │
└─────────────────────────────────────────────────────────────────┘
```

### Subsystems

| Subsystem | Module | Description |
|-----------|--------|-------------|
| **Agent** | `agentos.agent` | Agent definition, loading, execution, plan-based routing |
| **Builder** | `agentos.builder` | Meta-agent that builds agents via LLM conversation |
| **CLI** | `agentos.cli` | 16 commands + 9 subcommands |
| **API** | `agentos.api` | 35 routers, 190+ endpoints, RBAC + scoped API keys |
| **Harness** | `agentos.core` | Orchestration, governance, event bus, middleware chain |
| **LLM Routing** | `agentos.llm` | Multi-provider routing by complexity (simple/moderate/complex/tool_call) |
| **Tools** | `agentos.tools` | 21 builtins + MCP client + plugin registry |
| **Connectors** | `agentos.connectors` | 3,000+ app integrations via Pipedream MCP |
| **Memory** | `agentos.memory` | Working, episodic, semantic, procedural + async updater |
| **Middleware** | `agentos.middleware` | Loop detection, context summarization, composable chain |
| **Skills** | `agentos.skills` | SKILL.md files with YAML frontmatter, injected into prompts |
| **A2A** | `agentos.a2a` | Google Agent-to-Agent protocol (discovery + JSON-RPC) |
| **Scheduler** | `agentos.scheduler` | Cron-based scheduled agent runs |
| **RAG** | `agentos.rag` | Hybrid retrieval (dense + BM25), chunking, reranking |
| **Eval** | `agentos.eval` | Benchmarking, LLM grading, evolution loop |
| **Sandbox** | `agentos.sandbox` | E2B cloud sandboxes with local fallback |
| **Voice** | `agentos.voice` | Real-time STT/TTS with barge-in support |
| **Auth** | `agentos.auth` | JWT + Clerk hybrid, RBAC (owner/admin/member/viewer) |
| **Deploy** | `deploy/` | Cloudflare Workers with Agents SDK |

## Agent Definition

An agent is a JSON/YAML file in `agents/`:

```json
{
  "name": "my-agent",
  "description": "What this agent does",
  "system_prompt": "You are a helpful assistant specialized in...",
  "model": "claude-sonnet-4-6-20250627",
  "tools": ["web-search", "read-file", "bash", "todo"],
  "plan": "standard",
  "temperature": 0.0,
  "max_tokens": 4096,
  "max_turns": 50,
  "timeout_seconds": 300,
  "governance": {
    "budget_limit_usd": 5.0,
    "require_confirmation_for_destructive": true
  },
  "harness": {
    "enable_loop_detection": true,
    "enable_summarization": true,
    "enable_skills": true,
    "enable_async_memory": false,
    "max_context_tokens": 100000,
    "retry_on_tool_failure": true,
    "max_retries": 3
  }
}
```

## LLM Plans

Each plan maps 4 complexity tiers (simple/moderate/complex/tool_call) to specific models. All plans route through GMI Cloud for unified billing and 41+ model access.

| Plan | Use Case | Simple | Complex |
|------|----------|--------|---------|
| **basic** | Budget-friendly | DeepSeek-V3.2 | Qwen3.5-397B |
| **standard** | Balanced (default) | DeepSeek-V3.2 | Claude Sonnet 4.6 |
| **premium** | Max quality | Claude Haiku 4.5 | Claude Opus 4.6 |
| **code** | Coding tasks | DeepSeek-V3.2 | Qwen3-Coder-480B |
| **dedicated** | Isolated GPU (H200) | DeepSeek-V3.2 | Qwen3.5-397B |
| **private** | Data sovereignty | DeepSeek-V3.2 | Qwen3.5-397B |

```bash
# List plans
agentos plans list

# Create a custom plan
agentos plans create
```

## Builtin Tools (21)

| Category | Tools |
|----------|-------|
| **Search & Browse** | `web-search`, `browse`, `http-request` |
| **File System** | `read-file`, `write-file`, `edit-file`, `grep`, `glob` |
| **Execution** | `bash`, `python-exec` |
| **Knowledge** | `store-knowledge`, `knowledge-search` |
| **Agent Ops** | `create-agent`, `run-agent`, `list-agents`, `list-tools`, `eval-agent`, `evolve-agent` |
| **Protocol** | `a2a-send`, `connector` |
| **Planning** | `todo` |

Plus **3,000+ app integrations** (Slack, GitHub, Jira, Gmail, Stripe, ...) via the Pipedream MCP connector with managed OAuth.

## Pre-built Templates

| Template | Tools | Plan | Use Case |
|----------|-------|------|----------|
| `orchestrator` | All 21 | premium | Meta-agent that coordinates everything |
| `research` | 9 | standard | Web research and summarization |
| `code-review` | 7 | code | Code analysis, bugs, security |
| `data-analyst` | 8 | code | Data processing and visualization |
| `devops` | 9 | standard | Infrastructure and deployment |
| `content-writer` | 7 | standard | Writing with web research |
| `project-manager` | 8 | standard | Multi-agent delegation |
| `support` | 1 | basic | Knowledge-base Q&A |
| `blank` | 5 | standard | Starter template |

## API Server

```bash
# CLI shorthand
agentos serve --port 8340

# Or directly
uvicorn agentos.api.app:create_app --factory --host 0.0.0.0 --port 8340
```

### Key Endpoint Groups (35 routers)

| Group | Prefix | Endpoints |
|-------|--------|-----------|
| Agents | `/api/v1/agents` | CRUD, run, stream, versions, clone, export/import |
| Sessions | `/api/v1/sessions` | List, detail, turns, traces, feedback, stats |
| Auth | `/api/v1/auth` | Login, signup, Clerk exchange, providers |
| Eval | `/api/v1/eval` | Runs, tasks, grading |
| Evolution | `/api/v1/evolve` | Proposals, ledger, apply |
| Billing | `/api/v1/billing` | Usage, invoices, daily breakdown |
| Stripe | `/api/v1/stripe_billing` | Checkout, portal, webhooks |
| Schedules | `/api/v1/schedules` | CRUD, enable/disable, history |
| Jobs | `/api/v1/jobs` | Enqueue, list, retry, cancel, DLQ |
| Workflows | `/api/v1/workflows` | DAG pipelines, execution runs |
| Sandbox | `/sandbox/*` | Create, exec, files, list, kill |
| Connectors | `/api/v1/connectors` | Pipedream apps, tools, OAuth |
| Memory | `/api/v1/memory` | Episodes, facts, procedures |
| RAG | `/api/v1/rag` | Ingest, status, documents |
| Observability | `/api/v1/observability` | Traces, cost ledger, stats |
| Governance | `/api/v1/policies` | Policy templates, SLOs |
| Audit | `/api/v1/audit` | Log, export with hash chain |
| Orgs | `/api/v1/orgs` | Organizations, members, roles |
| Projects | `/api/v1/projects` | Projects, environments |
| API Keys | `/api/v1/api_keys` | Scoped key management |
| Secrets | `/api/v1/secrets` | Org/project/env scoped vault |
| Releases | `/api/v1/releases` | Channels, canary splits |
| MCP | `/api/v1/mcp` | MCP server registry |
| Deploy | `/api/v1/deploy` | Deployment status |
| Plans | `/api/v1/plans` | List, create custom |
| A2A | `/.well-known/agent.json`, `/a2a` | Agent discovery + JSON-RPC |

### RBAC & API Keys

Role hierarchy: `owner > admin > member > viewer`

25+ granular scopes (e.g., `agents:read`, `agents:write`, `billing:read`, `secrets:manage`).

API keys use `ak_` prefix and are scoped to org/project/environment.

## Portal (Refine + Tremor)

22-page operator UI at `portal/`.

| Page | Description |
|------|-------------|
| Dashboard | System overview, metrics, recent activity |
| Agents | Agent CRUD, config viewer |
| Agent Chat | Interactive conversation with any agent |
| Sessions | Session history, turn detail, traces |
| Eval Runner | Run evaluations, view results |
| Evolution | Improvement proposals, ledger |
| Schedules | Cron schedule management |
| Webhooks | Event subscriptions, delivery history |
| Runtime | Workflows, job queue, DLQ |
| Sandbox Studio | Create/exec/files in E2B sandboxes |
| Integrations | Connectors, MCP servers, OAuth |
| Projects | Project and environment management |
| Releases | Release channels, canary splits |
| Memory | Episodes, facts, procedures browser |
| RAG | Document ingestion and status |
| Reliability | SLO management, A/B comparison |
| Infrastructure | GPU endpoints, retention policies |
| Governance | Policies, secrets, audit trail |
| Billing | Usage tracking, cost breakdown |
| API Explorer | OpenAPI-backed endpoint browser |
| Settings | API keys, org config |

```bash
cd portal
npm install --legacy-peer-deps
npm run dev
```

### Auth Modes

- **local** (default): email/password + AgentOS JWT
- **clerk**: Clerk-managed sign-in with backend token exchange

```bash
# Backend
export AGENTOS_AUTH_PROVIDER=local   # or clerk
export AGENTOS_CLERK_ISSUER="https://<your-clerk-issuer>"

# Portal (portal/.env.local)
VITE_AUTH_PROVIDER=local
VITE_CLERK_PUBLISHABLE_KEY=""
```

## Protocols

### A2A (Agent-to-Agent)

Google/Linux Foundation standard for agent interoperability. Agents are discoverable at `/.well-known/agent.json` and invocable via JSON-RPC at `/a2a`.

```bash
# Test A2A discovery
curl http://localhost:8340/.well-known/agent.json
```

### MCP (Model Context Protocol)

Expose agents as MCP tool servers for use in Claude Code, Cursor, or any MCP client.

```bash
agentos mcp-serve --agent research-assistant
```

## Middleware Chain

Composable hooks that wrap each LLM call:

- **Loop Detection** — warns at 3 repeated tool-call sets, hard stops at 5. Events persisted to DB.
- **Summarization** — compresses context when approaching token limit (75% threshold).

Both can be toggled per-agent via the `harness` config.

## Memory System

| Tier | Persistence | Purpose |
|------|-------------|---------|
| Working | In-memory | Current session context |
| Episodic | SQLite | Past interaction summaries |
| Semantic | SQLite | Extracted facts with keyword search |
| Procedural | SQLite | Learned tool sequences with success rates |
| Async | Background | Debounced fact extraction from conversations |

Procedural memory automatically learns from successful tool sequences and injects relevant procedures as hints in future prompts.

## Project Structure

```
agents/             # Agent definitions (JSON/YAML)
templates/          # 9 pre-built agent templates
tools/              # Custom tool plugins (JSON/Python)
skills/             # SKILL.md files injected into prompts
config/             # default.json — plans, routing, providers
data/               # SQLite DB + RAG documents
agentos/
  agent.py          # Agent class, AgentConfig, plan-based routing
  builder.py        # Meta-agent that builds agents
  cli.py            # 16 commands + 9 subcommands
  defaults.py       # Orchestrator prompt, templates, tool list
  scheduler.py      # Cron scheduling
  api/
    app.py          # FastAPI app, 35 routers, background workers
    deps.py         # Auth, RBAC, scoped API keys
    ratelimit.py    # Sliding window rate limiter (120 RPM)
    routers/        # 35 router files
    schemas.py      # Pydantic models
  core/
    harness.py      # Agent execution engine, middleware chain
    database.py     # SQLite WAL, 39 tables, migrations v1-v5
    governance.py   # Budget enforcement, policy checks
    events.py       # Event bus
  llm/
    router.py       # Complexity-based multi-provider routing
    provider.py     # HTTP provider (OpenAI-compatible)
    tokens.py       # Cost estimation for 50+ models
  tools/
    builtins.py     # 21 builtin tools with handlers + schemas
    executor.py     # Tool execution engine
    registry.py     # Plugin discovery
    mcp.py          # MCP client
  connectors/
    hub.py          # Pipedream MCP (3,000+ apps)
  middleware/
    base.py         # MiddlewareChain, Middleware base class
    loop_detection.py
    summarization.py
  memory/
    manager.py      # Unified memory manager
    working.py      # Working memory
    episodic.py     # Episodic memory
    semantic.py     # Semantic facts
    procedural.py   # Learned procedures
    async_updater.py # Background fact extraction
  skills/
    loader.py       # SKILL.md discovery and prompt injection
  a2a/              # A2A protocol (card, server, client)
  auth/             # JWT, Clerk, RBAC
  sandbox/          # E2B cloud + local fallback
  rag/              # Hybrid retrieval pipeline
  eval/             # Benchmarking and grading
  voice/            # STT/TTS
portal/             # React portal (Refine + Tremor)
deploy/             # Cloudflare Workers (Agents SDK)
tests/              # 597 tests
.github/workflows/  # CI (Python 3.12 + 3.13)
Dockerfile          # Self-hosted deployment
docker-compose.yml
```

## Environment Variables

```bash
# LLM Providers (at least one required)
GMI_API_KEY=gmi-...              # GMI Cloud (recommended — 41+ models)
ANTHROPIC_API_KEY=sk-ant-...     # Anthropic (direct)
OPENAI_API_KEY=sk-...            # OpenAI (direct)
CLOUDFLARE_API_TOKEN=...         # Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=...

# Sandbox
E2B_API_KEY=e2b_...              # E2B cloud sandboxes

# Connectors
PIPEDREAM_API_KEY=pd_...         # 3,000+ app integrations
PIPEDREAM_PROJECT_ID=proj_...
PIPEDREAM_CONNECT_TOKEN=...

# Auth
AGENTOS_AUTH_PROVIDER=local      # local or clerk
AGENTOS_JWT_SECRET=...           # Auto-generated if not set

# Billing
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Database
AGENTOS_DB_BACKEND=sqlite        # sqlite or postgres
DATABASE_URL=sqlite:///data/agent.db
```

## Deployment

### Cloudflare Workers

```bash
agentos deploy my-agent
cd deploy && npm run setup
```

### Docker

```bash
docker-compose up
```

### Self-Hosted

```bash
agentos serve --port 8340
```

## Production Preflight

```bash
# Quick pass
scripts/prod_check.sh --quick

# Full pass with smoke tests
scripts/prod_check.sh --smoke-url "https://<your-domain>" --token "$TOKEN"
```

## Programmatic Usage

```python
from agentos import Agent, AgentConfig

# From a template
agent = Agent.from_file("templates/research.json")
results = await agent.run("Summarize recent ML papers on alignment")

# From code
config = AgentConfig(
    name="quick-bot",
    system_prompt="You are a concise assistant.",
    tools=["web-search", "read-file", "todo"],
    plan="basic",
    harness={"enable_loop_detection": True, "max_retries": 5},
)
agent = Agent(config)
results = await agent.run("What's the weather today?")
```

## License

MIT
