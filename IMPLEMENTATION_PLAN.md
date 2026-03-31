# AgentOS Hardening — Implementation Plan
## Lessons from Claude Code's Agent Architecture

> **Goal**: Bring AgentOS runtime reliability, token efficiency, and security to
> production-grade parity with Claude Code's battle-tested patterns.
>
> **Scope**: 55 improvements across 10 phases. Each item lists affected files,
> what to change, and acceptance criteria.

---

## Phase 0 — Security & Safety (Do First)

These are active vulnerabilities. Ship before anything else.

### 0.1 Unicode Input Sanitization

**Why**: Claude Code runs NFKC normalization + strips tag chars, format controls,
private-use codepoints on every input. AgentOS passes raw user input straight to
the LLM — vulnerable to ASCII smuggling and hidden prompt injection.

**Files**:
- `deploy/src/runtime/sanitize.ts` (NEW)
- `deploy/src/workflow.ts` — call sanitizer on `params.input` + `params.system_prompt_override`

**Implementation**:
```
1. Create sanitize.ts:
   - sanitizeUnicode(text: string): string
     - NFKC normalize
     - Strip \p{Cf} (format controls), \p{Co} (private use), \p{Cn} (unassigned)
     - Explicit removal: U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF, U+E0000-E007F (tags)
     - Iterate until stable (max 10 passes)
   - sanitizeDeep(obj: unknown): unknown — recursively sanitize strings in objects/arrays
2. In workflow.ts Step 2 (Build Messages):
   - Sanitize params.input, params.system_prompt_override, all history entries
3. In tools.ts executeTools():
   - Sanitize tool arguments before dispatch
```

**Acceptance**: Unit test with tag-char-embedded prompt injection attempt; chars stripped, benign text preserved.

---

### 0.2 Media URL SSRF Validation

**Why**: workflow.ts lines ~196-209 embed user-provided `media_urls` without
validation. Attacker can read internal files or metadata endpoints.

**Files**:
- `deploy/src/runtime/tools.ts` — extract existing `isBlockedUrl()` into shared module
- `deploy/src/runtime/ssrf.ts` (NEW) — shared SSRF validator
- `deploy/src/workflow.ts` — validate media URLs before embedding

**Implementation**:
```
1. Extract isBlockedUrl() from tools.ts into ssrf.ts
2. Add IPv6 coverage: ::1, [::1], 0:0:0:0:0:0:0:1, ::ffff:127.0.0.1
3. Block file:// and data:// schemes (allow only https://)
4. In workflow.ts, before building media content parts:
   for (const url of params.media_urls) {
     if (isBlockedUrl(url)) throw new NonRetryableError(`Blocked URL: ${url}`)
   }
```

**Acceptance**: Test with `file:///etc/passwd`, `http://169.254.169.254`, `http://[::1]:8080` — all blocked.

---

### 0.3 System Prompt Override Validation

**Why**: workflow.ts line ~185 accepts arbitrary system prompt overrides with no
size limit or content scanning. OOM or injection risk.

**Files**:
- `deploy/src/workflow.ts`

**Implementation**:
```
1. Cap system_prompt_override at 50,000 chars (throw NonRetryableError if exceeded)
2. Run sanitizeUnicode() on override content (from 0.1)
3. Log override usage to telemetry (flag for review if > 10KB)
```

**Acceptance**: Override >50K chars rejected. Unicode attacks in override stripped.

---

### 0.4 Enforce Rate Limit Fields (Dead Code)

**Why**: auth.ts loads `rateLimitRpm` / `rateLimitRpd` from DB but never checks
them in middleware. Rate limiting is non-functional.

**Files**:
- `control-plane/src/middleware/auth.ts` — wire loaded fields into rate check
- `control-plane/src/middleware/rate-limit.ts` (if separate) — add per-key enforcement

**Implementation**:
```
1. After auth resolves API key, read rateLimitRpm/rateLimitRpd
2. Use CF Worker's built-in rate limiting (or in-memory sliding window with KV backing)
3. Return 429 with Retry-After header when exceeded
```

**Acceptance**: API key with rateLimitRpm=10 gets 429 on 11th request within 60s.

---

## Phase 1 — Runtime Resilience

### 1.1 Persist Circuit Breaker State to DO SQLite

**Why**: `circuitStates` Map in tools.ts is process-scoped. Worker restart resets
all circuit history — flaky tools immediately become available.

**Files**:
- `deploy/src/runtime/tools.ts` — replace in-memory Map with DO SQLite reads/writes
- `deploy/src/index.ts` — add `circuit_breaker_state` table to schema migrations

**Implementation**:
```
1. Add migration: CREATE TABLE circuit_breaker_state (
     tool_name TEXT PRIMARY KEY,
     state TEXT CHECK(state IN ('CLOSED','OPEN','HALF_OPEN')),
     failure_count INTEGER DEFAULT 0,
     success_count INTEGER DEFAULT 0,
     last_failure_at INTEGER,
     opened_at INTEGER
   )
2. On circuit state change: UPDATE circuit_breaker_state SET ...
3. On tool execution start: SELECT state FROM circuit_breaker_state WHERE tool_name = ?
4. Add per-tool configurable thresholds (default: 5 failures = OPEN, 3 successes = CLOSED)
5. Emit circuit state changes to TELEMETRY_QUEUE (not just console.log)
```

**Acceptance**: Restart worker mid-OPEN state → tool still blocked on next request.

---

### 1.2 Budget Enforcement Before Tool Execution

**Why**: Budget checked at turn-loop start but tools execute during the turn.
Expensive tools blow past budget before the next check.

**Files**:
- `deploy/src/workflow.ts` — add pre-execution budget check
- `deploy/src/runtime/tools.ts` — export `estimateToolCost()`

**Implementation**:
```
1. In tools.ts, add estimateToolCost(toolName, args):
   - Use existing TOOL_COSTS flat_usd as minimum estimate
   - For time-based tools (bash, dynamic-exec): estimate duration from args
2. In workflow.ts, before executeTools():
   const estimatedCost = toolCalls.reduce((sum, tc) => sum + estimateToolCost(tc.name, tc.arguments), 0)
   if (totalCost + estimatedCost > config.budget_limit_usd) {
     // Emit warning event, skip tool execution, break loop
   }
```

**Acceptance**: Agent with $0.10 budget at $0.09 spent; next tool estimated at $0.05 → blocked.

---

### 1.3 LLM Call Retry Logic

**Why**: `callLLM()` in llm.ts makes a single fetch. Gateway timeout = immediate
failure. Workflow retries the entire step (re-builds messages, re-selects tools).

**Files**:
- `deploy/src/runtime/llm.ts`

**Implementation**:
```
1. Wrap fetch in retry loop: max 3 attempts
2. Retry on: 429, 529, 502, 503, ECONNRESET
3. Backoff: 500ms, 2000ms, 8000ms
4. On 429: respect Retry-After header (cap at 30s)
5. On 3 consecutive 529s: if fallback model configured, switch model + log to telemetry
6. Do NOT retry: 400, 401, 403, 404 (throw NonRetryableError)
```

**Acceptance**: Simulated 529 on first 2 calls → succeeds on 3rd. 3 consecutive 529s → fallback model used.

---

### 1.4 Workflow Error Handling & Loop Detection

**Why**: Turn loop (lines ~231-526) lacks try-catch outside step.do(). Unknown errors
crash unrecoverably. Loop detection is `TODO`.

**Files**:
- `deploy/src/workflow.ts`

**Implementation**:
```
1. Wrap entire turn loop body in try-catch:
   - Known errors (NonRetryableError) → emit error event, break
   - Unknown errors → emit error event with stack, attempt graceful shutdown
2. Implement loop detection:
   - Track last N tool calls + results (ring buffer, N=5)
   - If same tool called 3x with same args and same error → break with diagnostic
   - If assistant produces identical content 2x → break with "stuck in loop" message
3. Emit loop_detected event type (add to protocol.ts)
```

