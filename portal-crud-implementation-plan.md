# oneshots.co Portal: API Coverage & CRUD Implementation Plan

**Author**: Manus AI
**Date**: March 22, 2026

This document provides a comprehensive audit of the `oneshots.co` (formerly AgentOS) backend API surface area compared to the current frontend portal implementation. The analysis reveals that while the backend supports a robust set of 179 endpoints across 34 routers, the frontend portal is largely a "read-only" dashboard with significant gaps in Create, Update, and Delete (CRUD) operations.

## 1. Executive Summary

The backend API is highly capable, offering full lifecycle management for agents, workflows, environments, sandboxes, and memory systems. However, the current React frontend only wires up a fraction of these capabilities, primarily focusing on `GET` requests to populate tables and metric cards.

**Key Findings:**
- **Total Backend Endpoints**: 179
- **Total Endpoints Used in Portal**: ~45 (25% coverage)
- **Missing Capabilities**: Agent creation/editing, workflow orchestration, environment management, tool configuration, manual eval triggering, memory editing, and sandbox file management.

The following sections break down the gap analysis by surface area and propose a concrete implementation plan to upgrade the portal from a read-only dashboard to a fully functional Agent Infrastructure Platform.

## 2. Gap Analysis by Surface Area

### 2.1 Agents & Templates
The core of the platform is agent management, yet the portal currently only lists agents and allows basic chat.

| Capability | Backend Endpoint | Portal Status | Gap / Required UI |
|------------|------------------|---------------|-------------------|
| List Agents | `GET /api/v1/agents` | ✅ Wired | None |
| Create Agent | `POST /api/v1/agents` | ❌ Missing | "Create Agent" modal with form (Name, Model, Prompt, Tools, Budget) |
| Update Agent | `PUT /api/v1/agents/{name}` | ❌ Missing | "Edit Agent" settings page |
| Delete Agent | `DELETE /api/v1/agents/{name}` | ❌ Missing | "Delete" action in table row with confirmation |
| Clone Agent | `POST /api/v1/agents/{name}/clone` | ❌ Missing | "Duplicate" action in table row |
| Import Agent | `POST /api/v1/agents/import` | ❌ Missing | "Import from JSON/YAML" button |

**Implementation Workflow**: 
Add a primary "New Agent" button to the Agents page header. This will open a slide-out panel or modal utilizing the `AgentCreateRequest` schema, allowing users to define the system prompt, select models, and attach tools. Add an action menu (three dots) to each agent row for Edit, Clone, and Delete operations.

### 2.2 Workflows & Jobs
Workflows represent multi-step agent orchestrations. The portal currently has no UI for managing them.

| Capability | Backend Endpoint | Portal Status | Gap / Required UI |
|------------|------------------|---------------|-------------------|
| List Workflows | `GET /api/v1/workflows` | ✅ Wired (Partial) | Needs dedicated page |
| Create Workflow| `POST /api/v1/workflows` | ❌ Missing | Visual builder or JSON/YAML editor for DAG definition |
| Run Workflow | `POST /api/v1/workflows/{id}/run` | ❌ Missing | "Execute" button on workflow details page |
| Cancel Run | `POST /api/v1/workflows/{id}/runs/{run_id}/cancel`| ❌ Missing | "Stop" button on active runs |
| Job Management | `POST /api/v1/jobs/{id}/(pause|resume|cancel)`| ❌ Missing | Job control actions in the Runtime > Jobs page |

**Implementation Workflow**: 
Create a dedicated "Workflows" page under the Runtime section. Implement a split-pane view where users can write workflow definitions (YAML) on the left and see the DAG visualization on the right. Add execution controls to trigger workflows and monitor their underlying jobs.

### 2.3 Memory & RAG
The platform supports long-term memory (facts, procedures, episodes) and RAG document ingestion, but the UI is strictly read-only.

| Capability | Backend Endpoint | Portal Status | Gap / Required UI |
|------------|------------------|---------------|-------------------|
| View Memory | `GET /api/v1/memory/{agent}/*` | ✅ Wired | None |
| Add Fact | `POST /api/v1/memory/{agent}/facts` | ❌ Missing | "Add Fact" button and form (Content, Category, Confidence) |
| Edit/Delete Fact| `DELETE /api/v1/memory/{agent}/facts/{key}` | ❌ Missing | Action menu on facts table |
| Ingest Docs | `POST /api/v1/rag/{agent}/ingest` | ❌ Missing | File upload drag-and-drop zone for RAG |

