# Control-Plane Scope Matrix

This is the current route-level authorization matrix for the TypeScript control-plane.

## Public (no user auth)

- `GET /health`
- `GET /health/detailed`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/signup`
- `GET /api/v1/auth/providers`
- `GET /api/v1/config`
- `GET /api/v1/plans` and `GET /api/v1/plans/:id`
- `POST /api/v1/chat/telegram/webhook` (verified in-route)
- `POST /api/v1/stripe/webhook` (verified in-route)
- `POST /api/v1/voice/vapi/webhook` and `POST /api/v1/voice/tavus/webhook` (verified in-route)

## Scoped Route Families

| Route family | Read scope | Write scope |
| --- | --- | --- |
| `agents` | `agents:read` | `agents:write` |
| `api-keys` | `api_keys:read` | `api_keys:write` |
| `billing` and `stripe` (except webhook) | `billing:read` | `billing:write` |
| `deploy` | `deploy:read` | `deploy:write` |
| `eval` | `eval:read` | `eval:run` |
| `evolve` | `evolve:read` | `evolve:write` |
| `graphs` | `graphs:read` | `graphs:write` |
| `guardrails` | `guardrails:read` | `guardrails:write` |
| `integrations` (`voice`, `chat-platforms`, `mcp-control`, `connectors`) | `integrations:read` | `integrations:write` |
| `conversation-intel` | `intelligence:read` | `intelligence:write` |
| `issues` | `issues:read` | `issues:write` |
| `jobs` | `jobs:read` | `jobs:write` |
| `memory` | `memory:read` | `memory:write` |
| `orgs` | `orgs:read` | `orgs:write` |
| `observability` | `observability:read` | `observability:write` |
| `policies` | `policies:read` | `policies:write` |
| `projects` | `projects:read` | `projects:write` |
| `security` | `security:read` | `security:write` |
| `rag` | `rag:read` | `rag:write` |
| `releases` | `releases:read` | `releases:write` |
| `retention` | `retention:read` | `retention:write` |
| `gpu` | `gpu:read` | `gpu:write` |
| `gold-images` | `gold_images:read` | `gold_images:write` |
| `dlp` | `dlp:read` | `dlp:write` |
| `schedules` | `schedules:read` | `schedules:write` |
| `secrets` | `secrets:read` | `secrets:write` |
| `sessions` | `sessions:read` | `sessions:write` |
| `slos` | `slos:read` | `slos:write` |
| `webhooks` | `webhooks:read` | `webhooks:write` |
| `workflows` | `workflows:read` | `workflows:write` |
| `sandbox` | `sandbox:read` | `sandbox:write` |
| `autoresearch` | `autoresearch:read` | `autoresearch:write` |
| `components` | `components:read` | `components:write` |
| `compare` | `compare:read` | n/a |

## Service-token protected internals (no user scope)

- `POST /api/v1/edge-ingest/sessions`
- `POST /api/v1/edge-ingest/turns`
- `POST /api/v1/runtime-proxy/tool/call`

These endpoints fail closed if `SERVICE_TOKEN` is not configured.

## Notes

- JWT users currently receive `["*"]` and bypass per-scope checks.
- API-key users must carry explicit scopes (or category wildcard like `jobs:*`).
- Route-level scopes are enforced in handlers using `requireScope(...)`.

## Remaining Known Gaps

Known route families with mixed/legacy auth patterns still to normalize end-to-end:

- `auth` (public/authenticated mixed by design)
- `runtime-proxy` and `edge-ingest` (service-token protected internal routes)