**Acceptance**: Agent calling `bash("invalid-cmd")` 3x in a row → loop detected, run terminates with diagnostic.

---

### 1.5 Transactional Migrations

**Why**: index.ts runs multiple ALTER TABLE/CREATE TABLE without BEGIN/COMMIT.
Partial migration leaves DB inconsistent.

**Files**:
- `deploy/src/index.ts` — wrap migration blocks in transactions

**Implementation**:
```
1. For each migration version block:
   this.sql.exec("BEGIN")
   try {
     // existing migration statements
     this.sql.exec("UPDATE schema_version SET version = ?", [newVersion])
     this.sql.exec("COMMIT")
   } catch (e) {
     this.sql.exec("ROLLBACK")
     throw e
   }
```

**Acceptance**: Introduce intentional failure mid-migration → version unchanged, no partial schema.

---

## Phase 2 — Token Efficiency

### 2.1 Tool Result Size Management (3-Layer)

**Why**: Claude Code enforces per-tool caps (30-50KB), per-turn aggregate (200KB),
and persists oversized results to disk with preview. AgentOS truncation is
inconsistent (500-10000 chars) with no aggregate budget.

**Files**:
- `deploy/src/runtime/tools.ts` — unified truncation + per-turn budget
- `deploy/src/runtime/result-storage.ts` (NEW) — persist large results to KV

**Implementation**:
```
1. Define size constants:
   DEFAULT_MAX_RESULT_CHARS = 30_000        // per tool
   MAX_RESULTS_PER_TURN_CHARS = 200_000     // aggregate per turn
   PERSIST_THRESHOLD_CHARS = 50_000          // persist to KV above this

2. Per-tool truncation (in executeTools result handling):
   - If result > DEFAULT_MAX_RESULT_CHARS: truncate at last newline within limit
   - Append "[truncated — {originalSize} chars total]"

3. Per-turn aggregate budget:
   - Track cumulative result chars across all tools in a turn
   - If adding next result would exceed MAX_RESULTS_PER_TURN_CHARS:
     truncate to fit remaining budget

4. Large result persistence:
   - If original result > PERSIST_THRESHOLD_CHARS:
     - Write full result to KV: `results/{sessionId}/{toolCallId}.txt`
     - Return first 2000 chars as preview + KV key reference
     - Agent can retrieve full result via read-file tool if needed
```

**Acceptance**: Tool returning 100KB → truncated to 30KB in context. 20 tools × 15KB → aggregate capped at 200KB.

---

### 2.2 Deferred Tool Loading

**Why**: Claude Code sends only ~10 always-loaded tools + a tool index. A
`search_tools` meta-tool loads full schemas on demand. AgentOS sends full schemas
for all matched tools — token waste with 24+ built-in tools.

**Files**:
- `deploy/src/workflow.ts` — implement deferred loading in tool selection
- `deploy/src/runtime/tools.ts` — add `alwaysLoad` flag + tool index builder

**Implementation**:
```
1. Mark core tools as alwaysLoad: true
   (read-file, write-file, edit-file, bash, grep, glob, web-search, run-agent)

2. Build tool index for non-alwaysLoad tools:
   { name: string, one_line: string }[]  // ~50 tokens vs ~500 per full schema

3. Add search_available_tools meta-tool:
   Input: { query: string }
   Output: full schemas for matching tools (max 5)

4. In workflow.ts Step 3 tool selection:
   - Always send alwaysLoad tools with full schema
   - Send tool index as a system message section
   - Include search_available_tools in tool list
```

**Acceptance**: Initial tool payload reduced from ~24 schemas to ~8 + index. Model can discover and use deferred tools.

---

### 2.3 Empty Tool Result Guard

**Why**: Empty `tool_result` at prompt tail can trigger model's stop sequence,
causing premature turn termination.

**Files**:
- `deploy/src/workflow.ts` — guard tool results before appending to messages

**Implementation**:
```
1. After executeTools(), before appending results to messages:
   for (const result of toolResults) {
     if (!result.content || !result.content.trim()) {
       result.content = `(${result.tool_name} completed with no output)`
     }
   }
```

**Acceptance**: Tool returning "" or "   " → replaced with descriptive marker. Model continues normally.

---

### 2.4 Context Compression (Auto-Compact)

**Why**: Claude Code compresses conversation at ~85% context window. AgentOS has
no compression — long sessions hit token limits and stop.

**Files**:
- `deploy/src/runtime/compact.ts` (NEW)
- `deploy/src/workflow.ts` — integrate compaction check in turn loop

**Implementation**:
```
1. Create compact.ts:
   async function shouldCompact(messages, modelMaxTokens): boolean
     - Estimate token count (chars / 4 rough estimate)
     - Return true if > 85% of modelMaxTokens

   async function compactMessages(env, messages, systemPrompt): Message[]
     - Take all messages except last 4 (preserve recent context)
     - Send to LLM: "Summarize this conversation preserving: key decisions,
       file paths mentioned, errors encountered, current task state"
     - Return [summaryMessage, ...last4Messages]

2. In workflow.ts, at top of turn loop:
   if (shouldCompact(messages, modelMaxTokens)) {
     messages = await step.do("compact", { retries: 1 }, () =>
       compactMessages(env, messages, systemPrompt)
     )
     emitEvent({ type: "system", content: "Context compressed" })
   }
```

**Acceptance**: Session with 50 turns compresses to summary + recent 4 turns. Agent continues coherently.

---

### 2.5 Prompt Cache Optimization

**Why**: Claude Code uses a static/dynamic boundary + triple-hash tracking to
maximize Anthropic API prompt cache hits. AgentOS rebuilds prompts from scratch
every turn.

**Files**:
- `deploy/src/runtime/llm.ts` — add cache_control markers
- `deploy/src/workflow.ts` — separate static vs dynamic prompt sections

**Implementation**:
```
1. Structure system prompt with static section first:
   [role definition + behavioral rules + tool schemas]  ← cacheable
   --- dynamic boundary ---
   [session context + memory + recent state]             ← changes per turn

2. For Anthropic models: add cache_control: { type: "ephemeral" } on last
   static block. This tells the API to cache everything up to that point.

3. For non-Anthropic models: no-op (cache_control ignored).

4. Ensure subagent runs use same static prefix as parent (cache sharing).
```

**Acceptance**: Consecutive turns show `cache_read_input_tokens > 0` in Anthropic API response.

---

## Phase 3 — Streaming & Concurrency

### 3.1 Concurrent Tool Execution

**Why**: Claude Code's `StreamingToolExecutor` runs concurrent-safe tools in
parallel while serializing unsafe ones. AgentOS executes all tools serially.

**Files**:
- `deploy/src/runtime/tools.ts` — add concurrency classification + parallel dispatch

**Implementation**:
```
1. Add concurrency metadata to tool definitions:
   interface ToolDefinition {
     ...existing...
     concurrent_safe?: boolean  // default false
   }

2. Mark safe tools: read-file, grep, glob, web-search, knowledge-search,
   http-request, image-generate (read-only or isolated)

3. Mark unsafe tools: bash, write-file, edit-file, python-exec, dynamic-exec
   (mutate shared state)

4. In executeTools(), partition tool calls:
   const safe = toolCalls.filter(tc => getToolDef(tc.name)?.concurrent_safe)
   const unsafe = toolCalls.filter(tc => !getToolDef(tc.name)?.concurrent_safe)

   // Execute safe tools in parallel
   const safeResults = await Promise.all(safe.map(tc => executeSingleTool(tc)))
   // Execute unsafe tools serially
   const unsafeResults = []
   for (const tc of unsafe) {
     unsafeResults.push(await executeSingleTool(tc))
   }

5. Merge results in original tool_call order (not execution order)
```

**Acceptance**: Turn with 3 grep + 1 bash: greps run in parallel (~1x latency), bash runs after. Total time < serial.

---

### 3.2 Backpressure Enforcement in Token Streaming

**Why**: stream.ts calls `send()` without await. Slow WebSocket clients cause
unbounded buffer growth → OOM.

