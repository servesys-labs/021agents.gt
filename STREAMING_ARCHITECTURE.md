# Streaming Transport Architecture

**Date**: 2026-04-13
**Problem**: WebSocket connections fail due to auth permission issue; UI/mobile fall back to SSE-over-POST which works but lacks bidirectionality.

---

## The Permission Issue

The Agents SDK's `routeAgentRequest()` handles WebSocket upgrades for paths like `/agents/:name/:id`. Before routing, `authorizeAgentIngress()` calls `extractBearerToken(request)` which reads the `Authorization` header.

**The problem**: Browsers cannot set custom headers on WebSocket connections. The `new WebSocket(url)` API has no headers parameter. So the `Authorization: Bearer <token>` header is never sent, and `authorizeAgentIngress` returns 401.

```
Browser:  new WebSocket("wss://runtime.oneshots.co/agents/my-agent/session-1")
                                                    ↓
Server:   authorizeAgentIngress(request, env)
            → extractBearerToken(request)
            → request.headers.get("Authorization")   ← null
            → return 401 Unauthorized                 ← BLOCKED
```

This is why the entire platform fell back to SSE. The WebSocket path has been broken for browsers since day one.

---

## Current Transport Map

| Client | Transport | Path | Auth | Bidirectional |
|--------|-----------|------|------|---------------|
| UI (SvelteKit) | SSE via POST | `/api/v1/runtime-proxy/runnable/stream` | Bearer header | No |
| Mobile (React Native) | SSE via POST | `/api/v1/runtime-proxy/runnable/stream` | Bearer header | No |
| Widget | SSE via POST | `/api/v1/runtime-proxy/runnable/stream` | Bearer header | No |
| CLI | REST (buffered) | `/api/v1/runtime-proxy/agent/run` | Bearer header | No |
| Telegram/WhatsApp/etc | REST (buffered) | Webhook → DO → Workflow | Service token | No |
| MCP | HTTP POST | `/agents/mcp-server/...` | Bearer header | No |
| Voice | WebSocket | `/voice/relay` | Bearer in first msg | Yes |

**Every real-time channel uses SSE or REST.** The Agents SDK's native WebSocket transport is unused by any client.

---

## Target Architecture: WebSocket Primary, SSE Fallback

```
                    ┌─────────────────────────────────┐
                    │        Client (any)              │
                    │                                  │
                    │  1. Try WebSocket upgrade        │
                    │     with token in query param    │
                    │     or subprotocol               │
                    │                                  │
                    │  2. If WS fails (403, network,   │
                    │     proxy blocking, etc.):       │
                    │     Fall back to SSE POST        │
                    └─────────┬───────────┬────────────┘
                              │           │
                         WebSocket      SSE POST
                              │           │
                    ┌─────────▼───────────▼────────────┐
                    │      Agent DO (AgentOSAgent)      │
                    │                                   │
                    │  WebSocket: onConnect/onMessage    │
                    │    → bidirectional, real-time      │
                    │    → state sync, typing indicators │
                    │    → cancel in-flight runs         │
                    │                                   │
                    │  SSE: onRequest POST /run/stream   │
                    │    → unidirectional, HTTP-based    │
                    │    → works through all proxies     │
                    │    → no cancel (client aborts)     │
                    └───────────────────────────────────┘
```

---

## Fix: WebSocket Auth via Query Parameter + Subprotocol

