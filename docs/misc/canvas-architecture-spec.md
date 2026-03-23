# Canvas-Based UI Architecture Specification

## Overview
The oneshots.co portal will transition from a traditional list/form-based UI to a spatial, canvas-based UI inspired by Railway. This visual approach aligns perfectly with the underlying architecture of AI agents, which operate as nodes in a graph connected to resources (tools, databases, documents) and other agents.

This specification outlines the technical architecture, UX patterns, and implementation strategy using React Flow (`@xyflow/react`).

## 1. UX & Visual Design Patterns

The canvas will serve as the primary workspace for developers, replacing the current `/agents` list view.

### The Canvas Environment
The workspace uses a dark theme (`#0d0d0d`) with a subtle dot grid pattern to provide spatial orientation [1]. Users can pan and zoom infinitely. A top navigation bar provides project/environment switching and a "+ Add" button for dropping new resources onto the canvas. A floating AI assistant input box rests in the bottom-right corner, allowing natural language creation of any canvas element.

### Node Cards
Every entity in the system is represented as a "Node" on the canvas. Nodes are styled as sleek, dark cards (`#1a1a1a` with `#2a2a2a` borders) featuring:
- **Icon & Title**: Visual identifier of the entity type (e.g., Robot icon for Agents, Database icon for Data Sources).
- **Status Indicator**: A pulsing green dot for "Online/Ready", yellow for "Deploying/Syncing", or red for "Error" [1].
- **Connection Handles**: Left and right edge points for drawing connection lines.

### Context Menus
Interaction is driven by right-clicking nodes, which opens a cascading context menu identical to Railway's pattern [2]. This replaces traditional "Edit" or "Settings" pages by bringing the actions directly to the object.

## 2. Node Types & Interactions

The system defines five primary node types, each mapping to specific backend API domains.

| Node Type | Description | Right-Click Actions | Backend API Mapping |
|-----------|-------------|---------------------|---------------------|
| **Agent** | The core LLM worker | Chat, Run Task, Edit Config, Deploy, View Metrics, Delete | `/api/v1/agents/*`, `/api/v1/deploy/*` |
| **Knowledge** | RAG document collections | Upload Docs, View Chunks, Edit Settings, Delete | `/api/v1/rag/*` |
| **Data Source** | Database connections | Test Connection, Browse Schema, Edit Auth, Delete | (Custom MCP Server) |
| **Connector** | SaaS apps via Pipedream | Authenticate, View Tools, Test Tool, Disconnect | `/api/v1/connectors/*` |
| **MCP Server** | Custom internal APIs | Sync Tools, Check Status, Edit Config, Delete | `/api/v1/mcp/servers/*` |

## 3. Edges (Relationships)

Edges represent permissions and data flow. By dragging a line from a Knowledge Base node to an Agent node, the developer is visually executing the "Assign Knowledge Base to Agent" action.

When an edge is created, the frontend triggers an API call to update the Agent's configuration (e.g., adding the resource ID to the agent's `tools` or `knowledge_base_ids` array). The edge line visually confirms the relationship.

## 4. The Meta-Agent Assistant

The AI assistant in the bottom-right corner acts as a co-pilot for the canvas. 

When a user types "Create a customer support agent connected to our Slack workspace", the frontend:
1. Calls `POST /api/v1/agents/create-from-description`
2. Creates a new Agent node on the canvas
3. Creates a new Connector node for Slack
4. Automatically draws an edge between them
5. Pans the camera to focus on the newly created cluster

## 5. Implementation Strategy

The implementation requires migrating the existing portal to `@xyflow/react`.

### Step 1: Canvas Foundation
Install `@xyflow/react` and set up the base `<ReactFlow>` component with the `<Background>` dot pattern and dark theme CSS overrides.

### Step 2: Custom Node Components
Build the React components for each node type. These components will receive data via the `data` prop in React Flow and render the card UI with status indicators.

### Step 3: State Synchronization
Implement a two-way sync mechanism between the React Flow state (`nodes`, `edges`) and the backend API. When the canvas loads, it must fetch all agents, connectors, and MCP servers, and translate them into the `nodes` array. The relationships between them must be parsed into the `edges` array.

### Step 4: Context Menus & Modals
Implement the `onNodeContextMenu` handler to render custom floating menus based on the node type. Clicking actions in the menu will open sliding drawers or modals (e.g., the Agent Config form) without leaving the canvas.

## References
[1] Railway Canvas Workspace Design
[2] Railway Context Menu Interaction Pattern
