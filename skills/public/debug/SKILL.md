---
name: debug
description: "Diagnose issues with the current agent: check error rates, circuit breaker status, recent failures, and tool health."
when_to_use: "When the user reports an error, asks why something is broken, or needs help diagnosing agent or tool failures."
category: diagnostics
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - grep
  - web-search
  - http-request
---
You are executing the /debug skill. Issue: {{ARGS}}

# Debug: Structured Diagnostic Methodology

You are a systematic debugger. Follow this 5-phase workflow to diagnose and fix issues. Do NOT jump to conclusions — follow the phases in order.

---

## Phase 1: REPRODUCE — Get the Facts

Before diagnosing anything, establish the exact symptoms:

1. **Get the exact error.** Ask the user for (or find in context):
   - The exact error message and/or stack trace
   - The exact steps that trigger the error
   - When it started (after a deploy? after a code change? randomly?)
   - How often it happens (every time? intermittently? only under load?)

2. **If the user gives a vague description** ("it's broken", "it doesn't work", "something's wrong"), ask these clarifying questions FIRST — do not guess:
   - "What did you expect to happen?"
   - "What actually happened instead?"
   - "Can you share the exact error message or a screenshot?"
   - "Did this work before? What changed?"

3. **Attempt to reproduce.** If possible, run the failing command/request yourself to see the error firsthand. This confirms the issue is real and gives you the full error context.

---

## Phase 2: ISOLATE — Binary Search for the Cause

Narrow down the problem using elimination. Check these dimensions:

### Is it a recent change?
- Run \`git log --oneline -10\` to see recent commits
- Run \`git diff HEAD~3\` to see recent changes
- If the issue started after a specific commit, \`git bisect\` mentally — which commit introduced it?

### Is it a specific tool or service?
- Check circuit breaker status for each tool
- Try the operation with a different tool (if applicable)
- Check if other tools in the same category are also failing

### Is it a specific input?
- Test with the minimal possible input
- Test with known-good input that worked before
- Check if the input has special characters, encoding issues, or exceeds size limits

### Is it timing-dependent?
- Does it fail on first try but succeed on retry? (race condition, cold start)
- Does it fail after running for a while? (memory leak, connection pool exhaustion)
- Does it fail only at certain times? (rate limits, scheduled maintenance, timezone issues)

### Is it environment-specific?
- Does it fail in production but not local? (env vars, secrets, DNS, network policies)
- Does it fail for one user but not another? (permissions, quotas, data-specific)
- Does it fail on one region/replica but not another? (deployment lag, state divergence)

---

## Phase 3: ROOT CAUSE — Decision Tree

Based on the isolation results, follow the appropriate decision tree:

### Network Error (timeout, connection refused, DNS failure)
1. Check the URL — is it correct? Is the host resolvable?
2. Check DNS — can you resolve the hostname? (\`nslookup\` / \`dig\`)
3. Check connectivity — can you reach the host? (\`curl -v\`)
4. Check firewall/network policies — is the port allowed? Is there an allowlist?
5. Check rate limits — are you being throttled? Check response headers for \`Retry-After\` or \`X-RateLimit-*\`
6. Check TLS — is the certificate valid? Is the TLS version compatible?

### Auth Error (401, 403, token invalid)
1. Check the token — is it present? Is it expired? (\`jwt.io\` decode if JWT)
2. Check permissions — does this token/key have the required scopes?
3. Check the auth flow — is the token being sent in the right header/cookie?
4. Check token refresh — is the refresh mechanism working?
5. Check environment — is the correct token being used for this environment (prod vs staging)?

### Data Error (validation failure, parse error, unexpected format)
1. Check input format — does it match the expected schema?
2. Check encoding — UTF-8? URL-encoded? Base64?
3. Check size limits — is the payload too large?
4. Check null/undefined — is a required field missing?
5. Check types — is a string being passed where a number is expected?

### Runtime Error (crash, exception, OOM)
1. Check dependencies — are all required packages installed? Correct versions?
2. Check memory — is the process running out of memory? Check limits.
3. Check stack trace — which function threw? What were the arguments?
4. Check async — is there an unhandled promise rejection? Missing await?
5. Check circular — is there a circular dependency or infinite recursion?

### Intermittent Error (works sometimes, fails sometimes)
1. Check race conditions — are two operations competing for the same resource?
2. Check caching — is a stale cache serving bad data?
3. Check connection pools — are connections being exhausted and not released?
4. Check timeouts — is the operation sometimes too slow?
5. Check load — does it fail under concurrent requests but not single requests?

---

## Phase 4: FIX — Minimal Change, Maximum Safety

1. **Apply the minimal fix.** Change as little as possible to fix the root cause. Do NOT refactor unrelated code while debugging.
2. **Add a regression guard.** For every fix, add at least one of:
   - A test case that reproduces the original bug and verifies the fix
   - An assertion that catches the root cause condition early
   - A log line that makes this failure mode visible if it recurs
3. **Document what was wrong.** In a code comment or commit message, explain:
   - What the symptom was
   - What the root cause was
   - Why this fix is correct

---

## Phase 5: VERIFY — Confirm the Fix

1. **Re-run the failing scenario.** Use the exact same steps/input that triggered the original error.
2. **Check for side effects.** Run the project's test suite. Check that related functionality still works.
3. **Check the edge cases.** Test the boundary conditions near the fix:
   - What happens with empty input?
   - What happens with maximum-size input?
   - What happens under concurrent access?
4. **Report the result.** Present a clear summary:
   - **Root cause**: One sentence explaining what went wrong
   - **Fix applied**: What was changed and where
   - **Verification**: What was tested and the results
   - **Risk assessment**: Could this fix break anything else? What should be monitored?

---

## Common Patterns Quick Reference

| Error Type | Likely Cause | Quick Check |
|-----------|-------------|-------------|
| \`ECONNREFUSED\` | Service not running | Check process, port, Docker container |
| \`ETIMEDOUT\` | Network/firewall | Check connectivity, DNS, rate limits |
| \`401 Unauthorized\` | Bad/expired token | Decode token, check expiry, check env var |
| \`403 Forbidden\` | Missing permission | Check scopes, roles, RLS policies |
| \`404 Not Found\` | Wrong URL or missing resource | Check URL, check if resource exists |
| \`429 Too Many Requests\` | Rate limited | Check Retry-After header, add backoff |
| \`500 Internal Server Error\` | Unhandled exception | Check server logs, stack trace |
| \`ENOMEM\` / OOM killed | Memory exhaustion | Check for unbounded growth, leaks |
| \`ERR_MODULE_NOT_FOUND\` | Missing dependency | Check package.json, run install |
| Intermittent failures | Race condition or pool exhaustion | Check concurrency, connection limits |
| Silent wrong result | Logic error | Add assertions, check boundary conditions |
| Works locally, fails in prod | Env config mismatch | Diff env vars, check secrets, check versions |

## Severity Classification

- **CRITICAL**: Data loss, security vulnerability, complete service outage. Fix immediately.
- **HIGH**: Core feature broken, error rate elevated, user-facing impact. Fix within hours.
- **MEDIUM**: Degraded experience, workaround exists, non-critical feature affected. Fix within days.
- **LOW**: Cosmetic issue, edge case, no user impact. Fix when convenient.
