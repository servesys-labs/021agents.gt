# Knowledge & Data Sources: Feature Specification

**Author**: Manus AI
**Date**: March 22, 2026

## 1. Overview

To truly act as a "Vercel for Agents," oneshots.co must provide seamless ways for agents to access a company's proprietary data. This data falls into two distinct categories:

1. **Knowledge (Unstructured Data)**: PDFs, Word documents, Markdown files, and text. This is handled via Retrieval-Augmented Generation (RAG).
2. **Data Sources (Structured Data)**: Relational databases like PostgreSQL, MySQL, and SQL Server. This is handled via the Model Context Protocol (MCP).

This specification outlines how both systems should be architected in the backend and exposed in the developer portal.

---

## 2. Knowledge (Unstructured Data / RAG)

Currently, the `agentos/rag/pipeline.py` exists but is completely disconnected from the portal UI. We need a proper "Knowledge Bases" feature.

### 2.1 Backend Architecture
- **Knowledge Bases**: A new entity representing a collection of documents.
  - Table: `knowledge_bases (id, org_id, name, description, created_at)`
  - Table: `knowledge_documents (id, kb_id, filename, status, chunk_count, size_bytes)`
- **Agent Assignment**: Agents can be linked to one or more Knowledge Bases.
  - When an agent runs, the `MemoryManager` loads the RAG pipelines for all attached Knowledge Bases.
- **Ingestion Flow**:
  1. User uploads a PDF via the portal.
  2. API saves the file to a secure blob store (or local disk).
  3. A background job (using the existing `agentos/api/routers/jobs.py`) runs the `DynamicChunker` and embedding generation.
  4. Chunks are saved to `rag_chunks.db` scoped by `kb_id`.

### 2.2 Portal UI Design
**Location**: Sidebar → `INTELLIGENCE` → `Knowledge`

- **Knowledge Base List**: A table showing all KBs, document counts, and attached agents.
- **KB Detail View**:
  - **Documents Tab**: A drag-and-drop zone to upload files. Shows a table of files with ingestion status (Pending, Chunking, Embedded, Ready).
  - **Settings Tab**: Configure chunk size and overlap.
- **Agent Config Integration**: In the Agent creation/edit form, a multi-select dropdown allows developers to attach existing Knowledge Bases to the agent.

---

## 3. Data Sources (Structured Data / Databases)

Companies will not expose their production databases directly to the internet. We need a secure, read-only mechanism for agents to query SQL databases using MCP.

### 3.1 The MCP Server Architecture
We will build a **Database MCP Server** (similar to Microsoft's Data API Builder SQL MCP Server) [1].

1. **Connection Management**:
   - Table: `data_sources (id, org_id, name, type, connection_string_encrypted)`
   - Supported types: PostgreSQL, MySQL, SQLite.
2. **The MCP Server**:
   - The oneshots.co backend will host an internal MCP server that acts as a proxy to the customer's database.
3. **Tools Exposed to the Agent**:
   - `list_tables()`: Returns available tables (filtered by RBAC/configuration).
   - `get_schema(table_name)`: Returns column names and types.
   - `query_database(sql)`: Executes a **read-only** SQL query and returns JSON.
4. **Security Boundary (Critical)**:
   - The MCP server MUST wrap all queries in a read-only transaction or use a read-only database user.
   - No DDL (CREATE/DROP) or DML (INSERT/UPDATE/DELETE) operations are allowed [1].
   - We avoid "NL2SQL" on the portal side; instead, the agent's LLM generates the SQL dynamically using the `query_database` tool.

### 3.2 Portal UI Design
**Location**: Sidebar → `INTEGRATION` → `Data Sources`

- **Data Source List**: Table showing connected databases and their connection status.
- **Add Data Source Modal**:
  - Select Type (Postgres, MySQL).
  - Input connection string (masked, stored securely).
  - "Test Connection" button.
- **Data Source Detail View**:
  - **Schema Explorer**: Read-only view of the tables and columns the agent will be able to see.
  - **Access Control**: Select which agents are allowed to use this Data Source.

### 3.3 Agent Execution Flow
1. Developer attaches the "Production DB" Data Source to the "Data Analyst" agent.
2. User asks the agent: "What were our top 5 customers by revenue last month?"
3. Agent calls `list_tables()`.
4. Agent calls `get_schema('customers')` and `get_schema('orders')`.
5. Agent calls `query_database("SELECT c.name, SUM(o.amount) FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.name ORDER BY SUM(o.amount) DESC LIMIT 5")`.
6. MCP server executes the query safely and returns the JSON rows.
7. Agent formats the final response for the user.

---

## 4. Implementation Phases

**Phase 1: Knowledge Bases (RAG)**
- Create the DB tables for KBs and Documents.
- Build the `POST /api/v1/knowledge/{id}/upload` endpoint.
- Build the Portal UI for uploading and managing documents.
- Update `AgentConfig` to accept `knowledge_bases: list[str]`.

**Phase 2: Data Sources (MCP)**
- Create the DB tables for Data Sources.
- Implement the internal Database MCP Server with `list_tables`, `get_schema`, and `query_database` tools.
- Build the Portal UI for securely storing connection strings.
- Update the `ToolRegistry` to inject the DB tools when an agent is linked to a Data Source.

## References
[1] Microsoft Learn. "SQL MCP Server overview." https://learn.microsoft.com/en-us/azure/data-api-builder/mcp/overview
