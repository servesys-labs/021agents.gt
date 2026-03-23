# oneshots.co Portal: Definitive Implementation Plan

**Author**: Manus AI
**Date**: March 22, 2026

## 1. The Vision: The AI-Native Control Plane

The oneshots.co portal is transitioning from a traditional, read-only list dashboard into a **spatial, AI-native developer control plane**. Inspired by the UX of Railway and E2B, the primary workspace becomes an infinite canvas where developers can visually build, connect, and observe their agent infrastructure.

The portal is no longer just a place to *view* agents; it is the place to *build* them, assisted by a conversational Meta-Agent that writes the configurations for you.

## 2. Design System & UX Paradigm

The entire portal uses a dark theme (`#0d0d0d` background, `#1a1a1a` panels) with a signature orange accent (`#ff8c00`), replacing the previous light-mode Tremor UI.

The UX is split into two paradigms:
1. **The Canvas (Building)**: Replaces the `/agents` page. An infinite workspace for creating agents and wiring them to data sources.
2. **The Sidebar (Observing & Configuring)**: Traditional dark-themed data tables and charts for Sessions, Evolution, Team RBAC, and Billing.

## 3. The Canvas Architecture (React Flow)

The canvas is powered by `@xyflow/react`. It visualizes the underlying graph architecture of oneshots.co.

### 3.1 Node Types
Every entity is a node card with a status indicator (Online, Deploying, Error).
- **Agent Node**: The core LLM worker.
- **Knowledge Node**: RAG document collections.
- **Data Source Node**: Database connections (Postgres, Snowflake).
- **Connector Node**: SaaS apps via Pipedream (Slack, GitHub).
- **MCP Server Node**: Custom internal APIs.

### 3.2 Edges (Relationships)
Drawing a line from a resource to an agent assigns that resource to the agent.
- *Mechanism*: Drawing an edge from a Slack Connector to an Agent automatically appends `"slack_send_message"` to the agent's `tools` array and calls `PUT /api/v1/agents/{name}`.

### 3.3 Context Menus
Right-clicking any node opens a cascading menu of actions.
- *Agent Actions*: Chat, Run Task, Edit Config (opens drawer), Deploy, Promote, View Sessions, View Metrics, Delete.

### 3.4 The Meta-Agent Assistant
A persistent chat input in the bottom-right corner of the canvas.
- *Flow*: Developer types "Create a support agent connected to Slack" → Frontend calls `POST /api/v1/agents/create-from-description` → Canvas drops a new Agent node and a Slack node, draws the edge, and pans to the cluster.

## 4. Backend API Integration & Gaps

The current backend API (`/api/v1/`) has 178 endpoints. The canvas UI can be built almost entirely on existing endpoints, with three specific backend updates required.

### 4.1 What Works Now
- **Agent CRUD**: `POST`, `PUT`, `DELETE`, `clone`, `export` endpoints exist and map directly to canvas context menu actions.
- **Connectors & MCP**: Edges are mapped by dynamically updating the agent's `tools` array. The backend `ToolRegistry` handles the resolution automatically.

### 4.2 Required Backend Updates
1. **Layout Persistence**: Add `GET/PUT /api/v1/projects/{id}/canvas-layout` to save node `{x, y}` coordinates. (Initial implementation will use `localStorage`).
2. **Knowledge Base Scoping**: Update `AgentConfig` to include `knowledge_bases: list[str]` so RAG collections can be assigned per-agent instead of globally.
3. **Data Sources**: Add a new `POST /api/v1/data-sources` endpoint that creates an internal MCP server acting as a read-only proxy to the developer's database.

## 5. Intelligence & Observability (Sidebar Pages)

While the canvas handles building, the sidebar pages handle the outer loop of agent optimization.

### 5.1 Continuous Evolution
The backend `EvolutionLoop` observes sessions, clusters failures, and queues proposals. The `Evolution` page must surface the **Review Queue** where developers Approve/Reject changes, and the **Ledger** for version history and rollbacks.

### 5.2 Deep Observability
The `Sessions` page must implement a **Trace Viewer** (calling `GET /api/v1/sessions/{id}/trace`), allowing developers to step through every LLM prompt, tool execution, and line-item cost calculation.

### 5.3 Eval Gym
A dedicated `Eval` page to upload test datasets (`.json`), trigger the `AutoResearchLoop`, and view the `EvalReport` (pass rate, latency, cost).

## 6. Security & Team (RBAC)

The backend enforces a strict Role-Based Access Control hierarchy (owner > admin > member > viewer).

- **Org Switcher**: A global dropdown in the top navigation to switch between organizations.
- **Team Management**: A new page under Settings to list members, invite users, and change roles (`GET/POST/PUT /api/v1/orgs/{id}/members`).
- **Client-Side Enforcement**: A `<RequireRole>` wrapper component that hides destructive canvas actions (like "Delete Agent") from viewers.

## 7. Execution Roadmap

| Phase | Focus | Deliverables |
|-------|-------|--------------|
| **1** | **Foundation & Security** | E2B Dark Theme, Org Switcher, RBAC Enforcement, Team Members page. |
| **2** | **The Canvas UI** | React Flow integration, Node components, Context Menus, LocalStorage layout. |
| **3** | **Canvas Wiring** | Wire Agent CRUD, Connector OAuth, MCP Server registration to canvas actions. |
| **4** | **The Meta-Agent** | Build the AI Assistant sidebar, wire `create-from-description`, auto-layout new nodes. |
| **5** | **Backend Updates** | Implement Knowledge Base scoping and Data Source MCP servers. |
| **6** | **Observability** | Trace Viewer, Evolution Review Queue, Eval Gym. |

This plan represents the complete architectural blueprint for transforming oneshots.co into a visual, AI-native developer platform.