**Files**:
- `deploy/src/runtime/stream.ts`

**Implementation**:
```
1. Track pending sends with a counter/queue size
2. If queue > HIGH_WATERMARK (1000 messages): pause reading from LLM stream
3. If queue < LOW_WATERMARK (200 messages): resume reading
4. Add 30s timeout per message send — drop + log if exceeded
5. On WebSocket close: set flag, stop reading from LLM stream immediately
```

**Acceptance**: Simulated slow client (100ms per message) with fast LLM → buffer stays bounded. Disconnect stops LLM read.

---

### 3.3 Tool Abort/Cancellation Propagation

**Why**: Claude Code uses WeakRef-based parent→child abort controllers with sibling
isolation. AgentOS has no cancellation — hung tools block the turn.

**Files**:
- `deploy/src/runtime/abort.ts` (NEW)
- `deploy/src/runtime/tools.ts` — pass AbortSignal to tool execution
- `deploy/src/workflow.ts` — create per-turn abort controller

**Implementation**:
```
1. Create abort.ts:
   function createChildAbortController(parent: AbortController): AbortController
     - Parent abort → child abort (via listener)
     - Child abort does NOT propagate to parent
     - Use WeakRef to prevent memory leaks

2. In workflow.ts: create turnAbortController per turn
   - On budget exceeded: abort all pending tools
   - On loop detected: abort all pending tools

3. In tools.ts executeTools():
   - Create child controller per tool from turn controller
   - Pass signal to sandbox.exec(), fetch(), etc.
   - On signal abort: return { error: "cancelled" } immediately

4. For bash/sandbox tools: kill subprocess on abort signal
```

**Acceptance**: Turn abort → all running tools cancelled within 1s. No orphaned processes.

---

### 3.4 Heartbeat/Keepalive Events

**Why**: protocol.ts has no heartbeat event. Long-running tools (>30s) with no
output may timeout on the client side.

**Files**:
- `deploy/src/runtime/protocol.ts` — add `heartbeat` event type
- `deploy/src/runtime/stream.ts` — emit heartbeats during tool execution

**Implementation**:
```
1. Add to EventType union: "heartbeat"
2. During tool execution, emit heartbeat every 15s:
   { type: "heartbeat", timestamp: Date.now() }
3. Client should reset its inactivity timer on heartbeat
```

**Acceptance**: Tool running 60s → client receives 3-4 heartbeats. No client-side timeout.

---

## Phase 4 — Intelligence & Memory

### 4.1 Anti-Hallucination System Prompt Patterns

**Why**: Claude Code's system prompt includes explicit behavioral guardrails:
- "Report outcomes faithfully — never claim tests pass when they fail"
- "Read file before editing — tool will error if you haven't"
- "Diagnose why before switching tactics"
- "Don't add features beyond what was asked"

AgentOS system prompt (built in workflow.ts) lacks these.

**Files**:
- `deploy/src/workflow.ts` — enhance system prompt builder

**Implementation**:
```
1. Add behavioral guardrails section to system prompt:

   ## Behavioral Rules
   - Read files before editing. Never guess file contents.
   - Report outcomes faithfully. If a command fails, say so with the error.
     Never claim success when output shows failure.
   - If an approach fails, diagnose why before trying alternatives.
     Read the error, check assumptions, try a focused fix.
   - Do not add features, refactoring, or improvements beyond what was asked.
   - When multiple tools are needed, prefer parallel execution for read-only
     tools (grep, glob, read-file). Use sequential execution for mutations.
   - Do not retry the same failed command. Diagnose the root cause first.

2. Add tool preference section:
   - Prefer dedicated tools over bash equivalents (grep tool > bash grep)
   - Prefer edit-file over write-file for modifications
```

**Acceptance**: Agent given failing test → reports failure accurately (not "tests pass"). Agent asked to fix bug → doesn't refactor surrounding code.

---

### 4.2 Complete Procedural Memory (Write Path)

**Why**: `readBestProcedures()` exists but no `storeProcedure()`. The procedural
memory tier is read-only dead code.

**Files**:
- `deploy/src/runtime/memory.ts`

**Implementation**:
```
1. Add storeProcedure(sql, env, procedure):
   interface Procedure {
     org_id: string
     agent_name: string
     task_pattern: string     // regex or keyword pattern
     tool_sequence: string[]  // ordered tool names
     success_rate: number     // 0.0-1.0
     avg_turns: number
     source_session_id: string
   }

2. At end of successful session (workflow.ts done event):
   - Extract tool sequence from turn history
   - If sequence length > 2 and session rated successful:
     storeProcedure(sql, env, { ... })

3. Deduplicate: if procedure with same task_pattern exists, update success_rate
   as rolling average
```

**Acceptance**: After 3 successful "deploy" sessions, `readBestProcedures("deploy")` returns the common tool sequence.

---

### 4.3 Memory Context Token Budgeting

**Why**: memory.ts `buildMemoryContext()` can produce unbounded output. Large
facts + episodes + procedures can exceed prompt limits.

**Files**:
- `deploy/src/runtime/memory.ts`

**Implementation**:
```
1. Add token budget parameter to buildMemoryContext():
   function buildMemoryContext(wm, episodes, procedures, facts, maxChars = 4000)

2. Allocate budget proportionally:
   - Working memory: 20% (800 chars)
   - Episodes: 30% (1200 chars)
   - Procedures: 20% (800 chars)
   - Facts: 30% (1200 chars)

3. Truncate each section to its budget, preferring higher-score items

4. If any section underflows, redistribute to others
```

**Acceptance**: Memory with 50 episodes + 100 facts → output capped at 4000 chars. Highest-scored items preserved.

---

### 4.4 Episode Deduplication

**Why**: Same episode appears multiple times when matching multiple keywords.
Wasted tokens in context.

**Files**:
- `deploy/src/runtime/memory.ts`

**Implementation**:
```
1. In searchEpisodes(), deduplicate by session_id before returning:
   const seen = new Set<string>()
   return episodes.filter(e => {
     if (seen.has(e.session_id)) return false
     seen.add(e.session_id)
     return true
   })
```

**Acceptance**: Query matching episode on 3 keywords → episode appears once, not 3 times.

---

## Phase 5 — Observability & Protocol

### 5.1 Distributed Tracing Propagation

**Why**: `trace_id` generated per session but not propagated to A2A calls,
marketplace requests, or MCP invocations. Can't follow requests across agents.

**Files**:
- `deploy/src/runtime/llm.ts` — add trace header to gateway calls
- `deploy/src/runtime/tools.ts` — propagate trace to tool HTTP calls
- `control-plane/src/routes/a2a.ts` — read/propagate `X-Trace-Id` header

**Implementation**:
```
1. Pass trace_id through executeTools() context
2. On all outbound fetch() calls: add header X-Trace-Id: {trace_id}
3. In a2a.ts SendMessage: propagate caller's X-Trace-Id into child run params
4. In LLM gateway calls: add X-Trace-Id as metadata tag
5. Log trace_id in all telemetry queue writes
```

**Acceptance**: A2A call chain (A→B→C) shares single trace_id. All telemetry records queryable by trace.

---

### 5.2 Protocol Completeness

**Why**: Several gaps in protocol.ts — missing cost in tool results, tool_progress
not in union type, no heartbeat, no latency in done event.

**Files**:
- `deploy/src/runtime/protocol.ts`

**Implementation**:
```
1. Add to ToolResultEvent: cost_usd?: number, duration_ms?: number
2. Add ToolProgressEvent to RuntimeEvent union type
3. Add HeartbeatEvent: { type: "heartbeat", timestamp: number }
4. Add to DoneEvent: latency_ms?: number, total_cost_usd?: number, total_turns?: number
5. Add LoopDetectedEvent: { type: "loop_detected", tool_name: string, count: number }
6. Update validateEvent() to accept all new event types
```

**Acceptance**: Frontend can display per-tool cost, total run cost, and latency from event stream.

