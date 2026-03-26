"""Contract coverage for edge human-approval checkpoint flow."""

from __future__ import annotations

from pathlib import Path


def test_edge_graph_contains_fresh_approval_node() -> None:
    text = Path("deploy/src/runtime/edge_graph.ts").read_text()
    assert "const FRESH_APPROVAL" in text
    assert "human_approval_required" in text
    assert "status: \"pending_approval\"" in text


def test_engine_persists_pending_checkpoint_and_returns_checkpoint_id() -> None:
    text = Path("deploy/src/runtime/engine.ts").read_text()
    assert "if (ctx.pendingCheckpoint)" in text
    assert "writeCheckpoint(" in text
    assert "checkpoint_id: checkpointId || undefined" in text
