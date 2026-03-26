"""Regression guard for Worker `loadRuntimeEventsPage` replay pagination / watermark.

The deploy worker has no TypeScript test harness. This module asserts SQL shape and
control-flow invariants in ``deploy/src/runtime/db.ts`` so filtered MAX(id) watermarks,
clamping, and cursor-at-watermark behavior do not drift from the API contract.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DB_TS = _REPO_ROOT / "deploy" / "src" / "runtime" / "db.ts"

_MARKER = "export async function loadRuntimeEventsPage"
_REPLAY_MARKER = "export async function replayOtelEventsAtCursor"
_FN_OPEN = "): Promise<RuntimeEventPage> {"
_REPLAY_FN_OPEN = "): Promise<TraceReplayAtCursor> {"


def _extract_load_runtime_events_page_body(source: str) -> str:
    idx = source.find(_MARKER)
    assert idx >= 0, f"missing {_MARKER!r} in db.ts"
    sig = source.find(_FN_OPEN, idx)
    assert sig >= 0, f"missing {_FN_OPEN!r} after loadRuntimeEventsPage in db.ts"
    brace_open = source.find("{", sig)
    assert brace_open >= 0
    depth = 0
    i = brace_open
    while i < len(source):
        c = source[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return source[brace_open : i + 1]
        i += 1
    raise AssertionError("unbalanced braces in loadRuntimeEventsPage")


def _extract_replay_otel_events_at_cursor_body(source: str) -> str:
    idx = source.find(_REPLAY_MARKER)
    assert idx >= 0, f"missing {_REPLAY_MARKER!r} in db.ts"
    sig = source.find(_REPLAY_FN_OPEN, idx)
    assert sig >= 0, f"missing {_REPLAY_FN_OPEN!r} after replayOtelEventsAtCursor in db.ts"
    brace_open = source.find("{", sig)
    assert brace_open >= 0
    depth = 0
    i = brace_open
    while i < len(source):
        c = source[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return source[brace_open : i + 1]
        i += 1
    raise AssertionError("unbalanced braces in replayOtelEventsAtCursor")


@pytest.fixture(scope="module")
def load_runtime_events_page_body() -> str:
    return _extract_load_runtime_events_page_body(_DB_TS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def replay_otel_events_at_cursor_body() -> str:
    return _extract_replay_otel_events_at_cursor_body(_DB_TS.read_text(encoding="utf-8"))


def test_load_runtime_events_page_session_max_id_uses_session_and_filters(
    load_runtime_events_page_body: str,
) -> None:
    assert re.search(
        r"SELECT MAX\(id\) AS max_id\s+"
        r"FROM otel_events\s+"
        r"WHERE session_id = \$\{sessionId\}"
        r"[\s\S]{0,520}?"
        r"AND \(\$\{eventType\} = '' OR event_type = \$\{eventType\}\)\s+"
        r"AND \(\$\{toolName\} = '' OR tool_name = \$\{toolName\}\)\s+"
        r"AND \(\$\{status\} = '' OR status = \$\{status\}\)\s+"
        r"AND \(\$\{fromTsMs\} <= 0 OR created_at >= (?:TO_TIMESTAMP\(\$\{fromTsMs\} / 1000\.0\)|\(\$\{fromTsMs\} / 1000\.0\))\)\s+"
        r"AND \(\$\{toTsMs\} <= 0 OR created_at <= (?:TO_TIMESTAMP\(\$\{toTsMs\} / 1000\.0\)|\(\$\{toTsMs\} / 1000\.0\))\)",
        load_runtime_events_page_body,
    ), "session-scope MAX(id) must apply the same filter dimensions as the page query"


def test_load_runtime_events_page_trace_max_id_uses_trace_join_and_filters(
    load_runtime_events_page_body: str,
) -> None:
    assert re.search(
        r"SELECT MAX\(e\.id\) AS max_id\s+"
        r"FROM otel_events e\s+"
        r"INNER JOIN sessions s ON s\.session_id = e\.session_id\s+"
        r"WHERE s\.trace_id = \$\{traceId\}"
        r"[\s\S]{0,520}?"
        r"AND \(\$\{eventType\} = '' OR e\.event_type = \$\{eventType\}\)\s+"
        r"AND \(\$\{toolName\} = '' OR e\.tool_name = \$\{toolName\}\)\s+"
        r"AND \(\$\{status\} = '' OR e\.status = \$\{status\}\)\s+"
        r"AND \(\$\{fromTsMs\} <= 0 OR e\.created_at >= (?:TO_TIMESTAMP\(\$\{fromTsMs\} / 1000\.0\)|\(\$\{fromTsMs\} / 1000\.0\))\)\s+"
        r"AND \(\$\{toTsMs\} <= 0 OR e\.created_at <= (?:TO_TIMESTAMP\(\$\{toTsMs\} / 1000\.0\)|\(\$\{toTsMs\} / 1000\.0\))\)",
        load_runtime_events_page_body,
    ), "trace-scope MAX(id) must apply the same filter dimensions as the trace page query"


def test_load_runtime_events_page_clamps_provided_watermark_to_filtered_max(
    load_runtime_events_page_body: str,
) -> None:
    assert load_runtime_events_page_body.count(
        "watermark = providedWatermark > 0 ? Math.min(providedWatermark, maxWatermark) : maxWatermark;"
    ) == 2, "expected identical clamp assignment in session and trace branches"


def test_load_runtime_events_page_cursor_at_watermark_returns_watermark_as_next_cursor(
    load_runtime_events_page_body: str,
) -> None:
    matches = re.findall(
        r"if \(cursorNum >= watermark\) \{[\s\S]*?"
        r"next_cursor:\s*String\(watermark\)[\s\S]*?"
        r"watermark_cursor:\s*String\(watermark\)",
        load_runtime_events_page_body,
    )
    assert len(matches) == 2, (
        "session and trace branches must return next_cursor from watermark when cursor >= watermark"
    )
    assert "String(cursorNum)" not in "".join(matches), (
        "early-exit replay must not advance next_cursor from cursor when at/ past watermark"
    )


def test_load_runtime_events_page_queries_include_filter_predicates_on_rows(
    load_runtime_events_page_body: str,
) -> None:
    """event_type / tool_name / status / from_ts_ms / to_ts_ms appear in all four SQL windows."""
    body = load_runtime_events_page_body
    assert body.count("AND (${fromTsMs} <= 0 OR") == 4
    assert body.count("AND (${toTsMs} <= 0 OR") == 4
    assert body.count("event_type = ${eventType}") == 4
    assert body.count("tool_name = ${toolName}") == 4
    assert body.count("status = ${status}") == 4


def test_load_runtime_events_page_rows_bounded_by_cursor_and_watermark_twice(
    load_runtime_events_page_body: str,
) -> None:
    needle = "AND e.id > ${cursorNum}\n        AND e.id <= ${watermark}"
    assert load_runtime_events_page_body.count(needle) == 2, (
        "session and trace page queries must bound ids by cursor and effective watermark"
    )


def test_replay_otel_events_at_cursor_orders_by_id_asc(replay_otel_events_at_cursor_body: str) -> None:
    body = replay_otel_events_at_cursor_body
    assert body.count("ORDER BY e.id ASC") >= 4, "replay must use deterministic id ordering for all fetch branches"


def test_replay_otel_events_at_cursor_up_to_row_id_predicates(replay_otel_events_at_cursor_body: str) -> None:
    assert re.search(
        r"AND e\.id <= \$\{upToRowId\}",
        replay_otel_events_at_cursor_body,
    ), "trace/session replay branches must bound prefix with up_to_row_id"


def test_replay_otel_events_at_cursor_folds_state_snapshot(replay_otel_events_at_cursor_body: str) -> None:
    assert "foldStateSnapshotFromRuntimeEvents" in replay_otel_events_at_cursor_body
    assert "state_snapshot" in replay_otel_events_at_cursor_body