**Implementation Workflow**: 
On the Memory page, add inline editing capabilities to the facts table. On the RAG page, implement a file dropzone that accepts PDFs/Text files and posts to the `/ingest` endpoint, along with a progress indicator for the ingestion status.

### 2.4 Environments & Projects
Environment variables and project settings are crucial for deployment but lack UI controls.

| Capability | Backend Endpoint | Portal Status | Gap / Required UI |
|------------|------------------|---------------|-------------------|
| Create Project | `POST /api/v1/projects` | ❌ Missing | "New Project" modal |
| Update Env | `PUT /api/v1/projects/{id}/envs/{name}` | ❌ Missing | Key-value pair editor for environment variables |
| Manage Secrets | `POST /api/v1/secrets` | ❌ Missing | Secure input form for API keys and credentials |

**Implementation Workflow**: 
Add a "Settings > Environments" page. Build a secure key-value editor interface (similar to Vercel or Vercel's env var UI) that masks values by default and uses the `PUT` endpoint to update environment configurations.

### 2.5 Evaluation (Evals)
The eval system allows testing agents against datasets, but runs cannot be triggered from the UI.

| Capability | Backend Endpoint | Portal Status | Gap / Required UI |
|------------|------------------|---------------|-------------------|
| List Runs | `GET /api/v1/eval/runs` | ✅ Wired | None |
| Upload Tasks | `POST /api/v1/eval/tasks` | ❌ Missing | File upload for evaluation datasets (JSONL/CSV) |
| Run Eval | `POST /api/v1/eval/run` | ❌ Missing | "Run Evaluation" form (Select Agent, Select Dataset, Set Trials) |

**Implementation Workflow**: 
Enhance the Eval page with a "New Evaluation" workflow. Users select an agent, upload or select a task dataset, configure the number of trials, and trigger the run. The page should poll the run status until completion.

### 2.6 Sandbox Management
The E2B integration allows secure code execution, but the portal lacks interactive sandbox controls.

| Capability | Backend Endpoint | Portal Status | Gap / Required UI |
|------------|------------------|---------------|-------------------|
| Create Sandbox | `POST /api/v1/sandbox/create` | ❌ Missing | "Launch Sandbox" button with template selection |
| Upload Files | `POST /api/v1/sandbox/{id}/files/upload` | ❌ Missing | File manager UI for active sandboxes |
| Kill Sandbox | `POST /api/v1/sandbox/kill` | ❌ Missing | "Terminate" action for active sandboxes |

**Implementation Workflow**: 
Transform the Sandbox page into an interactive terminal/file manager. Allow users to manually spin up sandboxes, upload context files, execute test commands, and forcefully terminate runaway instances.

## 3. Recommended Implementation Phases

To transition the portal from read-only to fully interactive, we recommend the following phased approach:

### Phase 1: Core Agent CRUD
Focus on the most critical entity: the Agent.
1. Build shared form components (TextInput, Textarea, Select, TagInput) using the new dark theme.
2. Implement the "Create Agent" slide-out panel.
3. Wire up the `POST /api/v1/agents` endpoint.
4. Add row actions (Edit, Clone, Delete) to the Agents table.

### Phase 2: Memory & Knowledge Base
Enable users to manage what their agents know.
1. Build the RAG document upload interface (`POST /api/v1/rag/{agent}/ingest`).
2. Add inline fact creation and editing on the Memory page.
3. Implement secret management in the Governance/Settings area.

### Phase 3: Workflows & Evals
Enable orchestration and testing.
1. Build the Workflow creation UI (YAML editor + DAG visualizer).
2. Wire up workflow execution and cancellation controls.
3. Build the Evaluation trigger UI (`POST /api/v1/eval/run`).

### Phase 4: Runtime & Sandboxes
Expose deep infrastructure controls.
1. Build the interactive Sandbox manager (Create, Upload, Exec, Kill).
2. Add Job control actions (Pause, Resume, Retry) to the Runtime page.
3. Implement Schedule creation and toggling.

## 4. Conclusion

The recent UI overhaul successfully established a professional, E2B-inspired design language and stripped away bloated dependencies. However, the application logic remains heavily biased toward data visualization. By executing the CRUD implementation plan outlined above, `oneshots.co` will realize the full potential of its backend API, transforming into a comprehensive, interactive Agent Infrastructure Platform.
