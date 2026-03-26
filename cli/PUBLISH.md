# Publishing AgentOS CLI

## Overview

The AgentOS CLI is published to **npm** (which Bun uses natively). Bun users can install it with:

```bash
bun install -g @agentos/cli
```

## Prerequisites

1. npm account with access to `@agentos` scope
2. Bun installed (optional, for testing)

## Publish Steps

### 1. Prepare Release

```bash
cd cli

# Install dependencies
npm install

# Run tests
npm test

# Build the project
npm run build

# Verify CLI works
node dist/cli.js --version
```

### 2. Update Version (if needed)

```bash
npm version patch  # or minor, major
```

### 3. Publish to npm

```bash
# Login to npm (if not already logged in)
npm login

# Publish
npm publish --access public
```

### 4. Verify Installation

```bash
# Via npm
npm install -g @agentos/cli
agentos --version

# Via Bun
bun install -g @agentos/cli
agentos --version

# Via npx
npx @agentos/cli --version
```

## Build Options

### Standard Build (TypeScript compilation)
```bash
npm run build
```

Produces: `dist/cli.js` (unbundled, requires node_modules)

### Bundled Build (single file)
```bash
npm run build:bundle
```

Produces: `dist/cli.js` (bundled with esbuild, self-contained)

### Bun Build (Bun bundler)
```bash
npm run build:bun
```

Produces: `dist/cli.js` (bundled with Bun)

## Package Contents

Published files (via `files` field in package.json):
- `dist/` — Compiled JavaScript
- `README.md` — Package documentation
- `LICENSE` — License file

## Tags

Use tags for different release channels:

```bash
# Beta release
npm publish --tag beta

# Latest (default)
npm publish --tag latest
```

Users can install specific tags:
```bash
bun install -g @agentos/cli@beta
```

## Troubleshooting

### "You do not have permission"
Ensure you're logged in and have access to `@agentos` scope:
```bash
npm login
npm access list packages @agentos
```

### "Package already exists"
Bump the version:
```bash
npm version patch
npm publish
```

### Build fails
Clear and rebuild:
```bash
rm -rf dist node_modules
npm install
npm run build
```
