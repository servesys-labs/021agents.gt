"""Regression guard for Worker `edgeResume` lifecycle telemetry.

The deploy worker has no TypeScript test harness. This module asserts the
contract at the closest deterministic seam: the resume graph in
``deploy/src/runtime/edge_graph.ts`` plus ``session_resume`` / ``session_end``
emitted from ``deploy/src/runtime/engine.ts``.

`EDGE_RESUME_GRAPH_EMIT_ORDER` documents the canonical emit-type sequence for
resume turn execution; pytest keeps it aligned with historical expectations.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_EDGE_GRAPH_TS = _REPO_ROOT / "deploy" / "src" / "runtime" / "edge_graph.ts"
_ENGINE_TS = _REPO_ROOT / "deploy" / "src" / "runtime" / "engine.ts"

_EXPECTED_EDGE_RESUME_GRAPH_EMIT_ORDER = [
    "turn_start",
    "node_error",
    "turn_end",
    "node_start",
    "llm_response",
    "node_end",
    "turn_end",
    "node_start",
    "tool_call",
    "tool_result",
    "node_end",
    "turn_end",
]


def _parse_ts_string_array_const(source: str, const_name: str) -> list[str]:
    m = re.search(
        rf"export const {re.escape(const_name)}\s*=\s*\[([\s\S]*?)\]\s+as const",
        source,
    )
    assert m, f"missing {const_name} array in source"
    return re.findall(r'"([a-z_]+)"', m.group(1))


def test_edge_resume_graph_emit_order_const_matches_expected() -> None:
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    found = _parse_ts_string_array_const(text, "EDGE_RESUME_GRAPH_EMIT_ORDER")
    assert found == _EXPECTED_EDGE_RESUME_GRAPH_EMIT_ORDER


def test_edge_resume_llm_failure_emits_node_error_then_turn_end_with_llm_error() -> None:
    """LLM failure must close the turn (node_error + turn_end) like the success path."""
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    assert re.search(
        r"pushRuntimeEvent\(events,\s*\"node_error\"[\s\S]*?"
        r"pushRuntimeEvent\(events,\s*\"turn_end\"[\s\S]*?"
        r"stop_reason:\s*\"llm_error\"[\s\S]*?"
        r"done:\s*true",
        text,
    ), "expected node_error followed by turn_end with stop_reason llm_error and done true"


def test_edge_resume_engine_wraps_session_resume_and_session_end() -> None:
    text = _ENGINE_TS.read_text(encoding="utf-8")
    idx = text.find("export async function edgeResume")
    assert idx >= 0
    tail = text[idx:]
    assert 'pushRuntimeEvent(ctx.events, "session_resume"' in tail
    assert 'pushRuntimeEvent(ctx.events, "session_end"' in tail


def test_edge_resume_session_resume_includes_checkpoint_context() -> None:
    text = _ENGINE_TS.read_text(encoding="utf-8")
    m = re.search(
        r'pushRuntimeEvent\(ctx\.events,\s*"session_resume"[\s\S]*?\}\);',
        text,
    )
    assert m, "session_resume emit block not found"
    block = m.group(0)
    for key in ("checkpoint_id:", "parent_session_id:", "trace_id:", "session_id:"):
        assert key in block, f"session_resume payload should include {key!r}"


def test_edge_resume_tool_stage_emits_call_result_node_end_turn_end() -> None:
    """Tool continuation: per-tool call/result, close subgraph, then turn_end (done false)."""
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    assert re.search(
        r"pushRuntimeEvent\(events,\s*\"tool_call\"[\s\S]*?"
        r"pushRuntimeEvent\(events,\s*\"tool_result\"[\s\S]*?"
        r"pushRuntimeEvent\(events,\s*\"node_end\"[\s\S]*?"
        r"node_id:\s*\"subgraph_tools\"[\s\S]*?"
        r"pushRuntimeEvent\(events,\s*\"turn_end\"[\s\S]*?"
        r"done:\s*false[\s\S]*?"
        r"stop_reason:\s*\"tool_call\"",
        text,
    ), "expected tool_call → tool_result → subgraph node_end → turn_end(done false, tool_call)"


def test_edge_resume_success_without_tools_turn_end_end_turn() -> None:
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    assert re.search(
        r"pushRuntimeEvent\(events,\s*\"node_end\"[\s\S]*?"
        r"node_id:\s*\"llm\"[\s\S]*?"
        r"pushRuntimeEvent\(events,\s*\"turn_end\"[\s\S]*?"
        r"stop_reason:\s*\"end_turn\"[\s\S]*?"
        r"done:\s*true",
        text,
    ), "expected llm node_end then turn_end with end_turn and done true"
