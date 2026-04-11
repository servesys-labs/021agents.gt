# AgentOS — Agent Control Plane

Build, test, govern, deploy, and observe AI agents. The Vercel for agents.

**oneshots CLI + control-plane API + UI portal + Workers runtime** — one platform from local development to production SaaS.

## Quick Start

### Prerequisites

- **Node.js 18+** and **pnpm** (runtime, control-plane, UI)
- **Bun 1.0+** (preferred builder for the `oneshots` CLI — optional, `tsx` works too)

### Build and link the CLI

```bash
cd cli
npm install
npm run build       # writes dist/cli.js
npm link            # makes `oneshots` available on your PATH
```

### Create and Run an Agent

```bash
# Authenticate against your control-plane
oneshots login

# Create an agent (conversational or one-shot)
oneshots create --one-shot "a research assistant that finds and summarizes papers"

# Deploy it to the control-plane
oneshots deploy research-assistant

# Run / chat / eval — all hit the control-plane REST API
oneshots run research-assistant "What are the latest advances in RLHF?"
oneshots chat research-assistant
oneshots eval run research-assistant --trials 5

# Start the UI portal (SvelteKit)
cd ui && pnpm install && pnpm dev
```

The repo is pure TypeScript. There is no Python runtime, no Python CLI, and no Python packaging. Any residual `python3` invocations in `scripts/*.sh` are stdlib-only helpers for JSON parsing in shell heredocs.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   UI Portal (ui/, SvelteKit)                    │
│  Canvas · Sessions · Intelligence · Compliance · Issues · ...   │
├─────────────────────────────────────────────────────────────────┤
│                 oneshots CLI (cli/, TypeScript)                 │
│  commander-based, calls control-plane REST API                  │
├─────────────────────────────────────────────────────────────────┤
│          Control Plane (control-plane/, TypeScript)             │
│  Cloudflare Worker · Hono · RBAC · Rate limiting · Queue + Cron │
├─────────────────────────────────────────────────────────────────┤
│               Runtime (deploy/, TypeScript)                     │
│  Cloudflare Worker · graph execution · tools · skills           │
├─────────────────────────────────────────────────────────────────┤
│   Supporting Workers: ops/ · voice-agent/ · widget/ · mobile/   │
├─────────────────────────────────────────────────────────────────┤
│                     Storage                                     │
│  Postgres (Hyperdrive) · R2 · KV                                │
└─────────────────────────────────────────────────────────────────┘
```

The entire stack is TypeScript on Cloudflare Workers. There is no Python runtime, no FastAPI, no SQLite, no Python CLI. That Python-era architecture was fully migrated.

## CLI Reference

`oneshots` is the only CLI. Source: `cli/src/`. Package: `@oneshots/cli`. Every command calls the control-plane REST API.

| Command | What it does |
|---|---|
| `oneshots init [dir]` | Scaffold a new agent project |
| `oneshots login` / `logout` / `whoami` | Authentication |
| `oneshots create` / `create --one-shot DESC` | Create an agent (conversational or one-shot) |
| `oneshots list` | List agents |
| `oneshots run <agent> "task"` | Run an agent |
| `oneshots chat <agent>` | Interactive chat |
| `oneshots deploy <agent>` | Deploy |
| `oneshots eval <cmd>` | Evaluations (list / run / status) |
| `oneshots evolve <cmd>` | Analyze + improve agents |
| `oneshots sessions` / `traces <id>` | Observability |
| `oneshots skills <cmd>` | Skill management |
| `oneshots tools <cmd>` | Tool registry |
| `oneshots graph <cmd>` / `memory <cmd>` | Agent graph / memory inspection |
| `oneshots releases <agent>` / `workflow <cmd>` / `schedules <cmd>` | Release, workflow, schedule management |
| `oneshots jobs` | Background jobs |
| `oneshots research <cmd>` | Autoresearch |
| `oneshots connectors` | Integration management |
| `oneshots billing` | Usage and costs |
| `oneshots issues <cmd>` / `security <cmd>` / `compliance <cmd>` | Ops, security, compliance |
| `oneshots sandbox <cmd>` | Sandbox management |
| `oneshots secrets <cmd>` / `tokens <cmd>` / `api-keys <cmd>` / `domains <cmd>` | Secrets, tokens, keys, domains |

Source of truth: `cli/src/cli.ts`.

### Subsystems

| Subsystem | Directory | Description |
|---|---|---|
| **CLI** | `cli/` | `@oneshots/cli` — commander-based Bun/Node CLI. Binary: `oneshots`. |
| **Control Plane** | `control-plane/` | Cloudflare Worker · Hono routers · RBAC · Postgres via Hyperdrive |
| **Runtime** | `deploy/` | Cloudflare Worker · graph execution engine · tools · skills |
| **UI Portal** | `ui/` | SvelteKit admin/operator portal |
| **SDK** | `sdk/` | TypeScript client SDK for the control-plane API |
| **Ops Worker** | `ops/` | Separate Cloudflare Worker for operational tasks |
| **Voice Worker** | `voice-agent/` | Voice-agent Cloudflare Worker (Vapi / real-time) |
| **Widget** | `widget/` | Embeddable chat widget bundle |
| **Mobile** | `mobile/` | React Native app shell |
| **Skills** | `skills/public/` | `SKILL.md` files — bundled into the runtime by `deploy/scripts/bundle-skills.mjs` |
| **Agent configs** | `agents/` | `*.json` agent definitions (legacy local-file format; live agents are rows in Postgres) |


## License

MIT
