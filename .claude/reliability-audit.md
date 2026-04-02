# AgentOS Reliability Audit — April 2, 2026

## Status: ALL 26 FINDINGS FIXED AND DEPLOYED (P0: 4, P1: 8, P2: 8, P3: 6).

## P0 — Must Fix Before Launch

### 1. No credit check on WebSocket path
- **File:** `deploy/src/index.ts` ~line 908 (the `data.type === "run"` block)
- **Issue:** REST `/run` checks credits but WebSocket `onMessage` `run` handler does not
- **Fix:** Add credit check before Workflow creation in WS handler, same as REST path at ~line 1223

### 2. Credit check failure silently passes
- **File:** `deploy/src/index.ts` ~line 1236
- **Issue:** `catch {} // Don't block on credit check failure` — should reject the run
- **Fix:** On credit check error, either reject the run or apply a strict per-session cap ($0.50)

### 3. Email handler routes to DO without org_id
- **File:** `deploy/src/index.ts` ~line 6021
- **Issue:** `idFromName(agentName)` with no org prefix — cross-org collision
- **Fix:** Look up the agent's org_id from DB (by matching the email domain or a routing table), then prefix the DO name

### 4. Sandbox platform.r2 outbound has no org_id scoping
- **File:** `deploy/src/index.ts` ~line 77-95 (the `platform.r2` outbound handler)
- **Issue:** Sandbox code can `fetch("http://platform.r2/workspaces/OTHER_ORG/...")` and read any org's files
- **Fix:** Extract org_id from the sandbox's session context and validate the R2 key starts with the correct org prefix

## P1 — Should Fix Before Launch

### 5. knowledge-search has no org_id filter in Vectorize
- **File:** `deploy/src/runtime/tools.ts` ~line 5692
- **Issue:** Vectorize query filters by agent_name only, not org_id
- **Fix:** Add `org_id` to the Vectorize filter metadata

### 6. loadAgentConfig queries by name without org_id
- **File:** `deploy/src/runtime/db.ts` ~line 63-68
- **File:** `deploy/src/index.ts` ~line 1844-1848 (DO's _loadAgentConfig)
- **Issue:** `WHERE name = ${agentName}` without `AND org_id = ...`
- **Fix:** Pass org_id through and add to WHERE clause

### 7. WebSocket reconnect reads arbitrary KV key
- **File:** `deploy/src/index.ts` ~line 735-746
- **Issue:** `kv.get(data.progress_key)` accepts any key from client without validation
- **Fix:** Validate progress_key starts with expected DO name prefix

### 8. do_conversation_messages has no RLS
- **Fix:** Add service-role-only RLS policy (same as other service tables)

### 9. Container max_instances: 200
- **File:** `deploy/wrangler.jsonc` line 50
- **Fix:** Increase for production. Add timeout wrapper around getSandbox(). Add user feedback when capacity exhausted.

### 10. Workflow step count can hit 1000 limit
- **File:** `deploy/src/workflow.ts` (turn loop)
- **Fix:** Add step counter, force exit at 900 steps

### 11. Orphaned Workflows after DO restart/deploy
- **File:** `deploy/src/index.ts`
- **Fix:** Store {workflowInstanceId, progressKey} in DO SQLite. On reconnect, check for active Workflows and resume polling.

### 12. Dev JWT bypass when AUTH_JWT_SECRET unset
- **File:** `deploy/src/index.ts` ~line 776-785
- **Fix:** In production, reject all connections when AUTH_JWT_SECRET is not set (don't fall through to shape-check)

## P2 — Fix Soon After Launch

### 13. No wall-clock guard on Workflow
- **Fix:** Add `if (Date.now() - startTime > 270_000) break;` at top of turn loop

### 14. DO SQLite workspace files unbounded
- **Fix:** Check `PRAGMA page_count * page_size` before writing. Evict oldest when approaching 100MB.

### 15. Supabase connection pool exhaustion
- **Fix:** Monitor Hyperdrive pool. Add circuit breaker for non-critical DB ops.

### 16. saveProject OOMs on >50MB workspaces
- **Fix:** Check workspace size before tarring. Reject >30MB with user message.

### 17. rm -rf /workspace via bash — no recovery
- **Fix:** Periodic workspace scan in checkpointWorkspace to capture bash-created files.

### 18. Container eviction loses 0-30s of changes
- **Fix:** write-file/edit-file should trigger immediate R2 sync (already partially done via saveFileToSQLite).

### 19. Sandbox platform.kv outbound reads any key
- **Fix:** Validate KV key starts with the sandbox's org prefix.

### 20. image-generate stores to unscoped R2 key
- **Fix:** Add org_id prefix to image key.

## P3 — Nice to Have

### 21. hibernate: false keeps DOs in memory (cost at scale)
### 22. KV emit() read-modify-write race
### 23. KV outage: no streaming feedback
### 24. Close tab: can't retrieve orphaned run result
### 25. No input size validation
### 26. Billing records fire-and-forget

## Context for Next Session

### What was done this session:
- Full DB schema hardening (RLS on 139 tables, FK constraints, text→jsonb, column fixes)
- Query safety (org_id filters, is_active boolean, LIMIT caps, N+1 elimination)
- Transaction wrapping (signup, hard-delete, agent creation)
- parseJsonColumn helper (70+ unsafe JSON.parse calls fixed)
- WebSocket auth (hibernate: false, JWT validation on DO, token in URL)
- KV polling optimization (250ms fast poll, Workflow status fallback, doneSent guard)
- Tool timeouts (fetchWithTimeout 30s on all external calls)
- Container persistence (stable sandbox ID, 30m idle, R2 fallback in onStart)
- Browser pooling (per-session reuse, 2-min idle TTL, LRU eviction)
- Swarm tool (V8 isolate fan-out, parallel-exec, agent mode)
- System prompt rewrite (Claude Code patterns)
- execute-code (codemode) enabled for personal assistant
- Concurrency guard (_activeRun)
- Duplicate done event fix (doneSent guard)
- push-prompt.ts script for DB sync
- Cron handler for browser pool cleanup
- Checkpoint flag from harness config

### Deploy commands:
```bash
# Control-plane
cd control-plane && CLOUDFLARE_API_TOKEN=v5gnsvKJDVx4vm6PUfFNo2-zVp-JamjB70rxfpri CLOUDFLARE_ACCOUNT_ID=ae92d4bf7c6c448f442d084a2358dcd5 npx wrangler deploy

# Runtime
cd deploy && CLOUDFLARE_API_TOKEN=v5gnsvKJDVx4vm6PUfFNo2-zVp-JamjB70rxfpri CLOUDFLARE_ACCOUNT_ID=ae92d4bf7c6c448f442d084a2358dcd5 npx wrangler deploy

# MVP
cd mvp && npm run build && CLOUDFLARE_API_TOKEN=v5gnsvKJDVx4vm6PUfFNo2-zVp-JamjB70rxfpri CLOUDFLARE_ACCOUNT_ID=ae92d4bf7c6c448f442d084a2358dcd5 npx wrangler deploy

# Push prompt to DB
cd control-plane && DATABASE_URL="$(grep DATABASE_URL ../.env | cut -d= -f2-)" npx tsx scripts/push-prompt.ts --user=Ish
```

### Test command:
```bash
TOKEN=$(curl -s -X POST https://api.oneshots.co/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"founder@oneshots.co","password":"OneShots2026!"}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
```

### Git status:
- Branch: main
- All changes committed and pushed
- CI: GitHub Actions (typecheck + test + wrangler deploy)
- Tests: 198 passed (deploy), 0 errors (control-plane typecheck)
