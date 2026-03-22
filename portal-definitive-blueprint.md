# oneshots.co Portal: The Definitive Implementation Blueprint

**Author**: Manus AI
**Date**: March 22, 2026

## 1. The Vision Shift: The AI-Native Control Plane
The portal must evolve from a "read-only API explorer" into a **Developer Control Plane** (the "Vercel for Agents"). But more importantly, it must be **AI-Native**. The backend already contains powerful meta-agents and continuous evolution loops that are currently hidden. 

The portal must surface these capabilities directly to the developer, making agent creation and optimization a collaborative process between the human developer and the oneshots.co meta-agent.

## 2. The AI Assistant Sidebar (The Meta-Agent)
The backend has an `AgentBuilder` class (in `agentos/builder.py`) that acts as a conversational meta-agent. It can generate complete agent configurations (system prompts, tool selections, budget limits) from a natural language description.

**The Fix:** We must introduce a persistent **AI Assistant Sidebar** on the right side of the portal.
- **Trigger:** A floating chat button or a persistent right sidebar (like Cursor's Cmd+K or Copilot).
- **Functionality:** 
  - "I need an agent that does customer support for our Stripe billing."
  - The Assistant calls the `/api/v1/agents/build` endpoint.
  - It generates the full agent config, automatically attaches the Stripe connector, and presents a "Review & Create" button.
  - The developer can chat with the assistant to tweak the agent before deploying.

## 3. Continuous Evolution & Evals (The Outer Loop)
The backend has a complete `EvolutionLoop` (in `agentos/evolution/loop.py`) that observes production sessions, clusters failures, generates hypotheses, runs A/B tests against a gym (`agentos/eval/gym.py`), and queues proposals for human review. The portal barely touches this.

**The Fix:** The `INTELLIGENCE > Evolution` page must become the heart of the optimization loop.
- **The Ledger:** Show the full `EvolutionLedger` (version history, rollback capabilities).
- **The Review Queue:** Show the `ReviewQueue` where the `FailureAnalyzer` proposes changes (e.g., "Reduce max_turns to 10 to save cost", "Fix prompt to handle null JSON").
- **Human-in-the-loop:** The developer clicks "Approve" or "Reject" on these proposals. Approved changes are automatically applied and a new version is deployed.
- **Eval Gym:** A dedicated page to upload test datasets (`.json`), trigger the `AutoResearchLoop`, and view the `EvalReport` (pass rate, latency, cost).

## 4. Resource Assignment Model
When creating or editing an agent, developers must be able to explicitly attach resources. The backend `AgentCreateRequest` schema needs to be updated to support these relationships.

1. **Knowledge Bases** (`INTELLIGENCE > Knowledge`): Upload PDFs/Docs → Create Knowledge Bases.
2. **Data Sources** (`INTEGRATION > Data Sources`): Connect Postgres, MySQL, Oracle via custom MCP servers.
3. **App Connectors** (`INTEGRATION > Connectors`): Pipedream OAuth for SaaS apps (Slack, GitHub).
4. **Custom MCP Servers** (`INTEGRATION > MCP Servers`): Register internal APIs.
5. **A2A Integrations** (`INTEGRATION > External Agents`): Discover and invoke external agents via the A2A protocol.

## 5. The New UI Architecture (E2B-Inspired)

```text
▲ oneshots.co                                          [ AI Assistant Sidebar ]
  [ Org Switcher: Acme Corp ▾ ]                        | "Build me an agent..." |
  [ Env Switcher: Production ▾ ]                       |                        |
                                                       | [ Generating config ]  |
■ Dashboard (Metrics, Active Sandboxes)                |                        |
                                                       | > Agent: Stripe Bot    |
AGENTS                                                 | > Tools: [stripe_get]  |
■ Agents (CRUD + Resource Assignment)                  | > Prompt: "You are..." |
■ Templates                                            |                        |
■ Releases (Canary splits, Promotion channels)         | [ Approve & Deploy ]   |

RUNTIME
■ Sessions (Traces, Costs, Debugging)
■ Workflows (Multi-agent DAG builder)

INTELLIGENCE
■ Evolution (Review Queue, Ledger, Rollbacks)
■ Eval (Test datasets, Auto-Research Loop)
■ Knowledge (Upload documents for RAG)
■ Memory (View/Edit agent facts and episodes)

INTEGRATION
■ Data Sources (Connect databases)
■ Connectors (Pipedream OAuth)
■ MCP Servers & A2A
■ Webhooks

TEAM & BILLING
■ Members (RBAC: Invite users, assign roles)
■ API Keys (Generate scoped keys)
■ Usage & Billing
```

## 6. Execution Roadmap

### Phase 1: Context, Security & The Assistant
1. Implement the Org Switcher and Environment Toggle.
2. Build the `useRole()` hook and `<RequireRole>` wrapper components.
3. **Build the persistent AI Assistant Sidebar** hooked up to the `/api/v1/agents/build` endpoint.

### Phase 2: Resource Configuration Pages
1. Build `Knowledge` page (File upload, KB creation).
2. Build `Data Sources` page (Database credential forms, connection testing).
3. Revamp `Connectors` and `MCP Servers` pages.

### Phase 3: The Agent Builder & Deployments
1. Completely rewrite the `Agents` page to support Resource Assignment (dropdowns for KBs, Data Sources, etc.).
2. Build the `Releases` page to expose the existing canary split and channel promotion endpoints (`/api/v1/releases/{agent}/canary`).

### Phase 4: Intelligence & Observability
1. Revamp the `Evolution` page to show the full Review Queue and Ledger with Approve/Reject/Rollback actions.
2. Build the `Eval` page to upload tasks and trigger the `AutoResearchLoop`.
3. Build the `Sessions` Trace Viewer (showing exact tool calls and LLM latency).

## Conclusion
By surfacing the meta-agent via the Assistant Sidebar and exposing the full Evolution Review Queue, the portal transforms from a passive dashboard into an active, AI-collaborative developer environment. The developer sets the goals and reviews the proposals; the platform builds and optimizes the agents.
