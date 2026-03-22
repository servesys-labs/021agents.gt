# oneshots.co Architecture Analysis: User-Facing vs Agent-Internal

## The Vision

From README: "Build, test, govern, deploy, and observe AI agents. The Vercel for agents."
Positioning: "What E2B is for sandboxes, oneshots.co is for agents."

This is a **developer platform** — users are developers/teams who BUILD and DEPLOY agents.
They don't manually run sandboxes. They don't manually execute tools. They configure, deploy, monitor, and govern agents.

## Categorization of All 35 Routers

### TIER 1: Core User-Facing (Portal MUST have full CRUD)

| Router | Why User-Facing | Portal Needs |
|--------|----------------|--------------|
| **Agents** (17 endpoints) | THE core resource. Users create, configure, test, clone, export agents | Full CRUD + config editor + run/chat + clone + import/export |
| **Auth** (6 endpoints) | Login, signup, identity | Login page, profile settings |
| **Orgs** (7 endpoints) | Multi-tenant team management | Org switcher, member invite/remove/role change |
| **Projects** (5 endpoints) | Org → Project → Env hierarchy | Project CRUD, env management |
| **API Keys** (4 endpoints) | Developers need to create scoped keys | Create/revoke/rotate with scope picker |
| **Billing/Stripe** (10 endpoints) | Usage, invoices, plan management | Usage dashboard, plan upgrade, payment |
| **Schedules** (6 endpoints) | Users schedule agent runs via cron | Schedule CRUD with cron builder |
| **Webhooks** (5 endpoints) | Users subscribe to agent events | Webhook CRUD, delivery history |
| **Eval** (5 endpoints) | Users benchmark their agents | Run evals, view results, upload test sets |
| **Deploy** (2 endpoints) | Users deploy agents to production | Deploy button, status indicator |

### TIER 2: User-Facing Monitoring (Portal shows data, limited write)

| Router | Why Monitoring | Portal Needs |
|--------|---------------|--------------|
| **Sessions** (7 endpoints) | Users observe agent runs, debug failures | Session list, turn viewer, trace explorer |
| **Observability** (4 endpoints) | Traces, cost ledger, DB stats | Trace viewer, cost charts |
| **Memory** (8 endpoints) | Users inspect what agents learned | Read-only browser for episodes/facts/procedures, with clear option |
| **Workflows** (6 endpoints) | Users design multi-agent DAGs | Workflow builder (create), run viewer |
| **Jobs** (8 endpoints) | Users monitor async job queue | Job list, retry/cancel buttons, DLQ viewer |
| **Evolution** (5 endpoints) | Users review improvement proposals | Proposal list, approve/reject buttons |
| **Releases** (5 endpoints) | Users manage canary/rollout | Channel list, promote/rollback |

### TIER 3: Configuration (Portal exposes as settings)

| Router | Why Config | Portal Needs |
|--------|-----------|--------------|
| **Policies** (4 endpoints) | Governance policy templates | Policy CRUD (budget, blocked tools, etc.) |
| **Secrets** (4 endpoints) | Org/project/env scoped secrets | Secret CRUD (masked values) |
| **MCP Control** (5 endpoints) | Register external MCP servers | MCP server CRUD |
| **Connectors** (5 endpoints) | Pipedream OAuth apps | App browser, OAuth connect flow |
| **Plans** (3 endpoints) | Custom LLM routing plans | Plan viewer, custom plan creator |
| **Skills** (4 endpoints) | SKILL.md management | Skill list, upload |
| **Retention** (3 endpoints) | Data lifecycle policies | Retention policy settings |

### TIER 4: Agent-Internal Infrastructure (Portal should NOT expose as user actions)

| Router | Why Internal | Portal Treatment |
|--------|-------------|-----------------|
| **Sandbox** (7 endpoints) | Agents call sandboxes to execute code. Users don't manually spin up sandboxes. | Show as monitoring metric only ("X active sandboxes") — NOT a CRUD page |
| **GPU** (3 endpoints) | Dedicated GPU provisioning is infrastructure | Admin-only or hidden; show as infra status |
| **RAG** (3 endpoints) | Document ingestion is done via CLI/API, not portal clicks | Show ingest status, maybe file upload — but not a primary page |
| **Middleware** (2 endpoints) | Internal harness middleware stats | Hidden or under advanced observability |
| **Config** (2 endpoints) | System config dump | Hidden or admin-only |
| **Tools** (2 endpoints) | Tool listing for agents | Show as reference/docs, not interactive |
| **Compare** (1 endpoint) | A/B comparison utility | Could be under Eval |
| **A2A** (2 endpoints) | Agent discovery protocol | Not a portal page — it's a protocol endpoint |
| **Audit** (2 endpoints) | Audit log export | Under Governance as read-only log viewer |

## Key Insight: The Portal is an "Agent Control Plane"

The portal should feel like:
- **Vercel Dashboard** — deploy, monitor, configure
- **E2B Dashboard** — usage metrics, API keys, team management
- **Datadog** — observability, traces, cost tracking

It should NOT feel like:
- A sandbox terminal
- A code editor
- A raw API explorer

## Corrected Sidebar Structure

Based on the E2B reference + correct mental model:

**AGENTS** (the core)
- Agents (CRUD, config, run, chat, deploy)
- Templates (browse, create from template)

**RUNTIME** (what agents are doing)
- Sessions (live + historical)
- Workflows (DAG builder + runs)
- Jobs & Schedules (async queue + cron)

**INTELLIGENCE** (what agents know)
- Memory (episodes, facts, procedures — read + clear)
- Eval (run benchmarks, view results)
- Evolution (review proposals, approve/reject)

**INTEGRATION** (what agents connect to)
- Connectors (Pipedream apps, OAuth)
- MCP Servers (external tool servers)
- Webhooks (event subscriptions)

**TEAM** (org management)
- General (org settings)
- API Keys (scoped key management)
- Members (invite, roles, remove)
- Projects (project + env management)

**BILLING** (money)
- Usage (charts, cost breakdown)
- Limits (rate limits, quotas)
- Billing (Stripe portal, invoices)

**GOVERNANCE** (compliance)
- Policies (budget, tool blocking)
- Secrets (env-scoped vault)
- Audit Log (read-only trail)

**REMOVED from sidebar:**
- Sandbox Studio → monitoring metric only
- GPU Endpoints → admin/infra only
- Infrastructure → merged into relevant sections
- API Explorer → link to docs
- Reliability → merged into Eval
