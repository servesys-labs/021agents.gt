# Canvas UI Research Notes

## React Flow (@xyflow/react)
- Library: `@xyflow/react` (v12+)
- License: MIT for open-source use
- Key features:
  - Custom nodes (just React components)
  - Custom edges
  - `onNodeContextMenu` event for right-click menus
  - `useNodesState` and `useEdgesState` hooks for state management
  - Built-in Background component (dots pattern like Railway)
  - Built-in MiniMap and Controls
  - Drag and drop support
  - Zoom and pan
  - fitView for auto-layout
  - Save and restore (serializable state)

## Railway Canvas UX Patterns (from screenshots)
1. Dark background with subtle dot grid
2. Service cards as nodes: name, domain/URL, status indicator (green dot = Online)
3. Top bar: project name dropdown, environment dropdown (production), Sync button, + Add button
4. Left sidebar: minimal icon-only nav (services, metrics, docs, settings)
5. Right sidebar: "New Agent" panel with AI assistant at bottom
6. Right-click context menu on nodes:
   - Group >
   - Copy SSH Command
   - Attach volume
   - Config > (submenu: Sync env, Name, Icon, Add Variable, Start command, Healthcheck)
   - Latest deploy
   - View Variables
   - View Metrics
   - View Settings
   - Duplicate
   - Delete Service (red, destructive)
7. AI assistant at bottom-right: "Develop, debug, deploy anything..." prompt

## Node Types for oneshots.co
- Agent node (primary)
- Knowledge Base node
- Data Source node
- Connector node (Pipedream apps)
- MCP Server node
- Workflow node (multi-agent DAG)

## Edge Types
- Agent → Knowledge Base (RAG retrieval)
- Agent → Data Source (query tool)
- Agent → Connector (SaaS integration)
- Agent → MCP Server (custom tools)
- Agent → Agent (delegation via run-agent or A2A)
