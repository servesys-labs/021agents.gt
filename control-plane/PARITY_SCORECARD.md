# TS Bug-Catch Parity Scorecard

This scorecard tracks bug-catching parity between legacy Python coverage and the TypeScript control-plane refactor.

Goal: match **risk-detection power**, not raw test count.

## Current Snapshot

- Control-plane route files: `43`
- Control-plane Vitest files: `33`
- Control-plane Vitest tests: `174`
- Latest run: `npm run test` and `npm exec -- tsc --noEmit` passing

## Tier-1 API Coverage (Risk-Based)

| API Surface | Happy Path | Authz Negative | Malformed Input | Contract/Parity Checks | Status |
|---|---:|---:|---:|---:|---|
| `auth` | yes | yes | yes | yes | **High** |
| `agents` | yes | yes | yes | yes | **High** |
| `graphs` | yes | yes | yes | yes | **High** |
| `eval` | yes | yes | yes | yes | **High** |
| `observability` | yes | yes | yes | yes | **High** |
| `releases` | yes | yes | yes | yes | **High** |
| `memory` | yes | yes | yes | yes | **High** |
| `sessions` | yes | yes | yes | yes | **High** |

Status definitions:
- **High**: strong bug-catching on critical failure modes.
- **Medium**: meaningful coverage exists, but major negative paths still missing.
- **Low**: high-risk gaps remain.

## What Landed In This Wave

- Added route-level tests for:
  - `auth`: password-disable policy behavior
  - `eval`: run validation, runtime proxy contract, org-scoped dataset listing
  - `memory`: non-empty derived working snapshot behavior
- Added parity/security contract tests for:
  - rate-limit JWT prefix + `/.well-known/agent.json` bypass
  - Clerk display-name fallback
  - LLM03 training-data-poisoning probe
  - config hash parity (`SHA-256`)

## What Landed In Wave 2

- Added route-level tests for:
  - `releases`: org-scoped channels behavior, promote-not-found path, canary input validation
  - `observability`: non-owner meta-proposal denial, maintenance `dry_run` persistence contract
  - `graphs`: gate-pack schema validation and org ownership denial
  - `agents`: create-from-description hold gate enforcement (`409`) and override reason enforcement (`422`)
- Hardened `releases` route queries to include org scoping across channels/canary and source promotion lookup.

## What Landed In Wave 3

- Added route-level tests for:
  - `sessions`: non-owned session denial, turns ownership denial, cleanup parameter clamping contract
  - `runtime-proxy`: service-token enforcement, required tool/name validation, upstream error passthrough
  - `security`: probe catalog contract, org-scoped findings query behavior, out-of-scope scan-report denial

## What Landed In Wave 4

- Added route-level contract tests for:
  - `agents`: malformed create payload rejection and runtime-moved endpoint guidance (`410`)
  - `eval`: downstream runtime failure normalization and status passthrough
  - `sessions`: trace endpoint response-shape contract (`trace_id`, `sessions`, `cost_rollup`)
  - `security`: AIVSS invalid payload rejection and valid response-shape contract

## What Landed In Wave 5

- Added route-level tests for:
  - `eval`: run/trials org-ownership denial (`404`) via DB-scoped checks
  - `releases`: canary read contract remains org-scoped (`null` when caller org has no record)
  - `observability`: meta-control-plane response contract sections + annotation required field validation
  - `memory`: facts upsert required-key validation + agent ownership denial path

## What Landed In Wave 6

- Added success-path contract tests for:
  - `releases`: promote response-shape parity and canary set/remove payload contracts
  - `observability`: summary numeric metrics contract and trace sessions/events contract
  - `memory`: procedures shape (`steps`, `success_rate`) and facts JSON parsing contract

## What Landed In Wave 7

- Added route-level parity tests for:
  - `sessions`: runtime profile success contract and feedback submission success contract
  - `agents`: list endpoint response-shape parity (`name`, `model`, `tools`, `tags`, `version`)
  - `graphs`: `/contracts/validate` success contract includes `summary.contracts`

## What Landed In Wave 8

- Added auth parity tests for:
  - protected endpoint authz negatives: `/me`, `/logout`, `/password` require authorization
  - `/me` success response contract for valid JWT claims
  - Clerk exchange role-mapping/org-membership parity (`org:admin` -> `admin`) with org membership upsert path

## What Landed In Wave 9

- Added security parity tests for:
  - scan report success contract (`scan_id`, `agent_name`, `risk_score`, `risk_level`, `summary`)
  - risk-trends chronological contract (oldest-first trend ordering, numeric risk scores)
- Hardened regression test ergonomics:
  - fixed noisy `authz-regression` stderr by injecting mocked env + DB stubs (no runtime null-env errors)

## What Landed In Wave 10 (Critical Closures)

- Closed enterprise-priority parity/security gaps with route + contract coverage for:
  - `plans`: added TS `GET /api/v1/plans`, `GET /api/v1/plans/:name`, and org-scoped custom `POST /api/v1/plans`
  - `voice`: added missing webhook/call write endpoints (`vapi` and `tavus`) with signature checks and outbound provider proxy paths
  - `releases`: removed unsafe cross-tenant `ON CONFLICT` upsert path in favor of org-scoped update-then-insert logic
  - `security`: aligned agent config loading to `agents.config_json` with robust parser-based decoding
  - `middleware`/`runtime-proxy`: enforced org filter on middleware event history and added `POST /runtime-proxy/agent/run` 410 parity shim
- Added corresponding regression tests:
  - `routes-plans.test.ts`, `routes-voice.test.ts`, `routes-middleware-status.test.ts`, `schemas-common.test.ts`
  - plus updates to `routes-releases.test.ts`, `routes-security.test.ts`, `routes-runtime-proxy.test.ts`

## High-Value Next Tests (Prioritized)

1. `observability`: full meta-control-plane payload richness parity versus Python.
2. `releases`: channel transition policy edge cases (invalid from/to combinations).
3. `eval`: deeper run/trial payload field-level parity versus Python response shapes.
4. `agents`: strict graph-lint rejection message-level parity for create/update/import.
5. `security`: additional report metadata parity (optional fields and remediations ordering).

## Cutover Exit Criteria (Bug-Catch Parity)

For each Tier-1 API above:

1. At least 1 happy-path test.
2. At least 1 authz-denial test.
3. At least 1 malformed-input test.
4. At least 1 contract/parity test (status + response shape + key fields).
5. Every historical security finding has a permanent regression test.

When all five criteria are true across Tier-1 APIs, TS is considered bug-catch parity ready for cutover.