---

### 5.3 Circuit Breaker Observability

**Why**: Circuit breaker state changes only go to console.log. Invisible to
monitoring.

**Files**:
- `deploy/src/runtime/tools.ts` — emit to telemetry on state change

**Implementation**:
```
1. On every state transition (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED):
   env.TELEMETRY_QUEUE.send({
     type: "circuit_breaker",
     tool_name,
     from_state,
     to_state,
     failure_count,
     timestamp: Date.now()
   })
2. Add circuit_breaker_events table to control-plane migrations
3. Surface in dashboard (control-plane/src/routes/dashboard.ts)
```

**Acceptance**: Tool flapping OPEN/CLOSED → visible in dashboard with timestamps.

---

### 5.4 Message Overflow Warning

**Why**: workflow.ts silently drops context when JSON exceeds 800KB. Agent
reasoning degrades without explanation.

**Files**:
- `deploy/src/workflow.ts`

**Implementation**:
```
1. When message truncation triggers:
   emitEvent({
     type: "warning",
     content: `Context exceeded 800KB — oldest ${dropped} messages compressed.
               Consider starting a new session for complex tasks.`
   })
2. Log to telemetry with session_id, message count before/after, byte sizes
```

**Acceptance**: Client receives warning event when context is truncated. Telemetry records the event.

---

## Phase 6 — Multi-Agent Coordination (Third Pass)

Claude Code's coordinator/swarm mode is significantly more sophisticated than
AgentOS's delegation. These patterns unlock reliable multi-agent workflows.

### 6.1 Agent-to-Agent Mailbox IPC

**Why**: Claude Code's coordinator uses a mailbox system for structured
inter-agent communication. Workers write to leader's inbox, await responses.
AgentOS delegation is fire-and-forget — parent sends params, gets final output.
No mid-run communication, no permission escalation from child to parent.

**Files**:
- `deploy/src/runtime/mailbox.ts` (NEW)
- `deploy/src/workflow.ts` — integrate mailbox checks in turn loop
- `deploy/src/runtime/tools.ts` — add `send-message` tool for sub-agents

**Implementation**:
```
1. Create mailbox.ts using DO SQLite:
   CREATE TABLE mailbox (
     id INTEGER PRIMARY KEY,
     from_session TEXT,
     to_session TEXT,
     message_type TEXT CHECK(type IN ('text','permission_request','shutdown','plan_approval')),
     payload TEXT,
     read_at INTEGER,
     created_at INTEGER DEFAULT (unixepoch())
   )

   writeToMailbox(sql, from, to, type, payload)
   readMailbox(sql, sessionId, since?): MailboxMessage[]

2. In workflow.ts turn loop, after tool execution:
   - Check mailbox for incoming messages (from parent or siblings)
   - If permission_request: escalate to parent via progress event
   - If shutdown: break loop gracefully

3. Add send-message tool (available to sub-agents):
   Input: { to: string, message: string }
   Sends to parent or named sibling via mailbox
```

**Acceptance**: Sub-agent sends "need approval for destructive action" → parent receives in real-time, responds → sub-agent continues.

---

### 6.2 Shared Scratch Directory

**Why**: Claude Code's coordinator provides `.scratchpad/` for durable cross-worker
state. Workers can share intermediate results without polluting the main context.
AgentOS sub-agents have no shared state — each runs in total isolation.

**Files**:
- `deploy/src/runtime/scratch.ts` (NEW)
- `deploy/src/workflow.ts` — mount scratch for delegated runs

**Implementation**:
```
1. Create scratch.ts:
   - Backed by KV with prefix: scratch/{trace_id}/
   - scratchWrite(env, traceId, key, value): void
   - scratchRead(env, traceId, key): string | null
   - scratchList(env, traceId): string[]
   - TTL: 1 hour (auto-cleanup)

2. In workflow.ts, for delegated runs:
   - Pass trace_id to child (already in DelegationLineage)
   - Add scratch-read and scratch-write tools when depth > 0

3. Add tools:
   scratch-write: { key: string, value: string }
   scratch-read: { key: string } → string
   scratch-list: {} → string[]
```

**Acceptance**: Agent A delegates to B and C. B writes "intermediate_result" to scratch. C reads it. Parent A reads final scratch state.

---

### 6.3 Sub-Agent Permission Escalation

**Why**: Claude Code synchronizes permissions between coordinator and workers.
Workers can request permission from the leader when they encounter a destructive
action. AgentOS sub-agents either have blanket permission or no permission — no
escalation path.

**Files**:
- `deploy/src/runtime/mailbox.ts` (from 6.1)
- `deploy/src/workflow.ts` — handle permission_request messages

**Implementation**:
```
1. When sub-agent encounters require_confirmation_for_destructive:
   - Write permission_request to parent mailbox:
     { tool_name, arguments_summary, risk_level }
   - Wait for response (poll mailbox every 2s, timeout 60s)

2. Parent workflow receives permission_request:
   - Emit event to client: { type: "permission_request", from_agent, tool_name, ... }
   - Wait for client response (step.waitForEvent("permission_response"))
   - Write approval/denial to child's mailbox

3. Sub-agent reads response:
   - If approved: execute tool
   - If denied: skip tool, return "permission denied" to LLM
   - If timeout: skip tool, log warning
```

**Acceptance**: Sub-agent wants to delete a file → permission request surfaces in parent's UI → user approves → sub-agent proceeds.

---

## Phase 7 — Operational Excellence (Third Pass)

Patterns that separate a working platform from a production-grade one.

### 7.1 Structured Error Classification

**Why**: Claude Code has a semantic error taxonomy: `TelemetrySafeError`,
`ShellError(stdout, stderr, code)`, `ConfigParseError(path, default)`, plus
`classifyAxiosError()` returning `auth|timeout|network|http|other`. AgentOS
errors are unstructured — `catch (e) { console.error(e) }` throughout.

**Files**:
- `deploy/src/runtime/errors.ts` (NEW)
- All files with catch blocks — migrate to structured errors

**Implementation**:
```
1. Create errors.ts with error hierarchy:
   class AgentOSError extends Error {
     code: string          // e.g. "TOOL_TIMEOUT", "LLM_OVERLOADED"
     telemetrySafe: boolean // safe to log to analytics (no PII/code)
     retryable: boolean
     userMessage?: string  // user-safe message (separate from internal)
   }

   class ToolError extends AgentOSError { toolName, exitCode?, stdout?, stderr? }
   class LLMError extends AgentOSError { model, statusCode, retryAfterMs? }
   class BudgetError extends AgentOSError { spent, limit, tool? }
   class CircuitBreakerError extends AgentOSError { toolName, state }
   class SSRFError extends AgentOSError { blockedUrl }

2. Add classifyFetchError(e):
   - ECONNRESET, EPIPE → { kind: 'network', retryable: true }
   - CERT_* errors → { kind: 'tls', retryable: false, hint: 'Check proxy settings' }
   - 401 → { kind: 'auth', retryable: false }
   - 429, 529 → { kind: 'rate_limit', retryable: true }
   - timeout → { kind: 'timeout', retryable: true }

3. Migrate catch blocks across runtime to use structured errors
4. In telemetry queue writes: only include telemetrySafe fields
```

**Acceptance**: All errors in telemetry have a `code` field. No PII/code in analytics. Error dashboard can filter by code.

---

### 7.2 Per-Model Cost Tracking with Cache Awareness

**Why**: Claude Code tracks 6 token categories per model: input, output, cache
write (1.25× input), cache read (0.1× input), thinking, web search requests.
AgentOS tracks only input_tokens + output_tokens. Cache savings are invisible,
making it impossible to measure prompt cache optimization ROI.

**Files**:
- `deploy/src/runtime/llm.ts` — extract cache token counts from response
- `deploy/src/runtime/cost.ts` (NEW) — per-model pricing with cache tiers
- `deploy/src/workflow.ts` — use detailed cost in telemetry

