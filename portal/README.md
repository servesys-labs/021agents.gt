# AgentOS Portal

Refine + Tremor operator portal for AgentOS control-plane APIs.

## Features

- Dashboard for usage, session, and endpoint coverage metrics
- Agents and sessions exploration
- Runtime operations for workflows/jobs
- Sandbox Studio (create, exec, file listing, timeline)
- Integrations (connectors, MCP, webhooks)
- Governance (policies, secrets, audit)
- OpenAPI-driven API Explorer for endpoint inventory

## Local Development

```bash
npm install --legacy-peer-deps
npm run dev
```

Vite proxies API paths to `http://localhost:8340`.

## Auth Configuration

By default, the portal uses local email/password auth (`VITE_AUTH_PROVIDER=local`).

To use Clerk:

```bash
VITE_AUTH_PROVIDER=clerk
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

The backend must also be configured for Clerk exchange:

```bash
AGENTOS_AUTH_PROVIDER=clerk
AGENTOS_CLERK_ISSUER=https://<your-clerk-issuer>
```

Clerk mode includes:
- Silent backend token re-exchange before expiry
- Session-expired messaging on the login experience
- Sidebar countdown of remaining session lifetime

## Quality Gates

```bash
npm run typecheck
npm run test
npm run lint
npm run build
```
