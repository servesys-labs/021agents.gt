# Canvas UI API Gap Analysis

To build the Railway-inspired canvas UI using React Flow, the frontend needs to persist the visual layout (node coordinates) and map edge connections to backend relationships. This analysis evaluates whether the current backend API supports these requirements.

## 1. Layout Persistence (Coordinates)

**The Problem:** React Flow requires `{ x, y }` coordinates for every node. When a user drags a node to organize their canvas, those coordinates must be saved so the layout is preserved on reload.

**Current Backend State:**
- The backend has absolutely **no concept of layout, canvas, or coordinates**.
- Agents are stored as YAML/JSON files in an `agents/` directory (or a database depending on the storage backend).
- There is no `canvas_layout` table in the SQLite schema.

**The Gap:**
The backend needs a way to store UI metadata per project/org.
- **Solution A (Frontend only):** Store canvas layout in `localStorage`. (Quickest, but doesn't sync across devices or team members).
- **Solution B (Backend update):** Add a `ui_metadata` field to the `projects` or `orgs` table, or create a new `canvas_layouts` table.

## 2. Edge Connections (Relationships)

**The Problem:** When a user draws an edge from a Connector (e.g., Slack) to an Agent, it should assign that connector's tools to the agent.

**Current Backend State:**
- The `AgentConfig` dataclass has a single `tools: list[str | dict]` field.
- The harness dynamically resolves these tool names against the `ToolRegistry` and `ConnectorHub` at runtime.
- The `PUT /api/v1/agents/{name}` endpoint accepts an updated `tools` array.

**The Gap:**
The current API **does** support edge connections, but it requires the frontend to do the mapping:
1. User draws edge from "Slack Connector" to "Sales Agent".
2. Frontend reads the Slack Connector's available tools (e.g., `slack_send_message`, `slack_read_channel`).
3. Frontend appends those tool names to the Agent's `tools` array.
4. Frontend calls `PUT /api/v1/agents/SalesAgent` with the updated array.

This works perfectly without backend changes, but it means the "edge" on the canvas is derived dynamically by checking if the agent's `tools` array contains tools belonging to that connector.

## 3. Knowledge Base Connections

**Current Backend State:**
- The `AgentConfig` does **not** have a `knowledge_base_ids` field.
- RAG is currently hardcoded to look for a `data/rag_chunks.db` file relative to the agent's working directory.
- The `POST /api/v1/rag/ingest` endpoint ingests documents into the global vector store, but doesn't link them to specific agents.

**The Gap:**
The backend needs an update to support assigning specific knowledge bases to specific agents.
- **Backend Fix:** Add `knowledge_bases: list[str]` to `AgentConfig` and update `MemoryManager` to load only those specific collections.

## Conclusion & Recommendation

The canvas UI is **mostly feasible** with the current backend, but requires a few specific backend updates to be fully functional:

1. **Layout Persistence:** We should start with `localStorage` for node coordinates to get the canvas working immediately, then add a `GET/PUT /api/v1/projects/{id}/layout` endpoint later for team sync.
2. **Resource Assignment:** The frontend can handle Tool/Connector/MCP edge mapping by updating the agent's `tools` array via the existing `PUT /api/v1/agents/{name}` endpoint.
3. **Knowledge Assignment:** The backend's `AgentConfig` must be updated to include a `knowledge_bases` field before Knowledge nodes can be properly connected.