Three standard patterns for WebSocket auth (since headers don't work):

### Option A: Token in query parameter (recommended)

```
Client:  new WebSocket("wss://runtime.oneshots.co/agents/my-agent/session-1?token=eyJ...")
Server:  extract token from url.searchParams.get("token")
```

**Pros**: Simplest, works everywhere, Agents SDK `routeAgentRequest` passes the full URL through.
**Cons**: Token appears in server access logs (mitigated: tokens are short-lived JWTs).

### Option B: Token in WebSocket subprotocol

```
Client:  new WebSocket(url, ["bearer", token])
Server:  extract from request.headers.get("Sec-WebSocket-Protocol")
```

**Pros**: Token not in URL/logs.
**Cons**: Non-standard use of subprotocol field.

### Option C: Post-connect auth message (current pattern)

```
Client:  ws.send(JSON.stringify({ type: "auth", token: "..." }))
Server:  validate in onMessage, reject commands until authenticated
```

**Pros**: Already implemented in the DO's onMessage handler.
**Cons**: The problem is `authorizeAgentIngress` runs BEFORE the connection reaches the DO.

### Recommended: Option A + C combined

1. **Fix `authorizeAgentIngress`** to also check query params (for WebSocket upgrades)
2. **Keep post-connect auth** as defense-in-depth (already exists in onMessage)
3. **Client tries WS first**, falls back to SSE if WS fails

---

## Implementation Plan

### Step 1: Fix authorizeAgentIngress for WebSocket

```typescript
async function authorizeAgentIngress(request: Request, env: Env): Promise<Response | null> {
  // Try Authorization header first (works for HTTP, SSE, MCP)
  let token = extractBearerToken(request);

  // For WebSocket upgrades: browsers can't set headers, so check query param
  if (!token && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const url = new URL(request.url);
    token = url.searchParams.get("token") || null;
  }

  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

  const serviceToken = String(env.SERVICE_TOKEN || "").trim();
  if (serviceToken && token === serviceToken) return null;

  const jwtSecret = String(env.AUTH_JWT_SECRET || "").trim();
  if (jwtSecret && (await verifyHs256Jwt(token, jwtSecret))) return null;

  return Response.json({ error: "unauthorized" }, { status: 401 });
}
```

### Step 2: Unified client transport class

```typescript
class AgentTransport {
  private ws: WebSocket | null = null;
  private sseAbort: AbortController | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
    private agentName: string,
    private sessionId: string,
  ) {}

  async connect(onEvent: (event: ChatEvent) => void): Promise<void> {
    // Try WebSocket first
    try {
      await this.connectWebSocket(onEvent);
      return;
    } catch {
      // WebSocket failed — fall back to SSE
    }
    // SSE fallback (always works)
    this.connectSSE(onEvent);
  }

  private connectWebSocket(onEvent: (event: ChatEvent) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl
        .replace("https://", "wss://")
        .replace("http://", "ws://");
      const url = `${wsUrl}/agents/${this.agentName}/${this.sessionId}?token=${this.token}`;
      
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        // Post-connect auth (defense in depth)
        this.ws!.send(JSON.stringify({ type: "auth", token: this.token }));
        resolve();
      };
      this.ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        onEvent({ type: data.type, data });
      };
      this.ws.onerror = () => reject(new Error("WebSocket failed"));
      this.ws.onclose = (ev) => {
        if (ev.code === 4001) reject(new Error("Unauthorized"));
      };
    });
  }

  private connectSSE(onEvent: (event: ChatEvent) => void): void {
    // Existing SSE logic — POST to /api/v1/runtime-proxy/runnable/stream
    // This always works (HTTP, no upgrade, no header restrictions)
  }

  send(message: string, sessionId?: string, plan?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // WebSocket: bidirectional — send directly
      this.ws.send(JSON.stringify({
        type: "run",
        input: message,
        session_id: sessionId,
        plan,
      }));
    } else {
      // SSE: start a new POST request
      // (already handled by connectSSE)
    }
  }

  // WebSocket-only capabilities (not available in SSE mode)
  cancel(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel" }));
    }
    // SSE: abort the fetch controller
    this.sseAbort?.abort();
  }

  disconnect(): void {
    this.ws?.close();
    this.sseAbort?.abort();
  }
}
```

### Step 3: Per-channel transport selection

| Channel | Primary | Fallback | Why |
|---------|---------|----------|-----|
| UI (browser) | WebSocket | SSE POST | Browsers support both; WS gives cancel + typing |
| Mobile (React Native) | WebSocket | SSE POST | RN supports WebSocket natively |
| Widget (embedded) | SSE POST | — | Widgets run in iframes that may block WS |
| CLI | REST (buffered) | — | CLI doesn't need streaming |
| Telegram/WhatsApp/Slack | REST → Workflow | — | Webhooks are request/response, no streaming |
| MCP | SSE (SDK handles) | — | MCP protocol uses SSE transport |
| Voice | WebSocket | — | Real-time audio requires bidirectional |

### Step 4: What WebSocket enables that SSE can't

Once WebSocket works, these features become possible:

1. **Cancel in-flight runs** — client sends `{ type: "cancel" }`, DO terminates Workflow
2. **Real-time typing indicators** — both directions
3. **SDK state sync** — Agent SDK automatically syncs `this.state` to connected clients
4. **Multi-tab awareness** — `broadcast()` sends peer_connected/disconnected events
5. **Progress without KV polling** — Workflow writes to DO SQLite, DO pushes to WS directly
   (eliminates the KV eventual-consistency lag that causes the "done event delayed" bug)
6. **Reconnect with replay** — client sends `{ type: "reconnect", from_seq: N }`,
   DO replays missed events from its buffer

---

## Relationship to Composable Architecture

In the composable model, the transport layer lives in the **Gateway Worker**:

```
Gateway Worker:
  - Accept WebSocket upgrade (with query-param auth)
  - Forward to Agent Core via service binding
  - If WebSocket not supported (widget, proxy), use SSE POST
  - Return appropriate transport based on client capabilities

Agent Core Worker:
  - AgentOSAgent DO handles both WS and SSE
  - onConnect/onMessage for WebSocket clients
  - onRequest POST /run/stream for SSE clients
  - Same event protocol for both transports
```

The **event protocol is transport-agnostic** — both WebSocket and SSE emit the same JSON events:
```json
{"type": "session_start", "session_id": "..."}
{"type": "turn_start", "turn": 1, "model": "..."}
{"type": "tool_call", "name": "web-search", "tool_call_id": "..."}
{"type": "tool_result", "name": "web-search", "result": "..."}
{"type": "token", "content": "Here's what I found..."}
{"type": "done", "output": "...", "cost_usd": 0.003}
```

---

## Implementation Priority

1. **Fix `authorizeAgentIngress`** — 10 lines, unblocks WebSocket for all clients (Sprint 1)
2. **Add `AgentTransport` class to SDK package** — shared by UI, mobile, widget (Sprint 2)
3. **Wire UI to prefer WebSocket** — modify `chat.ts` to use AgentTransport (Sprint 3)
4. **Wire mobile to prefer WebSocket** — modify `streamAgent.ts` (Sprint 4)
5. **Add cancel support** — `{ type: "cancel" }` message in onMessage (Sprint 5)
