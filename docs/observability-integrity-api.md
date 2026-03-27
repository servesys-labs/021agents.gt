# Observability — trace integrity API

Base path: `/api/v1/observability`  
Auth: Bearer JWT or API key with scope `observability:read`.

## `GET /integrity/breaches`

Returns recent trace integrity breach records from `audit_log` (`action = trace.integrity_breach`, `resource_type = trace`).

### Query parameters

| Name       | Type   | Default | Description |
| ---------- | ------ | ------- | ----------- |
| `limit`    | number | 50      | Max rows (clamped 1–200). |
| `trace_id` | string | —       | If set, only breaches for this trace id. |

### Response (`200`)

```json
{
  "total_breaches": 0,
  "strict_breaches": 0,
  "non_strict_breaches": 0,
  "hottest_traces": [{ "trace_id": "string", "breaches": 0 }],
  "entries": [
    {
      "trace_id": "string",
      "created_at": "ISO-8601 string",
      "user_id": "string",
      "strict": false,
      "missing_turns": 0,
      "missing_runtime_events": 0,
      "missing_billing_records": 0,
      "lifecycle_mismatch": 0,
      "warnings": ["string"]
    }
  ]
}
```

- `hottest_traces`: up to 10 traces with the highest breach counts (from the current result set).
- Each `entries[]` row mirrors the JSON stored in `audit_log.changes_json` at write time, plus `trace_id`, `created_at`, and `user_id`.

## `GET /trace/:trace_id/integrity`

Runs a consistency check for one trace (sessions, turns, runtime events, billing, lifecycle signals).

### Query parameters

| Name               | Type    | Default | Description |
| ------------------ | ------- | ------- | ----------- |
| `strict`           | boolean | false   | When true, missing billing is reported even for very recent traces. |
| `alert_on_breach`  | boolean | false   | When true and the trace is incomplete, best-effort insert into `audit_log` with `trace.integrity_breach`. |

### Response (`200`)

```json
{
  "trace_id": "string",
  "complete": true,
  "consistency_window_ms": 90000,
  "is_recent_trace": false,
  "counts": {
    "sessions": 0,
    "turns": 0,
    "runtime_events": 0,
    "billing_records": 0
  },
  "missing": {
    "turns": ["session_id"],
    "runtime_events": ["session_id"],
    "billing_records": ["session_id"],
    "lifecycle_mismatch": ["session_id"]
  },
  "warnings": ["string"]
}
```

### Errors

- `404` — trace not found for the org (`{ "error": "Trace not found" }`).