**Implementation**:
```
1. Create cost.ts with pricing table:
   const MODEL_COSTS = {
     'anthropic/claude-sonnet-4-6': {
       input_per_mtok: 3.0,
       output_per_mtok: 15.0,
       cache_write_per_mtok: 3.75,   // 1.25× input
       cache_read_per_mtok: 0.30,    // 0.1× input
     },
     'anthropic/claude-opus-4-6': { ... },
     // ... other models
   }

   function calculateDetailedCost(model, usage): DetailedCost {
     return {
       input_cost, output_cost, cache_write_cost, cache_read_cost,
       total_cost, cache_savings  // what you saved vs no-cache
     }
   }

2. In llm.ts, extract from Anthropic response headers:
   - cache_creation_input_tokens
   - cache_read_input_tokens
   (CF AI Gateway may proxy these; check response)

3. In workflow.ts telemetry: include all 6 token categories + cache_savings
4. In dashboard: show cache hit rate and savings
```

**Acceptance**: Dashboard shows "Cache savings: $X.XX (Y% of input tokens cached)". Per-model cost breakdown visible.

---

### 7.3 Feature Flags with Runtime Toggle

**Why**: Claude Code uses GrowthBook for feature gating with reactive refresh,
exposure logging, and compile-time DCE. AgentOS has no feature flag system —
new features require full redeploy. Can't A/B test, can't emergency-disable.

**Files**:
- `deploy/src/runtime/features.ts` (NEW)
- `control-plane/src/routes/features.ts` (NEW)

**Implementation**:
```
1. Create features.ts (runtime side):
   - Read feature flags from KV: features/{org_id}
   - Cache in-memory for 60s
   - Provide isEnabled(flag, orgId): boolean

   Built-in flags:
   - concurrent_tools: boolean (Phase 3.1)
   - deferred_tool_loading: boolean (Phase 2.2)
   - context_compression: boolean (Phase 2.4)
   - scratchpad: boolean (Phase 6.2)
   - detailed_cost_tracking: boolean (Phase 7.2)

2. Create features.ts (control-plane side):
   - POST /features/{flag} — set flag value per org
   - GET /features — list all flags for org
   - DELETE /features/{flag} — reset to default

3. In workflow.ts: gate new features behind flags
   if (await isEnabled('concurrent_tools', orgId)) { ... }
```

**Acceptance**: Enable `concurrent_tools` for one org via API → only that org gets concurrent tool execution. Disable → reverts to serial.

---

### 7.4 Structured JSONL Event Logging

**Why**: Claude Code writes buffered JSONL logs with automatic enrichment
(timestamp, sessionId, version, pid) to `~/.claude/cache/errors/{DATE}.jsonl`.
AgentOS uses `console.log` and fire-and-forget queue writes. No queryable local
logs. When telemetry queue is unavailable, events are lost.

**Files**:
- `deploy/src/runtime/logger.ts` (NEW)
- All files with console.log — migrate critical paths

**Implementation**:
```
1. Create logger.ts:
   class JsonlLogger {
     private buffer: LogEntry[] = []
     private flushInterval = 1000 // ms
     private maxBuffer = 50

     log(level, event, data):
       buffer.push({
         timestamp: Date.now(),
         level,           // 'debug' | 'info' | 'warn' | 'error'
         event,           // 'tool_execution' | 'llm_call' | 'circuit_break' | ...
         session_id,
         trace_id,
         org_id,
         agent_name,
         ...data
       })
       if (buffer.length >= maxBuffer) this.flush()

     flush():
       // Write to KV: logs/{orgId}/{date}/{sessionId}.jsonl
       // Append-only, one JSON object per line
   }

2. Replace critical console.log calls with structured logger
3. Add log drain endpoint in control-plane:
   GET /logs?session_id=...&event=...&since=...
```

**Acceptance**: After agent run, `GET /logs?session_id=X` returns all events as JSONL. Telemetry queue down → logs still in KV.

---

### 7.5 Dashboard Analytics Deep Drill-Down

**Why**: AgentOS dashboard returns only 8 flat metrics. No breakdown by agent,
model, time period. No trends. No cost attribution. Claude Code tracks per-model
usage, per-session costs, cache hit rates, and rate limit proximity.

**Files**:
- `control-plane/src/routes/dashboard.ts` — add drill-down endpoints

**Implementation**:
```
1. Add new endpoints:

   GET /stats/by-agent — top 10 agents by cost, sessions, errors
   GET /stats/by-model — cost + tokens per model
   GET /stats/trends?period=7d — daily cost, sessions, error rate, avg latency
   GET /stats/cost-attribution — cost breakdown: LLM vs tools vs infrastructure
   GET /stats/tool-health — per-tool: call count, error rate, avg latency, circuit state

2. Each endpoint uses existing tables (sessions, turns, billing_records, tools)
   with proper date windowing and GROUP BY

3. Add index on sessions(org_id, created_at) if not exists
   Add index on turns(session_id, created_at) if not exists
```

**Acceptance**: Dashboard shows cost trend over 7 days. Click agent → see its sessions, cost, error rate. Click model → see token usage.

---

### 7.6 Training Convergence Detection & Multi-Dimension Optimization

**Why**: AgentOS training runs for max_iterations regardless of progress. No
auto-stop. Also limited to system_prompt changes — can't optimize temperature,
tools, or reasoning strategy. Claude Code's content replacement tracks what works
and iteratively adjusts.

**Files**:
- `control-plane/src/routes/training.ts`
- `control-plane/src/logic/training-safety.ts`

**Implementation**:
```
1. Convergence detection:
   - Track reward scores for last 3 iterations
   - If improvement < 1% for 3 consecutive iterations: auto-stop
   - Emit training event: { type: "converged", final_score, iterations_used }

2. Multi-dimension optimization:
   - Allow training to modify: system_prompt, temperature, max_tokens, reasoning_strategy
   - One dimension per iteration (not all at once):
     Iteration 1: optimize system_prompt
     Iteration 2: optimize temperature (grid search: 0.1, 0.3, 0.5, 0.7)
     Iteration 3: optimize reasoning_strategy (try each)
   - Best combination wins
   - Store all dimensions in training_resources (not just system_prompt)

3. Staged validation:
   - After optimizing each dimension: run eval
   - If score drops: revert that dimension, try next
   - If score improves: keep and continue
```

**Acceptance**: Training auto-stops after 5/10 iterations when score plateaus. Training can optimize temperature from 0.7 → 0.3 if lower temp improves pass rate.

---

### 7.7 Request Queuing with Backpressure

**Why**: runtime-proxy.ts returns 503 immediately when runtime is unhealthy. No
queuing. Users see errors during brief outages that would self-heal in seconds.
Claude Code's persistent retry mode queues requests during outages with
exponential backoff and heartbeat messages.

**Files**:
- `control-plane/src/routes/runtime-proxy.ts`

**Implementation**:
```
1. Add request queue (DO-backed or in-memory with KV overflow):
   - When circuit breaker is OPEN: queue request instead of 503
   - Max queue size: 100 requests per org
   - Max wait time: 30 seconds
   - Queue position reported via SSE: { type: "queued", position: 3 }

2. Queue drain:
   - When circuit breaker transitions OPEN → HALF_OPEN: drain one request
   - If succeeds: drain next (up to 5 concurrent)
   - If fails: re-open circuit, stop draining

3. Client experience:
   - SSE stream starts immediately with "queued" event
   - Updates position as queue drains
   - Transitions to normal streaming when dequeued
   - Timeout → 503 with retry-after header
```

**Acceptance**: Runtime down for 10s. 5 requests come in. All queued. Runtime recovers. All 5 served. No 503s.

---

### 7.8 Skill System (Prompt-Based Domain Workflows)

**Why**: Claude Code distinguishes skills (prompt-injected domain workflows) from
tools (system operations). Skills like `/commit`, `/review-pr`, `/simplify`
inject detailed prompt context that guides multi-step agent behavior. AgentOS has
no skill system — everything is a tool. Users can't package reusable workflows.

