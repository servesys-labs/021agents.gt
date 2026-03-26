"""Static contract checks for the edge graph executor (`deploy/src/runtime/edge_graph.ts`)."""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_EDGE_GRAPH_TS = _REPO_ROOT / "deploy" / "src" / "runtime" / "edge_graph.ts"


def test_edge_graph_exports_executor_and_halt_sentinel() -> None:
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    assert "export const GRAPH_HALT" in text
    assert re.search(r"export async function runEdgeGraph\b", text)
    assert "export interface EdgeGraphNode" in text


def test_fresh_run_wires_through_graph_entrypoints() -> None:
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    assert "export async function executeFreshRunGraph" in text
    assert "fresh_bootstrap" in text and "fresh_turn_budget" in text
    assert "fresh_after_tools" in text and "fresh_loop_detect" in text


def test_resume_graph_wires_turn_gate_and_bump() -> None:
    text = _EDGE_GRAPH_TS.read_text(encoding="utf-8")
    assert "export async function executeResumeTurnGraph" in text
    assert "resume_turn_gate" in text and "resume_bump_turn" in text
