# oneshots.co Portal: Vision-Aligned Implementation Plan

**Author**: Manus AI
**Date**: March 22, 2026

## 1. The Vision Shift: "Vercel for Agents"

The original portal implementation treated every backend router as a 1:1 user-facing page. This was a mistake. 

As stated in the `README.md`, oneshots.co is an **Agent Control Plane**. The target users are developers who build, deploy, and govern agents. 
- **What users do:** Create agents, configure them, monitor their runs, manage team access, and view billing.
- **What users DON'T do:** Manually spin up sandboxes, manually execute tools, or manage internal RAG chunks. Those are *infrastructure primitives* that agents use during execution.

The portal must shift from being an "API Explorer" to a "Control Plane" (like Vercel or E2B's dashboard).

## 2. Redefining the UI Architecture

Based on the `ARCHITECTURE_REVIEW.md` and the 35 backend routers, we must restructure the portal into clear, developer-focused domains.

### 2.1 What to Remove (Internal Infrastructure)
These pages should be **deleted** or hidden from the main navigation:
1. **Sandbox Studio**: Sandboxes are created dynamically by the `sandbox_exec` tool during an agent's turn. Users don't need a UI to create them. (We will show "Active Sandboxes" as a metric on the Dashboard instead).
2. **GPU Endpoints**: Internal infrastructure routing.
3. **API Explorer**: Belongs in external documentation, not the app sidebar.
4. **Tools List**: Should be a reference modal when configuring an agent, not a standalone page.

### 2.2 What to Consolidate
1. **Jobs & Schedules**: Merge into a single "Runtime" view.
2. **Memory & RAG**: Merge into an "Intelligence" view showing what the agent knows.
3. **Policies & Secrets**: Merge into a "Governance" view.

## 3. The New Sidebar & Page Structure (E2B-Inspired)

```text
▲ oneshots.co
  [ Org Switcher: Acme Corp ▾ ]
  [ Env Switcher: Production ▾ ]

■ Dashboard

AGENTS
■ Agents (Create, Deploy, Chat)
■ Templates

RUNTIME
■ Sessions (Traces, Costs)
■ Workflows (DAGs)
■ Jobs & Schedules

INTELLIGENCE
■ Memory (Episodes, Facts)
■ Eval & Evolution

INTEGRATION
■ Connectors (Pipedream OAuth)
■ MCP Servers
■ Webhooks

TEAM
■ General
■ API Keys
■ Members
■ Projects

BILLING
■ Usage
■ Limits
■ Billing

GOVERNANCE
■ Policies
■ Secrets
■ Audit Log
```

## 4. Execution Plan: Phase 1 (The Core Developer Loop)

To make the portal actually useful, we need to implement the full CRUD loop for the most critical developer actions.

### Step 1: Agent CRUD & Deployment
- **Current State**: Read-only list.
- **Action**: Implement `POST /api/v1/agents` (Create via template or blank), `PUT /api/v1/agents/{name}` (Edit config: system prompt, tools, model), and `POST /api/v1/deploy/{name}` (Trigger Cloudflare Workers deployment).
- **UX Goal**: A developer can click "New Agent", pick the "research" template, tweak the prompt, and click "Deploy".

### Step 2: RBAC & Context Switching
- **Current State**: Hardcoded "member" role, stuck in default org.
- **Action**: Implement the Org Switcher dropdown (fetching from `GET /api/v1/orgs`). Store `activeOrgId` in context. Wrap destructive buttons (Delete, Deploy) in a `<RequireRole minRole="admin">` component.

### Step 3: Session Observability (Traces)
- **Current State**: Basic list of session IDs.
- **Action**: Implement a detailed Trace Viewer (`GET /api/v1/observability/traces/{id}`). Show the tree of turns: User Input → LLM Call (latency, tokens) → Tool Call (e.g., `sandbox_exec`) → Result. 
- **UX Goal**: A developer can see exactly *why* an agent failed or how much a specific turn cost.

### Step 4: Clean up the Sidebar
- **Action**: Remove the Sandbox, GPU, and API Explorer pages. Update the `Sidebar.tsx` to match the new consolidated structure.

## 5. Conclusion

By hiding the internal plumbing (Sandboxes, RAG chunks) and focusing the UI on the **Agent Lifecycle** (Create → Deploy → Monitor → Evolve), the portal will align perfectly with the "Vercel for Agents" vision.