**Files**:
- `deploy/src/runtime/skills.ts` (NEW)
- `control-plane/src/routes/skills.ts` (NEW)

**Implementation**:
```
1. Skill definition schema:
   {
     name: string,              // e.g. "deploy-to-prod"
     description: string,
     when_to_use: string,       // natural language trigger description
     prompt: string,            // injected into system prompt when activated
     required_tools: string[],  // tools this skill needs
     org_id: string,
     version: string
   }

2. Skill storage: skills table in DB
   - CRUD via control-plane /skills endpoints
   - Per-org (not global)

3. Skill activation in runtime:
   - User message starts with /skill-name → inject skill.prompt into context
   - Or: LLM sees skill index and activates via invoke-skill tool
   - Skill prompt appended as system message before user input

4. Built-in skills (seed data):
   - /analyze-errors — read recent error sessions, identify patterns, suggest fixes
   - /optimize-cost — analyze cost breakdown, suggest cheaper model routing
   - /review-config — audit agent config against best practices
```

**Acceptance**: User creates "deploy-checklist" skill. Agent activates it when user says "deploy". Skill prompt guides agent through pre-deploy checks.

---

## Phase 8 — Frontend & UX (Third Pass)

### 8.1 Session Search & Export

**Why**: No way to find a past session by content, cost, or error pattern.
Claude Code has transcript search with WeakMap caching and smart field extraction.

**Files**:
- `control-plane/src/routes/sessions.ts` — add search endpoint
- `mvp/src/pages/AgentPlaygroundPage.tsx` — add search UI

**Implementation**:
```
1. Add endpoint:
   GET /sessions/search?q=text&agent=name&min_cost=0.01&status=error&from=date&to=date

2. Search strategy:
   - Full-text search on input_text + output_text (ILIKE or pg_trgm)
   - Filter by agent_name, status, cost range, date range
   - Return: session_id, agent_name, input_preview(100 chars), cost, status, created_at
   - Paginated (limit/offset)

3. Export endpoint:
   GET /sessions/{id}/export?format=json|csv
   - JSON: full session with turns
   - CSV: one row per turn (turn_number, role, content, cost, latency)

4. Frontend: search bar in session list with filters
```

**Acceptance**: Search "timeout error" → returns sessions where agent hit timeouts. Export session as JSON → valid, complete transcript.

---

### 8.2 Workspace Write Endpoints

**Why**: Workspace is read-only. Users can't upload files or create projects from
the frontend. Only the agent can write to workspace during execution.

**Files**:
- `control-plane/src/routes/workspace.ts` — add write endpoints

**Implementation**:
```
1. Add endpoints:
   POST /files/upload — upload file to workspace (max 10MB)
   POST /files/create — create file with content
   DELETE /files — delete file from workspace
   POST /projects/create — create project directory

2. All writes go through runtime service binding → R2
3. Validate: path traversal prevention, file size limits, extension allowlist
4. Update manifest after write
```

**Acceptance**: User uploads `data.csv` → appears in file browser. User creates project → agent can access it.

---

## Phase 9 — Conversation Integrity & Recovery (Fourth Pass)

Claude Code invests heavily in ensuring conversations never reach an invalid state.
These patterns prevent silent corruption that degrades agent quality over time.

### 9.1 Tool Use/Result Pairing Validation & Repair

**Why**: Claude Code's `ensureToolResultPairing` maintains cross-message tool_use
ID tracking, injects synthetic placeholders for orphaned tool calls, and strips
orphaned tool results. AgentOS appends tool results to messages without validation.
If a tool crashes mid-execution or a context compression drops a tool_result, the
conversation becomes structurally invalid — the LLM API rejects it or hallucinates.

**Files**:
- `deploy/src/runtime/conversation-repair.ts` (NEW)
- `deploy/src/workflow.ts` — call repair before each LLM call

**Implementation**:
```
1. Create conversation-repair.ts:

   function repairConversation(messages: Message[]): Message[] {
     const allToolUseIds = new Set<string>()
     const allToolResultIds = new Set<string>()

     // Collect all IDs
     for (const msg of messages) {
       if (msg.role === 'assistant' && msg.tool_calls) {
         for (const tc of msg.tool_calls) allToolUseIds.add(tc.id)
       }
       if (msg.role === 'tool') allToolResultIds.add(msg.tool_call_id)
     }

     // Inject synthetic results for orphaned tool_use
     const orphanedUses = [...allToolUseIds].filter(id => !allToolResultIds.has(id))
     for (const id of orphanedUses) {
       messages.push({
         role: 'tool',
         tool_call_id: id,
         content: '[Tool result missing — execution was interrupted]'
       })
     }

     // Strip orphaned tool_results (result without matching use)
     messages = messages.filter(m =>
       m.role !== 'tool' || allToolUseIds.has(m.tool_call_id)
     )

     // Deduplicate tool_use IDs across messages
     const seenUseIds = new Set<string>()
     for (const msg of messages) {
       if (msg.tool_calls) {
         msg.tool_calls = msg.tool_calls.filter(tc => {
           if (seenUseIds.has(tc.id)) return false
           seenUseIds.add(tc.id)
           return true
         })
       }
     }

     return messages
   }

2. In workflow.ts, before callLLM():
   messages = repairConversation(messages)

3. Log repairs to telemetry:
   { type: 'conversation_repair', orphaned_uses: N, orphaned_results: N, duplicates: N }
```

**Acceptance**: Tool crashes mid-execution → synthetic result injected → next LLM call succeeds. Context compression drops a tool_result → repair restores pairing.

---

### 9.2 Streaming Idle Timeout & Stall Detection

**Why**: Claude Code has a two-tier timeout: 90s idle watchdog (abort if no chunks)
and 30s stall detection (log warning between chunks). AgentOS relies solely on
CF Workflow step timeout. If the LLM stream stalls but the connection stays open,
the step runs until the full timeout (up to 5 minutes) — wasting budget silently.

**Files**:
- `deploy/src/runtime/llm.ts` — add idle watchdog to streaming path
- `deploy/src/runtime/stream.ts` — add stall detection

**Implementation**:
```
1. In llm.ts streaming mode (when added):
   const IDLE_TIMEOUT_MS = 90_000
   const STALL_WARN_MS = 30_000
   let lastChunkAt = Date.now()

   // Idle watchdog
   const watchdog = setTimeout(() => {
     if (Date.now() - lastChunkAt > IDLE_TIMEOUT_MS) {
       controller.abort()
       log('llm_idle_timeout', { model, elapsed: Date.now() - lastChunkAt })
     }
   }, IDLE_TIMEOUT_MS)

   // On each chunk:
   const gap = Date.now() - lastChunkAt
   if (gap > STALL_WARN_MS) {
     log('llm_stall_detected', { model, gap_ms: gap })
   }
   lastChunkAt = Date.now()

   // On complete:
   clearTimeout(watchdog)

2. In stream.ts, add same pattern for WebSocket→client streaming
```

**Acceptance**: LLM stalls for 30s → warning logged. Stalls for 90s → connection aborted, step fails, workflow retries.

---

### 9.3 Model Refusal Handling

**Why**: Claude Code detects `stop_reason === 'refusal'` and provides actionable
guidance (rephrase, switch model). AgentOS doesn't check stop_reason — refusals
appear as empty responses, leaving the user confused.

**Files**:
- `deploy/src/runtime/llm.ts` — detect refusal
- `deploy/src/workflow.ts` — handle refusal gracefully

**Implementation**:
```
1. In callLLM() response handling:
   if (response.stop_reason === 'refusal' || response.finish_reason === 'content_filter') {
     return {
       ...response,
       content: "I'm unable to help with that request due to usage policies. " +
                "Try rephrasing your request or adjusting the task.",
       refusal: true
     }
   }

2. In workflow.ts turn loop:
   if (llmResult.refusal) {
     emitEvent({ type: 'warning', content: 'Model declined this request.' })
     // Don't count as error — don't trip circuit breaker
     // Do count toward turn limit
   }
```

