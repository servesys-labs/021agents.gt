# Pre-Beta Release Checklist

This checklist is the minimum gate before inviting beta users.

## 1) Deploy Candidate Build

- Deploy `control-plane`, `deploy`, and `ui` from the candidate branch.
- Confirm deploy logs show expected version IDs and no binding drift.

## 2) Run Pre-Beta Health Suite

- Run the suite in fast mode first:

```bash
E2E_ORG_ID="<org_id>" \
E2E_USER_EMAIL="<email>" \
E2E_USER_PASSWORD="<password>" \
PREBETA_RUN_INFRA_GATE=0 \
bash scripts/pre_beta_health_suite.sh
```

- Run full mode before final go/no-go:

```bash
E2E_CONTROL_PLANE_URL="<control_plane_url>" \
E2E_RUNTIME_URL="<runtime_url>" \
E2E_SERVICE_TOKEN="<service_token>" \
E2E_ORG_ID="<org_id>" \
E2E_AGENT_NAME="<agent_name>" \
E2E_USER_EMAIL="<email>" \
E2E_USER_PASSWORD="<password>" \
PREBETA_RUN_INFRA_GATE=1 \
bash scripts/pre_beta_health_suite.sh
```

## 3) Verify SLO Gate Pass

The suite hard-fails if any threshold is breached:

- `done_missing_rate <= 0.20`
- `ttft_p95_ms <= 12000`
- `completion_gate_exhausted_rate <= 0.05`

Override defaults with:

- `PREBETA_MAX_DONE_MISSING_RATE`
- `PREBETA_MAX_TTFT_P95_MS`
- `PREBETA_MAX_COMPLETION_GATE_EXHAUSTED_RATE`

## 4) Inspect Artifacts

Review generated reports:

- `artifacts/prebeta-health/summary.json`
- `artifacts/prebeta-health/summary.md`

Required checks:

- `overall_status` is `pass`
- baseline probe has terminal `done`
- completion probe is one of:
  - `executed` (gate intervened and execution continued),
  - `guarded_terminal` (safe blocked completion),
  - `natural_completion` (non-plan final deliverable)

## 5) Completion-Gate Reliability Check

- Confirm recent `otel_events` include `completion_gate` events when plan-trap prompts are used.
- Confirm no spike in `completion_gate_exhausted` terminations.

## 6) Rollback Readiness

- Verify previous stable Worker version IDs are available.
- Verify rollback owner and command are documented before release.

