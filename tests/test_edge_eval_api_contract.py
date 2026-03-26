"""Contract checks for edge-native eval read/write API surface."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEPLOY_INDEX = ROOT / "deploy" / "src" / "index.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_edge_eval_routes_exist() -> None:
    text = _read(DEPLOY_INDEX)
    assert 'url.pathname === "/api/v1/eval/run" && request.method === "POST"' in text
    assert 'url.pathname === "/api/v1/eval/runs" && request.method === "GET"' in text
    assert 'url.pathname.match(/^\\/api\\/v1\\/eval\\/runs\\/(\\d+)$/)' in text
    assert 'url.pathname.match(/^\\/api\\/v1\\/eval\\/runs\\/(\\d+)\\/trials$/)' in text


def test_edge_eval_routes_use_db_read_helpers() -> None:
    text = _read(DEPLOY_INDEX)
    assert "listEvalRuns(env.HYPERDRIVE" in text
    assert "getEvalRun(env.HYPERDRIVE" in text
    assert "listEvalTrialsByRun(env.HYPERDRIVE" in text


def test_edge_eval_routes_guard_with_service_token() -> None:
    text = _read(DEPLOY_INDEX)
    assert text.count('const serviceToken = env.SERVICE_TOKEN || "";') >= 4


def test_edge_eval_run_parses_request_body_safely() -> None:
    text = _read(DEPLOY_INDEX)
    assert "const rawBody = await request.text();" in text
    assert "invalid JSON body" in text
