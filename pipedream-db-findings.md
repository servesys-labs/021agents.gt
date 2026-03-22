# Pipedream Database Integrations — Findings

## Databases Available via Pipedream MCP (25 total)

### Tier 1 — Major Databases (Already in Pipedream)
| Database | MCP Tools Available |
|----------|-------------------|
| **Supabase** | Full CRUD + RPC |
| **MySQL** | Insert Row, Insert Multiple, Execute SQL, Query SQL |
| **PostgreSQL** | Insert Row, Insert Multiple, Execute SQL, Query SQL |
| **Snowflake** | Insert Single Row, Insert Multiple Rows, Execute SQL Query, Query SQL Database |
| **MongoDB** | Insert, Find, Update, Delete, Aggregate |
| **Microsoft SQL Server** | Execute SQL, Query SQL |

### Tier 2 — Cloud/Serverless Databases
- Azure Cosmos DB
- Neon Postgres
- Nile Database
- Prisma Postgres
- Fauna
- Xata
- CrateDB Cloud
- QuestDB
- TimescaleDB
- Upstash Redis
- Weaviate (vector DB)
- Chroma Cloud (vector DB)

### Tier 3 — Low-code/No-code DBs
- Baserow, AnyDB, QuintaDB, bit.io

## Key Finding: NO Databricks, NO Oracle
- **Databricks** is NOT in Pipedream's database category
- **Oracle** is NOT in Pipedream's database category
- These would need custom MCP servers or the code execution approach

## Snowflake Tools (4 actions):
1. Insert Single Row — Insert a row into a table
2. Insert Multiple Rows — Insert multiple rows into a table
3. Execute SQL Query — Execute a custom Snowflake query
4. Query SQL Database — Execute a SQL Query

## PostgreSQL/MySQL Tools (same 4 pattern):
1. Insert Row
2. Insert Multiple Rows  
3. Execute SQL Query
4. Query SQL Database

## Architecture Implication
Pipedream already handles OAuth/auth for all these databases. The oneshots.co connector hub (`agentos/connectors/hub.py`) already integrates with Pipedream. So for Snowflake, MySQL, PostgreSQL, MongoDB, SQL Server — we can use Pipedream as the MCP bridge. For Databricks and Oracle, we'd need either:
1. Custom MCP servers
2. Code execution in sandbox (agent writes Python with appropriate drivers)
