# oneshots.co Portal: The Definitive Implementation Blueprint

**Author**: Manus AI
**Date**: March 22, 2026

## 1. The Vision Shift
The portal must evolve from a "read-only API explorer" into a **Developer Control Plane** (the "Vercel for Agents"). Developers should be able to configure their organization, connect their company's data (databases, APIs, documents), build agents, assign those resources to specific agents, and deploy them.

## 2. The Core Problem: Resource Assignment
Currently, the portal treats all resources (RAG documents, Pipedream connectors, MCP servers) as flat, organization-wide utilities. The `AgentCreateRequest` schema only accepts basic strings (name, prompt, model). 

**The Fix:** We must introduce a **Resource Assignment Model**. When creating or editing an agent, developers must be able to explicitly attach:
1. **Knowledge Bases** (for unstructured RAG)
2. **Data Sources** (for structured DB queries via MCP)
3. **App Connectors** (for SaaS integrations via Pipedream)
4. **Custom MCP Servers** (for internal APIs)

## 3. The New UI Architecture (E2B-Inspired)

The sidebar will be consolidated into logical developer workflows, hiding internal plumbing (Sandboxes, GPU nodes) and focusing on Agent lifecycle and data connections.

```text
▲ oneshots.co
  [ Org Switcher: Acme Corp ▾ ]  <-- RBAC Context
  [ Env Switcher: Production ▾ ] <-- Deployment Context

■ Dashboard (Metrics, Active Sandboxes)

AGENTS
■ Agents (The core CRUD loop + Resource Assignment)
■ Templates

RUNTIME
■ Sessions (Traces, Costs, Debugging)
■ Workflows (Multi-agent DAG builder)

INTELLIGENCE
■ Knowledge (Upload PDFs/Docs → Create Knowledge Bases)
■ Memory (View/Edit agent facts and episodes)
■ Eval (Trigger test runs against datasets)

INTEGRATION
■ Data Sources (Connect Postgres, MySQL, Oracle)
■ Connectors (Pipedream OAuth for SaaS apps)
■ MCP Servers (Register custom internal APIs)
■ Webhooks

TEAM & BILLING
■ Members (RBAC: Invite users, assign roles)
■ API Keys (Generate scoped keys)
■ Usage & Billing
```

## 4. Feature Specifications

### 4.1 Knowledge Bases (Unstructured Data)
- **Concept**: A named collection of documents (e.g., "HR Policies 2026").
- **UI Flow**: Developer goes to `INTELLIGENCE > Knowledge`, creates a KB, and uploads PDFs. A background job chunks and embeds them.
- **Assignment**: In the Agent Builder, developer selects "HR Policies 2026" from a dropdown. The agent's `MemoryManager` now has access to this RAG pipeline.

### 4.2 Data Sources (Structured Databases)
- **Concept**: Secure, read-only MCP proxies to company databases.
- **Tier 1 (Pipedream)**: Snowflake, Postgres, MySQL, SQL Server.
- **Tier 2 (Custom MCP)**: Databricks, Oracle (Requires deploying custom oneshots.co MCP servers).
- **UI Flow**: Developer goes to `INTEGRATION > Data Sources`, enters connection credentials. The backend verifies and exposes `get_schema` and `query_database` tools.
- **Assignment**: In the Agent Builder, developer attaches the "Prod DB" source. The agent's LLM can now dynamically write and execute SQL safely.

### 4.3 App Connectors (SaaS Integrations)
- **Concept**: Pipedream OAuth integrations (Slack, GitHub, Salesforce).
- **UI Flow**: Developer goes to `INTEGRATION > Connectors`, clicks "Connect Slack", completes OAuth.
- **Assignment**: In the Agent Builder, developer attaches the "Slack Workspace" connector. The agent receives tools like `slack_send_message`.

### 4.4 RBAC & Tenant Scoping
- **Context Switchers**: The portal must include an Org Switcher and Environment Switcher in the top header.
- **Role Enforcement**: UI buttons (Delete, Deploy) must be wrapped in a `<RequireRole minRole="admin">` component. Viewers get a read-only experience.
- **Team Management**: A new `Members` page to invite users and assign roles (`owner`, `admin`, `member`, `viewer`).

## 5. Execution Roadmap

To build this, we must execute in four distinct phases:

### Phase 1: Context & Security Foundation
1. Implement the Org Switcher and Environment Toggle in the `Sidebar` and `PageHeader`.
2. Build the `useRole()` hook and `<RequireRole>` wrapper components.
3. Build the `Team > Members` page for inviting users.

### Phase 2: Resource Configuration Pages
1. Build `Knowledge` page (File upload, KB creation).
2. Build `Data Sources` page (Database credential forms, connection testing).
3. Revamp `Connectors` page (Clearer OAuth flows, save connections as entities).

### Phase 3: The Agent Builder (The Core)
1. Completely rewrite the `Agents` page from a read-only list to a full CRUD interface.
2. Build the "Create/Edit Agent" form.
3. **Crucial**: Implement the "Resource Assignment" section in the form, allowing developers to attach the KBs, Data Sources, and Connectors created in Phase 2.

### Phase 4: Observability & Orchestration
1. Build the `Sessions` Trace Viewer (showing exact tool calls and LLM latency).
2. Build the `Workflows` DAG builder.
3. Build the `Eval` trigger UI.

## Conclusion
This blueprint transforms the portal from a passive monitor into an active control plane. By decoupling resource creation (Knowledge, Data Sources) from the agents, and introducing a clear assignment model, developers gain the flexibility to securely connect enterprise data and compose powerful, context-aware agents.
