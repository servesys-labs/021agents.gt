# Agent Harness

Multi-tenant managed agent harness platform on Cloudflare Workers. Create and manage AI agents without the complexity of deployment — 100% Cloudflare primitives.

## Architecture

Built entirely on Cloudflare's stack:

- **AIChatAgent** — Chat with SQLite persistence, resumable streaming, tool calling
- **Workers AI** — Model inference via `@cf/moonshotai/kimi-k2.5`
- **CodeMode** — Model writes JavaScript to orchestrate multi-tool workflows (`@cloudflare/codemode`)
- **Browser Rendering API** — Puppeteer-powered headless browser for screenshots & content extraction (`@cloudflare/puppeteer`)
- **Cloudflare Sandbox** — Isolated code execution containers (GA April 2026)
- **Outbound Workers** — Zero-trust credential injection for sandbox network egress
- **Durable Object Facets** — Per-tenant agent isolation with independent SQLite via `ctx.facets`
- **Dynamic Workers** — Runtime code loading via `worker_loaders` binding
- **AgentSupervisor DO** — Manages dynamically created agents as DO Facets

## Built-in Agents

| Agent | Tools |
|-------|-------|
| **General Assistant** | webSearch, fetchUrl, browserScreenshot, browserGetContent, getWeather, calculate, codemode |
| **Coding Agent** | All above + execCommand, writeFile, readFile, runCode, gitClone (sandbox) |
| **Customer Support** | webSearch, fetchUrl, browserGetContent, codemode |
| **Research Analyst** | webSearch, fetchUrl, browserScreenshot, browserGetContent, codemode |

All agents also support **MCP server connections** for extensibility.

## Tools

- **webSearch** — DuckDuckGo-powered web search (no API key needed)
- **fetchUrl** — Fetch and read any web page or API
- **browserScreenshot** — Take screenshots via Cloudflare Browser Rendering API
- **browserGetContent** — Render JS-heavy pages and extract text content
- **codemode** — Write JavaScript that programmatically calls multiple tools
- **getWeather** — Open-Meteo weather data (free, no key)
- **calculate** — Math calculations with approval for large numbers
- **Sandbox tools** — execCommand, writeFile, readFile, runCode, gitClone

## Setup

```bash
npm install
```

### Configuration

Set environment variables (secrets via `wrangler secret put`):

- `ACCESS_CODE` — Login access code (set in wrangler.jsonc vars)
- `GITHUB_TOKEN` — (Optional) Injected into sandbox GitHub requests
- `OPENAI_API_KEY` — (Optional) Injected into sandbox OpenAI requests
- `ANTHROPIC_API_KEY` — (Optional) Injected into sandbox Anthropic requests

### Development

```bash
npm start
```

### Deploy

```bash
npm run build
# Patch dist/agent_harness/wrangler.json: remove "containers" key if present
npx wrangler deploy --config dist/agent_harness/wrangler.json
```

> **Note**: The `containers` key must be removed from the dist wrangler.json before deploying — the Cloudflare API doesn't accept it in the deploy payload. `ctx.facets` works in production without the `experimental` compatibility flag.

## API Endpoints

- `GET /api/health` — Health check
- `POST /api/login` — Login with access code
- `GET /api/tenants` — List built-in tenants
- `GET /api/terminal` — WebSocket terminal (sandbox PTY)
- `POST /api/supervisor/agents` — Create a dynamic agent
- `GET /api/supervisor/agents` — List dynamic agents
- `DELETE /api/supervisor/agents/:id` — Delete a dynamic agent
- `POST /api/supervisor/chat/:agentId` — Chat with a facet agent

## Stack

- Cloudflare Workers + Durable Objects + Workers AI + Browser Rendering
- React 19 + Tailwind CSS 4 (client SPA)
- Vite 8 + `@cloudflare/vite-plugin`
- TypeScript 6

## License

Private
