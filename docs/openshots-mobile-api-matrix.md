# OpenShots mobile — API matrix (AgentOS control plane)

This document maps **mobile product surfaces** to **HTTP endpoints** on the AgentOS control plane. It is derived from route definitions under `control-plane/src/routes/` (especially `requireScope(...)` middleware). When in doubt, treat `GET /api/v1/openapi.json` on the deployed worker (e.g. `https://api.oneshots.co/api/v1/openapi.json`) as the source of truth for schemas.

**Production API base (typical):** `https://api.oneshots.co`

| Prefix | Use |
|--------|-----|
| `/api/v1` | Authenticated product API (JWT session or org API key with scopes). |
| `/v1` | Public / SDK API (org API key `ak_...`; agent-scoped keys supported). |

**Auth header:** `Authorization: Bearer <token>` — JWT from `/api/v1/auth/login` or API key.

### JWT-first streaming (OpenShots mobile)

Use this for **logged-in users** (JWT). The legacy path on the agents router is **removed**; do not call it.

| | |
|--|--|
| **Do use** | `POST /api/v1/runtime-proxy/runnable/stream` |
| **Auth** | `Authorization: Bearer <JWT>` (same middleware as the rest of `/api/v1`; API keys also work if you need parity tests). |
| **Scope** | No extra `requireScope` on this handler — any authenticated org user with `org_id` / `user_id` is accepted; credits are checked unless `plan` is `free`. |
| **Body (JSON)** | `agent_name` (required), `input` or `task` (message), optional `plan` (`free` \| `basic` \| `standard` \| `premium`), `session_id`, `history` (`[{ role, content }]`. |
| **Response** | `Content-Type: text/event-stream` — SSE `data: {...}` lines; forward `org_id` / `channel_user_id` to the runtime for per-user DO isolation. |
| **Do not use** | `POST /api/v1/agents/{name}/run/stream` — returns **410** with a pointer to `runtime-proxy` (execution is edge-only). |

**Sync (non-streaming) JSON run:** `POST /api/v1/runtime-proxy/agent/run` — same auth pattern; returns JSON when you do not need SSE.

**Alternative (SDK namespace):** `POST /v1/agents/{name}/run/stream` — still valid; same global `Bearer` auth accepts JWT or `ak_` per `auth.ts`.

---

## 1. Bootstrap & account

| Mobile screen / flow | Method | Path | Scope / notes |
|----------------------|--------|------|----------------|
| Login | `POST` | `/api/v1/auth/login` | Body: credentials. Returns JWT. |
| Signup | `POST` | `/api/v1/auth/signup` | Returns JWT. |
| Current user / session restore | `GET` | `/api/v1/auth/me` | Validates token. |
| Logout | `POST` | `/api/v1/auth/logout` | Invalidate server-side session if used. |
| Change password | `PATCH` or as documented | `/api/v1/auth/password` | See OpenAPI for method. |

---

## 2. End-user chat (SDK-style, API key friendly)

Use when the app is wired with an **org API key** and should only run agents (no full dashboard scopes). All paths below are **`/v1`** (not `/api/v1`).

| Mobile screen / flow | Method | Path | Scope / notes |
|----------------------|--------|------|----------------|
| Health | `GET` | `/v1/health` | API key; org resolved from key or custom domain. |
| Run agent (sync) | `POST` | `/v1/agents/{name}/run` | JSON body: `input`, optional `conversation_id`, `model`, etc. Credit gate may return `402`. |
| Run agent (SSE stream) | `POST` | `/v1/agents/{name}/run/stream` | Server-Sent Events; parse on mobile with an SSE-capable client. |
| Run with file upload | `POST` | `/v1/agents/{name}/run/upload` | `multipart/form-data`. |
| List conversations | `GET` | `/v1/agents/{name}/conversations` | Thread list for the agent. |
| Create / append conversation | `POST` | `/v1/agents/{name}/conversations` | Continue or create thread. |
| Get conversation | `GET` | `/v1/agents/{name}/conversations/{id}` | Load messages. |
| Delete conversation | `DELETE` | `/v1/agents/{name}/conversations/{id}` | |

**Implementation note:** Keys can be restricted to specific `allowedAgents` in middleware — handle `403` in the client.

---

## 3. Agents (CRUD & discovery)

Base: **`/api/v1/agents`**

| Mobile screen / flow | Method | Path | Scope / notes |
|----------------------|--------|------|----------------|
| Agent list / home | `GET` | `/api/v1/agents` | Authenticated; no explicit `requireScope` on list handler — still requires valid org user/key. |
| Agent detail | `GET` | `/api/v1/agents/{name}` | Same as above. |
| Create agent | `POST` | `/api/v1/agents` | `agents:write` |
| Update agent | `PUT` | `/api/v1/agents/{name}` | `agents:write` |
| Delete agent | `DELETE` | `/api/v1/agents/{name}` | `agents:write` |
| Create from natural language | `POST` | `/api/v1/agents/create-from-description` | `agents:write` |
| List versions | `GET` | `/api/v1/agents/{name}/versions` | `agents:read` |
| Version restore | `POST` | `/api/v1/agents/{name}/versions/{commitId}/restore` | `agents:write` |
| List tools (from config) | `GET` | `/api/v1/agents/{name}/tools` | Authenticated (no scope on route). |
| Raw config | `GET` | `/api/v1/agents/{name}/config` | Authenticated. |
| Clone | `POST` | `/api/v1/agents/{name}/clone` | `agents:write` |
| Import / export | `POST` `/api/v1/agents/import`, `GET` `/api/v1/agents/{name}/export` | `agents:write` / read where applicable |
| Evolve (suggestions) | `POST` | `/api/v1/agents/{name}/evolve` | `agents:write` |
| Trash / restore | `GET` `/api/v1/agents/{name}/trash`, `POST` restore | `agents:read` / `agents:write` |
| Templates | `GET` | `/api/v1/agents/templates`, `/api/v1/agents/templates/{id}` | See OpenAPI |

---

## 4. Meta-agent (operator chat)

| Mobile screen / flow | Method | Path | Scope / notes |
|----------------------|--------|------|----------------|
| Meta-agent turn | `POST` | `/api/v1/agents/{name}/meta-chat` | `agents:write` — body includes `messages[]`, optional `mode` (`demo` \| `live`). Returns `response`, `messages`, `cost_usd`, `turns`. |

Use a **dedicated UI surface** (thread) so users do not confuse this with end-user chat.

---

## 5. Evaluation engine

Base: **`/api/v1/eval`**

| Mobile screen / flow | Method | Path | Scope / notes |
|----------------------|--------|------|----------------|
| List runs | `GET` | `/api/v1/eval/runs` | `eval:read` — query: `agent_name`, `limit` |
| Run detail | `GET` | `/api/v1/eval/runs/{run_id}` | `eval:read` |
| Trials | `GET` | `/api/v1/eval/runs/{run_id}/trials` | `eval:read` |
| Delete run | `DELETE` | `/api/v1/eval/runs/{run_id}` | `eval:run` |
| Start eval | `POST` | `/api/v1/eval/run` | `eval:run` — proxies to runtime `eval/run` |
| Task sets (R2) | `GET` `/api/v1/eval/tasks`, `POST` `/api/v1/eval/tasks`, upload `/api/v1/eval/tasks/upload` | `eval:read` / `eval:run` |
| Datasets | `GET`/`POST` `/api/v1/eval/datasets`, `GET`/`DELETE` `/api/v1/eval/datasets/{name}` | `eval:read` / `eval:run` |
| Evaluators | `GET`/`POST` `/api/v1/eval/evaluators`, `GET`/`DELETE` `/api/v1/eval/evaluators/{name}` | `eval:read` / `eval:run` |
| Experiments | `GET`/`POST` `/api/v1/eval/experiments` | `eval:read` / `eval:run` |
| Progress | `GET` | `/api/v1/eval/runs/{run_id}/progress` | `eval:read` |

**Gate / rollout** logic (pass rate vs min trials) is enforced server-side when promoting releases — see agents/releases routes and `control-plane/src/logic/gate-pack.ts`; the mobile client surfaces numbers and actions only.

---

## 6. Training (optional mobile surface)

Base: **`/api/v1/training`**

| Flow | Method | Path | Scope |
|------|--------|------|--------|
| Create job | `POST` | `/api/v1/training/jobs` | `training:write` |
| List jobs | `GET` | `/api/v1/training/jobs` | `training:read` |
| Job detail | `GET` | `/api/v1/training/jobs/{job_id}` | `training:read` |
| Step / progress / stream | `POST` `/jobs/{job_id}/step`, `GET` progress, `GET` stream | `training:write` / `training:read` |
| Cancel / delete | | `/api/v1/training/jobs/{job_id}` | `training:write` |
| Resources / rewards / rollback | under `/api/v1/training/resources/...`, `/rewards/...` | See OpenAPI | `training:read` / `training:write` |

Long-running jobs: prefer **polling** `progress` or **streaming** endpoints rather than blocking the UI.

---

## 7. Releases & channels

Base: **`/api/v1/releases`**

| Mobile screen / flow | Method | Path | Scope / notes |
|----------------------|--------|------|----------------|
| List channels | `GET` | `/api/v1/releases/{agent_name}/channels` | `releases:read` |
| Promote | `POST` | `/api/v1/releases/{agent_name}/promote` | `releases:write` |
| Canary / validate / rollback | `GET`/`POST`/`DELETE` under `/api/v1/releases/{agent_name}/canary/...` | `releases:read` / `releases:write` |
| Auto-promote / auto-rollback | `POST` | `/api/v1/releases/:agent_name/auto-promote`, `auto-rollback` | `releases:write` |

---

## 8. Sessions, traces, feedback (activity)

Base: **`/api/v1/sessions`**

| Flow | Method | Path | Scope |
|------|--------|------|--------|
| List sessions | `GET` | `/api/v1/sessions` | `sessions:read` |
| Session detail | `GET` | `/api/v1/sessions/{session_id}` | `sessions:read` |
| Turns | `GET` | `/api/v1/sessions/{session_id}/turns` | `sessions:read` |
| Trace | `GET` | `/api/v1/sessions/{session_id}/trace` | `sessions:read` |
| Feedback | `POST` | `/api/v1/sessions/.../feedback` (see OpenAPI) | `sessions:write` |
| Delete / export / search | See `sessions.ts` | | `sessions:read` / `sessions:write` |

---

## 9. Dashboard & KPIs (lightweight mobile)

Base: **`/api/v1/dashboard`**

| Flow | Method | Path | Scope |
|------|--------|------|--------|
| Summary cards | `GET` | `/api/v1/dashboard/...` | `observability:read` |
| Stats | `GET` | `/api/v1/dashboard/stats/by-agent`, `by-model`, `tool-health`, `routing`, `trends` | `observability:read` |

---

## 10. Projects & org structure

| Flow | Method | Path | Scope |
|------|--------|------|--------|
| Projects | `GET`/`POST` | `/api/v1/projects` | `projects:read` / `projects:write` |
| Project detail | `GET`/`PATCH` | `/api/v1/projects/{id}` | `projects:read` / `projects:write` |

---

## 11. LLM plans

Base: **`/api/v1/plans`**

| Flow | Method | Path | Scope / notes |
|------|--------|------|----------------|
| List built-in plans | `GET` | `/api/v1/plans` | Authenticated; returns summarized tiers. |
| Get plan | `GET` | `/api/v1/plans/{name}` | Authenticated. |
| Create custom plan | `POST` | `/api/v1/plans` | Persists under org `project_configs`; requires org context. |

---

## 12. Org settings & billing (settings tab)

| Flow | Method | Path | Scope |
|------|--------|------|--------|
| Org CRUD / members | `GET`/`POST`/`PATCH` | `/api/v1/orgs`, `/api/v1/orgs/{org_id}/members`, etc. | `orgs:read` / `orgs:write` |
| Org settings | `GET`/`PATCH` | `/api/v1/orgs/settings` | See `orgs.ts` |
| Credits / balance | `GET` | `/api/v1/credits/...` | `billing:read` |
| API keys (manage keys) | `GET`/`POST`/`DELETE` | `/api/v1/api-keys` | `api_keys:read` / `api_keys:write` |

---

## 13. Runtime proxy (advanced)

Base: **`/api/v1/runtime-proxy`**

Mobile clients should **rarely** call this directly; prefer **`/v1`** for runs or **`/api/v1/eval/run`** for evals. Use runtime-proxy only if you replicate operator tooling (debug, specialized tool calls) — see OpenAPI and `runtime-proxy.ts`.

---

## 14. Suggested OpenShots mobile phases (API usage)

1. **Auth + agent list + chat** — JWT: `GET /api/v1/agents`, then either `POST /v1/agents/{name}/run/stream` (device API key) or authenticated run paths per your product choice.
2. **Sessions + traces** — `sessions:read` for activity views.
3. **Meta-agent** — `POST /api/v1/agents/{name}/meta-chat` with `agents:write`.
4. **Eval** — `eval:read` for dashboards; `eval:run` to start runs.
5. **Releases** — `releases:read` / `releases:write` for promote when UX requires it.

---

## 15. What this matrix does not cover

- **Deploy/runtime (`deploy/`)** Durable Object URLs are not a stable mobile contract; always go through the control plane.
- **WebUI (`webui/`)** — llama.cpp server UI; different protocol, not this matrix.
- **Legacy MVP / portal** — reference for screens only; APIs are the same control plane as above.

---

*Generated from AgentOS control-plane routes. Regenerate or diff when adding routes.*