**Acceptance**: Agent asked something that triggers refusal → clear message to user instead of empty response. Circuit breaker not tripped.

---

### 9.4 Thinking Block Management

**Why**: Claude Code carefully manages thinking blocks: strips trailing thinking
before whitespace filtering (order matters), handles thinking-only messages, and
adjusts token counting for thinking budgets. AgentOS doesn't handle thinking
blocks at all — if extended thinking is enabled, thinking content bloats context
and wastes tokens on subsequent turns.

**Files**:
- `deploy/src/workflow.ts` — strip thinking from history, manage thinking budget

**Implementation**:
```
1. Before building messages for LLM:
   - Strip thinking blocks from all previous assistant messages
     (thinking is only useful for the turn it was generated)
   - Preserve thinking for the CURRENT turn only (if streaming)

2. When estimating token count for context management:
   - Exclude thinking blocks from history token estimate
   - Include thinking budget in available token calculation

3. If model supports extended thinking (Anthropic Claude 4+):
   - Set thinking.budget_tokens based on task complexity
   - Simple tasks: 2048 tokens
   - Complex tasks: 8192 tokens
   - Code generation: 16384 tokens
```

**Acceptance**: 10-turn conversation with thinking → only last turn's thinking in context. Token estimates accurate.

---

### 9.5 Encoding-Safe File Operations

**Why**: Claude Code detects encoding (UTF-8/UTF-16LE BOM, line endings) and
defaults empty files to UTF-8 (not ASCII — prevents emoji/CJK corruption). AgentOS
file tools don't handle encoding — binary files crash, non-UTF8 files corrupt.

**Files**:
- `deploy/src/runtime/tools.ts` — add encoding detection to file read/write tools

**Implementation**:
```
1. In read-file tool:
   - Detect BOM: UTF-16LE (0xFF 0xFE), UTF-8 (0xEF 0xBB 0xBF)
   - If binary detected (null bytes in first 8192 bytes): return
     "[Binary file — {size} bytes, type: {extension}]" instead of raw content
   - Default encoding: UTF-8

2. In write-file tool:
   - Preserve original encoding if file exists (read BOM, write with same BOM)
   - Preserve line endings (detect CRLF vs LF from original, write same)
   - New files: UTF-8, LF (platform-agnostic default)

3. In edit-file tool:
   - Match old_string using same encoding as file
   - Preserve line endings in replacement
```

**Acceptance**: Read binary file → summary instead of garbage. Edit CRLF file → line endings preserved. Write emoji to previously-empty file → no corruption.

---

## Phase 10 — Platform Hardening (Fourth Pass)

### 10.1 Intent Router Feedback Loop

**Why**: AgentOS has a 70+ pattern intent router with confidence scoring, but no
learning. Misrouted tasks (user corrects agent, picks different agent manually)
are never fed back to improve routing accuracy.

**Files**:
- `deploy/src/runtime/intent-router.ts`
- `control-plane/src/routes/sessions.ts` — record routing feedback

**Implementation**:
```
1. Track routing decisions in turns table:
   - classified_intent, classified_confidence, routed_to_agent, routed_model

2. Detect misroutes:
   - User manually switches agent after first turn → misroute signal
   - Session rated < 3 stars with agent-switch → strong misroute signal
   - Session succeeds on first try → correct route signal

3. Weekly aggregation job (or on-demand):
   - Query misroute rate by intent pattern
   - If pattern X routes to agent A but 60%+ of users switch to B:
     flag for review / auto-adjust weight

4. Surface in dashboard:
   GET /stats/routing — misroute rate by intent, top corrections
```

**Acceptance**: After 100 sessions, dashboard shows "debug intent misrouted to research-agent 40% of the time — recommend routing to code-agent".

---

### 10.2 Marketplace Anti-Fraud (Sybil Resistance)

**Why**: AgentOS marketplace quality_score uses raw avg_rating. A malicious actor
can create fake orgs, run fake transactions, and inflate ratings. Claude Code
doesn't have a marketplace, but this is critical for AgentOS's monetization.

**Files**:
- `control-plane/src/routes/marketplace.ts`
- `control-plane/src/logic/marketplace.ts`

**Implementation**:
```
1. Rating credibility scoring:
   - Weight ratings by rater's account age (< 7 days = 0.1 weight, > 90 days = 1.0)
   - Weight by rater's total spend (> $10 = full weight, < $1 = 0.2 weight)
   - Discard ratings from same IP range as listing owner

2. Self-transaction prevention:
   - Block ratings where caller_org_id matches listing owner org_id
   - Block ratings from orgs sharing billing_email domain with owner

3. Velocity checks:
   - Max 10 ratings per listing per hour (burst suppression)
   - Max 3 ratings from same org per listing per 24h

4. Quality score decay:
   - Ratings older than 90 days decay by 50%
   - Forces listing owners to maintain quality
```

**Acceptance**: Fake org rates own listing → blocked. 50 ratings from new accounts → weighted to ~5 real ratings.

---

### 10.3 Agent Config Migration Framework

**Why**: agent.config_json changes over time (new fields, renamed fields, removed
fields). No migration helpers exist — old configs break silently when the runtime
expects new fields. Claude Code has explicit migration files per model/config version.

**Files**:
- `deploy/src/runtime/config-migrations.ts` (NEW)
- `deploy/src/workflow.ts` — run migrations on config load

**Implementation**:
```
1. Create config-migrations.ts:
   interface ConfigMigration {
     from_version: string
     to_version: string
     migrate(config: any): any
   }

   const MIGRATIONS: ConfigMigration[] = [
     {
       from_version: '1.0',
       to_version: '1.1',
       migrate: (c) => ({
         ...c,
         reasoning_strategy: c.reasoning_strategy || 'auto',
         // New field with sensible default
       })
     },
     // Future migrations added here
   ]

   function migrateConfig(config: any): { config: any, migrated: boolean } {
     let current = config
     let migrated = false
     for (const m of MIGRATIONS) {
       if (current.config_version === m.from_version) {
         current = m.migrate(current)
         current.config_version = m.to_version
         migrated = true
       }
     }
     return { config: current, migrated }
   }

2. In workflow.ts Step 1 (Bootstrap):
   const { config, migrated } = migrateConfig(rawConfig)
   if (migrated) {
     // Write back to DB (fire-and-forget)
     env.TELEMETRY_QUEUE.send({ type: 'config_migrated', from: rawConfig.config_version, to: config.config_version })
   }

3. Add config_version field to agent config (default '1.0' for existing)
```

**Acceptance**: Old config without `reasoning_strategy` field → auto-migrated to v1.1 with default. New runtime doesn't crash on old configs.

---

### 10.4 Deploy Policy Audit Trail

**Why**: AgentOS has deploy policies (tool restrictions, domain allowlists, budget
limits) but no audit trail. If a policy is changed or bypassed, there's no record.
Claude Code's analytics system tracks all permission decisions with exposure logging.

**Files**:
- `control-plane/src/routes/agents.ts` — log policy changes
- `control-plane/src/db/migrations/` — add policy_audit table

**Implementation**:
```
1. Add migration:
   CREATE TABLE policy_audit (
     id SERIAL PRIMARY KEY,
     org_id TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     field_changed TEXT NOT NULL,      -- e.g. 'deploy_policy.blocked_tools'
     old_value TEXT,
     new_value TEXT,
     changed_by TEXT NOT NULL,         -- user_id or 'system'
     reason TEXT,                      -- optional justification
     created_at TIMESTAMPTZ DEFAULT NOW()
   )

2. In agents.ts PATCH endpoint:
   - Diff old config vs new config
   - For each changed policy field: INSERT INTO policy_audit

3. In training.ts (when training modifies config):
   - Log training-initiated changes with changed_by='training:{job_id}'

4. Dashboard endpoint:
   GET /audit/policies?agent=name&since=date
```

**Acceptance**: Admin changes blocked_tools → audit entry created. Training modifies system_prompt → logged with job_id. Dashboard shows full policy history.

