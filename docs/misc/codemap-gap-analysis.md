# oneshots.co Portal: Codemap Gap Analysis

**Author**: Manus AI
**Date**: March 22, 2026

## 1. Executive Summary

A comprehensive programmatic audit of the `data/codemap.json` file reveals the exact coverage of the oneshots.co backend API by the frontend portal. The backend exposes **178 user-facing `/api/v1/` endpoints**, of which the portal currently wires **94 (53%)**. The remaining **84 (47%) endpoints are missing** from the frontend entirely.

This analysis maps every missing endpoint to its functional domain and provides actionable recommendations for surfacing these capabilities in the portal.

## 2. Coverage by Domain

The codemap audit reveals significant gaps in core operational domains, particularly in Agent Management, Workflows, and Observability.

| Domain | Total Endpoints | Covered | Missing | Coverage % |
|--------|-----------------|---------|---------|------------|
| **Agents** | 16 | 4 | 12 | 25% |
| **Workflows** | 8 | 2 | 6 | 25% |
| **Observability** | 4 | 0 | 4 | 0% |
| **A2A** | 2 | 0 | 2 | 0% |
| **Orgs** | 8 | 2 | 6 | 25% |
| **Jobs** | 8 | 3 | 5 | 38% |
| **Billing** | 5 | 2 | 3 | 40% |
| **Evolve** | 5 | 3 | 2 | 60% |
| **Schedules** | 7 | 7 | 0 | 100% |
| **Eval** | 6 | 6 | 0 | 100% |

## 3. Critical Missing Capabilities

The 84 missing endpoints represent major platform capabilities that developers cannot currently access through the portal. These must be prioritized for implementation.

### 3.1 The Meta-Agent (Agent Builder)
The backend contains a conversational meta-agent that can generate complete agent configurations from natural language, but the portal has no UI for it.

* **Missing Endpoints:**
  * `POST /api/v1/agents/create-from-description`
* **Recommendation:** Implement a persistent **AI Assistant Sidebar** in the portal where developers can chat with the meta-agent to generate and refine agent configurations before deploying.

### 3.2 Full Agent Lifecycle Management
The portal can list and run agents, but it cannot fully manage their lifecycle, configuration, or versions.

* **Missing Endpoints:**
  * `GET /api/v1/agents/{name}` (View details)
  * `PUT /api/v1/agents/{name}` (Update config)
  * `DELETE /api/v1/agents/{name}` (Delete)
  * `POST /api/v1/agents/{name}/clone` (Duplicate)
  * `GET /api/v1/agents/{name}/versions` (Version history)
  * `GET /api/v1/agents/{name}/tools` (View assigned tools)
* **Recommendation:** Completely rebuild the `Agents` page from a read-only list into a full **Agent Builder** interface with configuration forms, tool assignment, and version management.

### 3.3 Multi-Agent Workflows
The backend supports complex, multi-agent Directed Acyclic Graphs (DAGs), but the portal only lists them.

* **Missing Endpoints:**
  * `POST /api/v1/workflows/validate` (Validate DAG)
  * `POST /api/v1/workflows/{workflow_id}/run` (Trigger execution)
  * `GET /api/v1/workflows/{workflow_id}/runs` (List runs)
  * `GET /api/v1/workflows/{workflow_id}/runs/{run_id}` (View run details)
  * `POST /api/v1/workflows/{workflow_id}/runs/{run_id}/cancel` (Cancel run)
* **Recommendation:** Build a visual **Workflow Builder** (using React Flow) to design, validate, and execute multi-agent DAGs.

### 3.4 Deep Observability & Traces
The portal shows high-level session stats but lacks the ability to inspect individual agent turns, tool calls, and exact costs.

* **Missing Endpoints:**
  * `GET /api/v1/observability/traces/{trace_id}` (Full execution trace)
  * `GET /api/v1/observability/cost-ledger` (Line-item cost breakdown)
  * `GET /api/v1/sessions/{session_id}/trace` (Session trace)
  * `GET /api/v1/sessions/{session_id}/turns` (Turn-by-turn details)
* **Recommendation:** Implement a comprehensive **Trace Viewer** within the Sessions page, allowing developers to step through every LLM prompt, tool execution, and cost calculation.

### 3.5 Organization & RBAC Management
The backend enforces Role-Based Access Control (owner, admin, member, viewer), but the portal has no UI for managing users or switching organizations.

* **Missing Endpoints:**
  * `GET /api/v1/orgs/{org_id}/members` (List team)
  * `POST /api/v1/orgs/{org_id}/members` (Invite user)
  * `PUT /api/v1/orgs/{org_id}/members/{member_user_id}` (Change role)
  * `DELETE /api/v1/orgs/{org_id}/members/{member_user_id}` (Remove user)
* **Recommendation:** Build a **Team Members** page under Settings to handle invitations and role assignments, and add a global **Org Switcher** dropdown to the top navigation.

### 3.6 Agent-to-Agent (A2A) Interoperability
The backend implements the Google/Linux Foundation A2A protocol for discovering and invoking external agents, but this is entirely hidden.

* **Missing Endpoints:**
  * `GET /api/v1/a2a/remotes` (List discovered agents)
  * `POST /api/v1/a2a/test` (Test connection)
* **Recommendation:** Add an **External Agents** page under the Integration section to register and test A2A-compatible endpoints.

## 4. Implementation Priorities

Based on this audit, the immediate next steps for portal development should be:

1. **Phase 1: Context & Security**
   * Wire the Org/Member endpoints to enable the Org Switcher and Team Management UI.
2. **Phase 2: The Agent Builder & Assistant**
   * Wire the `PUT`, `DELETE`, and `clone` agent endpoints.
   * Build the AI Assistant Sidebar and wire `create-from-description`.
3. **Phase 3: Observability**
   * Wire the `traces` and `turns` endpoints to build the Trace Viewer.
4. **Phase 4: Advanced Orchestration**
   * Wire the `workflows` endpoints to enable DAG execution and monitoring.
