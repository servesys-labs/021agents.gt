# Canvas Interaction Map

## Node Types and Their Context Menus

### Agent Node
Right-click menu:
- Chat with Agent → opens chat drawer
- Run Task → opens task input modal
- Edit Config → opens config panel in right sidebar
- View Sessions → navigates to filtered sessions page
- View Metrics → opens metrics overlay
- Deploy → POST /api/v1/deploy/{name}
- Promote → submenu: Draft → Staging → Production
- Clone Agent → POST /api/v1/agents/{name}/clone
- Export Config → GET /api/v1/agents/{name}/export
- Evolve → POST /api/v1/evolve/{name}/run
- Delete Agent → DELETE /api/v1/agents/{name} (red, destructive)

### Knowledge Base Node
Right-click menu:
- Upload Documents → opens file upload modal → POST /api/v1/rag/ingest
- View Documents → lists chunks
- Edit Settings → name, embedding model
- Delete → removes KB

### Data Source Node
Right-click menu:
- Test Connection → validates connectivity
- Browse Schema → shows tables/columns
- Edit Connection → update credentials
- Delete → removes data source

### Connector Node (Pipedream)
Right-click menu:
- Authenticate → opens OAuth flow via GET /api/v1/connectors/auth/{app}
- View Available Tools → lists MCP tools
- Test Tool → opens tool test modal
- Disconnect → removes connector

### MCP Server Node
Right-click menu:
- Sync Tools → POST /api/v1/mcp/servers/{id}/sync
- View Tools → lists discovered tools
- Check Status → GET /api/v1/mcp/servers/{id}/status
- Edit Config → update URL/auth
- Delete → removes server

## Edge Connections (drag from source handle to target handle)
- Agent ←→ Knowledge Base: assigns KB for RAG retrieval
- Agent ←→ Data Source: gives agent query_database tool
- Agent ←→ Connector: gives agent connector tools
- Agent ←→ MCP Server: gives agent custom MCP tools
- Agent ←→ Agent: creates delegation relationship (run-agent / A2A)

## Canvas-Level Actions
- Right-click on empty canvas: Add Agent, Add Knowledge Base, Add Data Source, Add Connector, Add MCP Server
- "+ Add" button (top right): same options as canvas right-click
- Zoom controls (bottom left): zoom in, zoom out, fit view, minimap toggle
- AI Assistant (bottom right): persistent chat input for meta-agent

## API Endpoints per Node Type

### Agent (16 endpoints)
POST /api/v1/agents (create)
PUT /api/v1/agents/{name} (update)
DELETE /api/v1/agents/{name} (delete)
POST /api/v1/agents/{name}/clone (clone)
GET /api/v1/agents/{name}/config (read config)
GET /api/v1/agents/{name}/export (export)
POST /api/v1/agents/import (import)
POST /api/v1/agents/create-from-description (AI create)
POST /api/v1/agents/{name}/run (run task)
POST /api/v1/agents/{name}/chat (chat turn)
GET /api/v1/agents/{name}/versions (version history)
GET /api/v1/agents/{name}/tools (list agent tools)
POST /api/v1/deploy/{name} (deploy)
GET /api/v1/deploy/{name}/status (deploy status)
POST /api/v1/releases/{name}/promote (promote)
POST /api/v1/releases/{name}/canary (canary split)

### Knowledge Base (4 endpoints)
POST /api/v1/rag/ingest (upload/ingest)
GET /api/v1/rag/stats (stats)
POST /api/v1/rag/query (test query)
DELETE /api/v1/rag/collection (delete)

### Connectors (5 endpoints)
GET /api/v1/connectors/apps (list available apps)
GET /api/v1/connectors/auth/{app} (OAuth URL)
GET /api/v1/connectors/connected (list connected)
POST /api/v1/connectors/call (call tool)
DELETE /api/v1/connectors/{app} (disconnect)

### MCP Servers (5 endpoints)
GET /api/v1/mcp/servers (list)
POST /api/v1/mcp/servers (register)
DELETE /api/v1/mcp/servers/{id} (delete)
GET /api/v1/mcp/servers/{id}/status (status)
POST /api/v1/mcp/servers/{id}/sync (sync tools)
