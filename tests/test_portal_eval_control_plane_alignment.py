"""Ensure portal eval page calls match control-plane eval router paths and query shape."""

from __future__ import annotations

from pathlib import Path


def _eval_page_source() -> str:
    root = Path(__file__).resolve().parents[1]
    path = root / "portal" / "src" / "pages" / "eval" / "index.tsx"
    return path.read_text(encoding="utf-8")


def test_portal_eval_uses_control_plane_routes() -> None:
    text = _eval_page_source()
    assert '"/api/v1/eval/tasks"' in text
    assert '"/api/v1/eval/tasks/upload"' in text
    assert "/api/v1/eval/runs?limit=" in text
    assert "/api/v1/eval/run?agent_name=" in text
    assert "encodeURIComponent(agentName)" in text
    assert "encodeURIComponent(evalFile)" in text
    assert "&trials=${trials}" in text
    assert "/api/v1/eval/runs/${runId}" in text
    assert 'formData.append("files", file)' in text


def test_portal_eval_documents_python_router() -> None:
    text = _eval_page_source()
    assert "agentos/api/routers/eval.py" in text
