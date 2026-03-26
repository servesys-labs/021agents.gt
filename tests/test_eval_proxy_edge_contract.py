"""Static contract: control-plane eval proxy body aligns with worker /api/v1/eval/run."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVAL_ROUTER = ROOT / "agentos" / "api" / "routers" / "eval.py"
DEPLOY_INDEX = ROOT / "deploy" / "src" / "index.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_control_plane_eval_run_proxy_posts_json_payload_with_tasks() -> None:
    text = _read(EVAL_ROUTER)
    assert "json=payload" in text
    assert '"tasks": edge_tasks' in text
    assert "_load_tasks_from_eval_path" in text


def test_worker_eval_run_accepts_json_body_and_optional_query_overrides() -> None:
    text = _read(DEPLOY_INDEX)
    assert 'url.pathname === "/api/v1/eval/run" && request.method === "POST"' in text
    assert "const rawBody = await request.text();" in text
    assert 'url.searchParams.get("agent_name")' in text
    assert 'url.searchParams.get("trials")' in text
    assert "tasks are required" in text
