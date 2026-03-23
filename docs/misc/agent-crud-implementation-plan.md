# Agent CRUD Implementation Plan

This document provides the detailed specification for implementing the missing Agent CRUD operations in the oneshots.co portal.

## 1. Current State vs Target State

**Current State:**
- The `/agents` page is a read-only list.
- The `AgentInfo` frontend type is incomplete (missing system prompt, timeout, max turns, governance, etc.).
- There is no UI to create, edit, clone, delete, or import agents.
- The Meta-Agent (`POST /api/v1/agents/create-from-description`) is completely unused.
- Deployment (`/api/v1/deploy`) and Release Channels (`/api/v1/releases`) have no UI.

**Target State:**
A complete "Vercel for Agents" developer experience.
1. **Agent List Page:** Enhanced table with quick actions (Chat, Edit, Deploy, Delete).
2. **AI Assistant Sidebar:** A persistent drawer that lets the Meta-Agent build/edit agents via natural language.
3. **Agent Builder (Form):** A full-page form to manually configure all `AgentConfig` fields.
4. **Agent Detail Page:** A hub showing the agent's config, active release channels, canary splits, and deployment status.

## 2. API Endpoints to Wire

| Operation | Endpoint | Method | Payload |
|-----------|----------|--------|---------|
| Create (Manual) | `/api/v1/agents` | POST | `AgentCreateRequest` |
| Create (AI) | `/api/v1/agents/create-from-description` | POST | `description`, `name`, `tools` |
| Read (Detail) | `/api/v1/agents/{name}` | GET | None |
| Read (Config) | `/api/v1/agents/{name}/config` | GET | None |
| Update | `/api/v1/agents/{name}` | PUT | `AgentCreateRequest` |
| Delete | `/api/v1/agents/{name}` | DELETE | None |
| Clone | `/api/v1/agents/{name}/clone` | POST | `new_name` |
| Import | `/api/v1/agents/import` | POST | `config` (dict) |
| Export | `/api/v1/agents/{name}/export` | GET | None |
| List Tools | `/api/v1/tools` | GET | None |

## 3. Frontend Type Updates

The `src/lib/adapters.ts` file must be updated to reflect the full `AgentConfig` shape:

```typescript
export type AgentGovernance = {
  budget_limit_usd: number;
  blocked_tools: string[];
  require_confirmation_for_destructive: boolean;
};

export type AgentConfig = {
  name: string;
  description: string;
  version: string;
  agent_id: string;
  system_prompt: string;
  personality: string;
  model: string;
  max_tokens: number;
  temperature: number;
  tools: string[];
  max_turns: number;
  timeout_seconds: number;
  plan: string;
  tags: string[];
  governance: AgentGovernance;
};
```

## 4. UI Components & Pages

### 4.1. The AI Assistant Sidebar (Meta-Agent)
A slide-out drawer on the right side of the screen, available globally.
- **Input:** Chat box for natural language description (e.g., "Build an agent that queries our Snowflake DB and summarizes sales").
- **Action:** Calls `POST /api/v1/agents/create-from-description`.
- **Output:** Renders a preview card of the generated agent (Name, Tools selected, Model).
- **Next Step:** "Review & Save" button opens the Agent Builder form pre-filled with the AI's output.

### 4.2. Agent Builder Page (`/agents/new` and `/agents/[name]/edit`)
A comprehensive form with E2B-style dark theme styling.
- **Basic Info:** Name (slug format), Description, Tags.
- **Identity:** System Prompt (textarea), Personality.
- **LLM Settings:** Model dropdown (default: `claude-sonnet-4-20250514`), Temperature slider, Max Tokens.
- **Tools Selection:** Multi-select dropdown populated by `GET /api/v1/tools`.
- **Governance:** Budget limit (USD), Max turns.
- **Actions:** Save (calls `POST` or `PUT`), Cancel.

### 4.3. Agent Detail Page (`/agents/[name]`)
The central hub for a specific agent.
- **Header:** Name, Version, Tags, Edit Button, Clone Button, Delete Button.
- **Config Tab:** Read-only view of the current configuration.
- **Deployment Tab:** 
  - Status card calling `GET /api/v1/deploy/{name}/status`.
  - "Deploy to Cloudflare" button calling `POST /api/v1/deploy/{name}`.
- **Releases Tab:**
  - Table of channels (Draft, Staging, Prod) calling `GET /api/v1/releases/{name}/channels`.
  - "Promote" button calling `POST /api/v1/releases/{name}/promote`.
  - Canary split configuration calling `POST /api/v1/releases/{name}/canary`.
- **Versions Tab:** List of historical versions calling `GET /api/v1/agents/{name}/versions`.

## 5. Execution Sequence

1. **Phase 1: Types & API Hooks**
   - Update `adapters.ts` with full `AgentConfig`.
   - Create custom hooks (`useCreateAgent`, `useUpdateAgent`, `useDeleteAgent`) in `api.ts`.

2. **Phase 2: Agent Builder Form**
   - Build the `AgentForm` component.
   - Implement the Create (`/agents/new`) and Edit (`/agents/[name]/edit`) routes.
   - Wire up the `GET /api/v1/tools` endpoint for the tools multi-select.

3. **Phase 3: List Page Enhancements**
   - Add "Create Agent" button to `/agents`.
   - Add row-level actions (Edit, Delete, Clone) with confirmation modals.

4. **Phase 4: Agent Detail & Lifecycle**
   - Build the `/agents/[name]` detail page.
   - Implement the Deployment and Releases tabs.

5. **Phase 5: AI Assistant Sidebar**
   - Build the sliding drawer component.
   - Wire the `create-from-description` endpoint.
   - Connect the output to the `AgentForm` for review.