---

### 10.5 Atomic File Edit with Staleness Detection

**Why**: Claude Code checks modification time AND content between staleness check
and disk write with zero awaits in between (atomic window). AgentOS write-file and
edit-file tools don't check staleness — if two concurrent tool calls edit the same
file, the second silently overwrites the first.

**Files**:
- `deploy/src/runtime/tools.ts` — add staleness check to edit-file and write-file

**Implementation**:
```
1. Track file state in per-session cache:
   fileStateCache: Map<string, { content: string, mtime: number }>

2. In read-file: populate cache with { content, mtime }

3. In edit-file:
   a. Read current file content + mtime from sandbox
   b. If cached mtime exists AND current mtime !== cached mtime:
      - Compare content (mtime can change without content change on some filesystems)
      - If content changed: return error "File modified since last read. Re-read first."
   c. Apply edit
   d. Write file (no await between check and write)
   e. Update cache with new { content, mtime }

4. In write-file: same staleness check
```

**Acceptance**: Two concurrent edits to same file → second one gets "file modified" error instead of silent overwrite.

---

## Execution Order & Dependencies

```
Phase 0 (Week 1) — Security
  0.1 Unicode sanitization          ← no deps
  0.2 Media URL SSRF                ← depends on 0.1 (shared ssrf.ts)
  0.3 System prompt validation      ← depends on 0.1
  0.4 Rate limit enforcement        ← no deps

Phase 1 (Week 2) — Resilience
  1.1 Persistent circuit breaker    ← no deps
  1.2 Pre-execution budget check    ← no deps
  1.3 LLM retry logic               ← no deps
  1.4 Error handling + loop detect  ← no deps
  1.5 Transactional migrations      ← no deps
  (all Phase 1 items are independent — can parallelize)

Phase 2 (Week 3-4) — Token Efficiency
  2.1 Result size management        ← no deps
  2.2 Deferred tool loading         ← no deps
  2.3 Empty result guard            ← no deps
  2.4 Context compression           ← depends on 2.1 (size management)
  2.5 Prompt cache optimization     ← no deps

Phase 3 (Week 4-5) — Streaming & Concurrency
  3.1 Concurrent tool execution     ← depends on 2.1 (result budgeting)
  3.2 Backpressure enforcement      ← no deps
  3.3 Abort/cancellation            ← depends on 3.1 (concurrent needs abort)
  3.4 Heartbeat events              ← no deps

Phase 4 (Week 5-6) — Intelligence
  4.1 Anti-hallucination prompts    ← no deps
  4.2 Procedural memory writes      ← no deps
  4.3 Memory token budgeting        ← no deps
  4.4 Episode deduplication         ← no deps

Phase 5 (Week 6-7) — Observability
  5.1 Distributed tracing           ← no deps
  5.2 Protocol completeness         ← no deps
  5.3 Circuit breaker observability ← depends on 1.1
  5.4 Message overflow warning      ← no deps

Phase 6 (Week 7-8) — Multi-Agent Coordination
  6.1 Mailbox IPC                   ← no deps
  6.2 Shared scratch directory      ← no deps
  6.3 Permission escalation         ← depends on 6.1 (mailbox)

Phase 7 (Week 8-10) — Operational Excellence
  7.1 Structured error classification ← no deps
  7.2 Detailed cost tracking        ← depends on 2.5 (cache optimization)
  7.3 Feature flags                 ← no deps
  7.4 Structured JSONL logging      ← depends on 7.1 (error types)
  7.5 Dashboard deep drill-down     ← depends on 7.2 (cost data)
  7.6 Training convergence          ← no deps
  7.7 Request queuing               ← depends on 1.1 (circuit breaker)
  7.8 Skill system                  ← no deps

Phase 8 (Week 10-11) — Frontend & UX
  8.1 Session search & export       ← no deps
  8.2 Workspace write endpoints     ← no deps

Phase 9 (Week 11-12) — Conversation Integrity
  9.1 Tool use/result pairing       ← no deps
  9.2 Streaming idle timeout        ← no deps
  9.3 Model refusal handling        ← no deps
  9.4 Thinking block management     ← depends on 2.4 (context compression)
  9.5 Encoding-safe file ops        ← no deps

Phase 10 (Week 12-14) — Platform Hardening
  10.1 Intent router feedback loop  ← depends on 5.1 (tracing)
  10.2 Marketplace anti-fraud       ← no deps
  10.3 Config migration framework   ← no deps
  10.4 Deploy policy audit trail    ← no deps
  10.5 Atomic file edit staleness   ← no deps
```

---

## Files Changed Summary

| File | Phases | Changes |
|------|--------|---------|
| `deploy/src/workflow.ts` | 0,1,2,4,6 | Sanitize inputs, error handling, loop detection, budget check, compaction, prompts, mailbox, scratch |
| `deploy/src/runtime/tools.ts` | 0,1,2,3,5 | Circuit breaker persistence, result sizing, concurrency, abort, tracing |
| `deploy/src/runtime/llm.ts` | 1,2,5,7 | Retry logic, cache markers, trace headers, detailed cost extraction |
| `deploy/src/runtime/stream.ts` | 3 | Backpressure, heartbeat, disconnect handling |
| `deploy/src/runtime/protocol.ts` | 3,5 | New event types, field additions |
| `deploy/src/runtime/memory.ts` | 4 | Procedural writes, token budgeting, dedup |
| `deploy/src/index.ts` | 1,6 | Migration transactions, circuit breaker table, mailbox table |
| `control-plane/src/middleware/auth.ts` | 0 | Rate limit enforcement |
| `control-plane/src/routes/a2a.ts` | 5 | Trace propagation |
| `control-plane/src/routes/dashboard.ts` | 7 | Deep drill-down endpoints |
| `control-plane/src/routes/sessions.ts` | 8 | Search + export endpoints |
| `control-plane/src/routes/training.ts` | 7 | Convergence detection, multi-dimension optimization |
| `control-plane/src/routes/runtime-proxy.ts` | 7 | Request queuing with backpressure |
| `control-plane/src/routes/workspace.ts` | 8 | Write endpoints (upload, create, delete) |
| `deploy/src/runtime/sanitize.ts` | 0 | NEW — Unicode sanitization |
| `deploy/src/runtime/ssrf.ts` | 0 | NEW — Shared SSRF validator |
| `deploy/src/runtime/compact.ts` | 2 | NEW — Context compression |
| `deploy/src/runtime/abort.ts` | 3 | NEW — Abort controller hierarchy |
| `deploy/src/runtime/result-storage.ts` | 2 | NEW — Large result persistence |
| `deploy/src/runtime/mailbox.ts` | 6 | NEW — Inter-agent mailbox IPC |
| `deploy/src/runtime/scratch.ts` | 6 | NEW — Shared scratch directory |
| `deploy/src/runtime/errors.ts` | 7 | NEW — Structured error hierarchy |
| `deploy/src/runtime/cost.ts` | 7 | NEW — Per-model cost with cache tiers |
| `deploy/src/runtime/features.ts` | 7 | NEW — Feature flag system |
| `deploy/src/runtime/logger.ts` | 7 | NEW — Structured JSONL logger |
| `deploy/src/runtime/skills.ts` | 7 | NEW — Skill system |
| `control-plane/src/routes/skills.ts` | 7 | NEW — Skill CRUD endpoints |
| `control-plane/src/routes/features.ts` | 7 | NEW — Feature flag endpoints |
| `deploy/src/runtime/conversation-repair.ts` | 9 | NEW — Tool pairing validation & repair |
| `deploy/src/runtime/config-migrations.ts` | 10 | NEW — Agent config version migrations |
| `deploy/src/runtime/intent-router.ts` | 10 | Feedback loop, misroute tracking |
| `control-plane/src/logic/marketplace.ts` | 10 | Anti-fraud scoring, credibility weights |
| `control-plane/src/routes/agents.ts` | 10 | Policy audit trail on config changes |
