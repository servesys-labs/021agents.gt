# AgentOS CLI

The official command-line interface for AgentOS — build, run, and deploy autonomous AI agents.

## Installation

### Via Bun (Recommended - Fastest)

```bash
bun install -g @agentos/cli
```

### Via npm

```bash
npm install -g @agentos/cli
```

### Via npx (No Install)

```bash
npx @agentos/cli --help
```

## Quick Start

```bash
# Login to AgentOS
agentos login

# Initialize a project
agentos init my-project --template research
cd my-project

# Create an agent
agentos create --one-shot "a research assistant that finds papers"

# Deploy to Cloudflare
agentos deploy research-assistant

# Run the agent
agentos run research-assistant "What are the latest RLHF advances?"

# Interactive chat
agentos chat research-assistant
```

## Commands

### Core
- `agentos init [dir]` — Scaffold new project
- `agentos create` — Create agent (conversational)
- `agentos create -1 DESC` — Create from description
- `agentos run <agent> <task>` — Run agent
- `agentos chat <agent>` — Interactive chat
- `agentos list` — List agents
- `agentos deploy <agent>` — Deploy to Cloudflare

### Quality Assurance
- `agentos eval run <agent>` — Run evaluation
- `agentos eval list` — View eval results
- `agentos evolve analyze <agent>` — Analyze for improvements
- `agentos evolve proposals <agent>` — List proposals

### Operations
- `agentos sessions` — View sessions
- `agentos traces <id>` — View trace
- `agentos issues list` — List issues
- `agentos security scan <agent>` — Security scan

### Management
- `agentos skills list` — List skills
- `agentos tools list` — List tools
- `agentos billing usage` — View usage
- `agentos releases list <agent>` — View releases

## Bun Optimization

This CLI is optimized for Bun:
- **Faster installs**: Bun's package resolution
- **Faster execution**: Bun's JavaScript runtime
- **Native TypeScript**: No transpilation needed for development

```bash
# Development with Bun
bun run dev -- init my-project

# Build with Bun
bun run build:bun

# Test with Bun
bun test
```

## Configuration

The CLI stores config in `~/.agentos/`:
- `config.json` — API URL, default model
- `auth.json` — Authentication tokens

Environment variables:
```bash
export AGENTOS_API_URL=https://api.agentos.dev
```

## Documentation

- [AgentOS Docs](https://docs.agentos.dev)
- [API Reference](https://api.agentos.dev/docs)

## License

MIT
