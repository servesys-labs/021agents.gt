# Architecture Recommendation: Agent Database Access

**Author**: Manus AI
**Date**: March 22, 2026

## 1. The Core Problem
When a user wants an agent to query their company's database (Snowflake, Databricks, Oracle, PostgreSQL, etc.), we have two distinct architectural paths to choose from:

**Path A: Code Execution (Sandbox)**
The agent uses the `sandbox_exec` tool to write a Python script, install drivers (e.g., `pip install snowflake-connector-python`), inject credentials via environment variables, run the script, and parse the stdout.

**Path B: MCP Tools (Pipedream/Custom)**
The database connection is handled by a backend server. The agent simply calls an MCP tool like `execute_sql_query(query="SELECT * FROM sales")` and gets JSON back.

## 2. Pipedream's Current Coverage
Our current connector hub relies on Pipedream. An analysis of Pipedream's MCP servers reveals:
- **Supported Databases**: Snowflake, PostgreSQL, MySQL, MongoDB, Microsoft SQL Server, Supabase, Cosmos DB.
- **Missing Enterprise Databases**: Databricks (only has a stub MCP server with no tools), Oracle.
- **Tool Pattern**: For supported databases, Pipedream exposes simple tools like `Execute SQL Query` and `Insert Single Row`.

## 3. Comparison of Approaches

| Feature | Path A: Code Execution (Sandbox) | Path B: MCP Tools (Pipedream/Custom) |
|---------|---------------------------------|--------------------------------------|
| **Security** | 🔴 **High Risk.** Agent has raw credentials. Could write destructive code (DROP TABLE) or exfiltrate data. | 🟢 **High Security.** Backend enforces read-only connections. Credentials never touch the agent's context. |
| **Reliability** | 🔴 **Low.** Agent must correctly write driver code, handle pagination, and parse complex outputs. High token usage. | 🟢 **High.** Agent just writes SQL. Backend handles connection pooling, pagination, and JSON formatting. |
| **Multi-Query Workflows** | 🟡 **Moderate.** Agent can write a script that runs 5 queries in a loop, but debugging is hard. | 🟢 **Excellent.** Agent can call `execute_sql_query` multiple times in a loop, evaluating results turn-by-turn. |
| **Database Coverage** | 🟢 **Infinite.** If there's a Python driver (Oracle, Databricks, custom APIs), the agent can connect to it. | 🟡 **Limited by Provider.** We only support what Pipedream or our custom MCP servers support. |
| **Setup UX** | 🔴 **Poor.** User must paste raw connection strings into "Secrets" for the agent to use. | 🟢 **Excellent.** Standard OAuth or guided connection UI in the portal. |

## 4. Architecture Recommendation: The Hybrid Approach

We should **not** rely on Code Execution for database queries. The security risks (credential leakage, destructive DDL execution) and reliability issues (agent writing bad Python driver code) are too high for enterprise customers.

Instead, we must adopt a **Tool-Driven (MCP) Architecture**, but handle the coverage gaps intelligently.

### Tier 1: Pipedream-Supported Databases (Snowflake, Postgres, MySQL, SQL Server)
For these, we leverage our existing Pipedream integration.
1. User authenticates via Pipedream OAuth in the portal.
2. The agent receives the Pipedream MCP tools (e.g., `execute_sql_query`).
3. **Workflow**: The agent can absolutely run multiple queries. The harness supports multi-turn tool execution. The agent calls `get_schema`, reads the result, then calls `execute_sql_query` multiple times to build its final answer.

### Tier 2: Missing Enterprise Databases (Databricks, Oracle)
Since Pipedream lacks robust support for these, we must build **Custom MCP Servers** hosted within the oneshots.co infrastructure.
1. We deploy a `databricks-mcp-server` and `oracle-mcp-server`.
2. Users provide credentials in the portal (stored encrypted in our DB).
3. These custom servers expose the exact same standard interface: `get_schema` and `execute_sql_query`.
4. The agent interacts with them exactly as it does with Pipedream databases.

### Tier 3: The Sandbox "Escape Hatch"
If a customer has a completely bespoke internal database (e.g., an in-house proprietary graph DB), they can use the Sandbox Code Execution.
- They inject credentials via the `Secrets` manager.
- The agent writes custom Python code.
- **Crucially**: This is an opt-in escape hatch, not the default path for standard databases.

## 5. Conclusion
**Do not force the agent to write Python to query Snowflake or Oracle.** It is slow, expensive, and insecure.

Instead, expose databases as **MCP Tools**. The agent's LLM is incredibly good at generating SQL (NL2SQL). By giving it a `query_database(sql)` tool, it can rapidly execute multiple queries in a single session, evaluate the results, and synthesize an answer, all while the backend enforces read-only security boundaries.
