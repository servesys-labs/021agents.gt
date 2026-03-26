from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.auth.jwt import create_token, set_secret
from agentos.core.harness import AgentHarness


def _auth_header() -> dict[str, str]:
    set_secret("test-eval-control-plane")
    token = create_token(user_id="eval-user", email="eval@test.com")
    return {"Authorization": f"Bearer {token}"}


def test_eval_tasks_upload_route_accepts_json_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = TestClient(create_app(AgentHarness()))
    files = [("files", ("demo.json", json.dumps([{"input": "hi"}]), "application/json"))]
    resp = client.post("/api/v1/eval/tasks/upload", files=files, headers=_auth_header())
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1


def test_eval_run_post_uses_query_params_and_requires_edge_proxy(tmp_path, monkeypatch):
    """Portal POSTs `/api/v1/eval/run` with agent_name, eval_file, trials as query params."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("EDGE_RUNTIME_URL", raising=False)
    client = TestClient(create_app(AgentHarness()))
    resp = client.post(
        "/api/v1/eval/run?agent_name=demo&eval_file=eval%2Ftasks.json&trials=2",
        headers=_auth_header(),
    )
    assert resp.status_code == 410
    detail = resp.json().get("detail", "")
    assert "EDGE_RUNTIME_URL" in detail


def test_eval_run_proxy_loads_tasks_and_posts_json_to_edge(tmp_path, monkeypatch):
    """Control plane keeps query contract; edge call uses JSON body with tasks."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "eval").mkdir()
    (tmp_path / "eval" / "tasks.json").write_text(
        json.dumps([{"name": "t1", "input": "hi", "expected": "hi", "grader": "contains"}]),
        encoding="utf-8",
    )
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example")
    monkeypatch.delenv("EDGE_RUNTIME_TOKEN", raising=False)

    captured: dict = {}

    async def mock_post(url: str, **kwargs: object) -> MagicMock:
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["params"] = kwargs.get("params")
        r = MagicMock()
        r.status_code = 200
        r.text = '{"run_id": 42}'
        r.json = lambda: {"run_id": 42}
        return r

    mock_client = MagicMock()
    mock_client.post = AsyncMock(side_effect=mock_post)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("agentos.api.routers.eval.httpx.AsyncClient", return_value=mock_client):
        client = TestClient(create_app(AgentHarness()))
        resp = client.post(
            "/api/v1/eval/run?agent_name=demo&eval_file=eval%2Ftasks.json&trials=2",
            headers=_auth_header(),
        )

    assert resp.status_code == 200
    assert resp.json() == {"run_id": 42}
    assert captured["url"] == "https://edge.example/api/v1/eval/run"
    payload = captured["json"]
    assert isinstance(payload, dict)
    assert payload["agent_name"] == "demo"
    assert payload["trials"] == 2
    assert payload["eval_name"] == "tasks"
    assert len(payload["tasks"]) == 1
    assert payload["tasks"][0]["input"] == "hi"
    assert captured.get("params") is None


def test_eval_run_proxy_rejects_eval_file_outside_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example")
    client = TestClient(create_app(AgentHarness()))
    resp = client.post(
        "/api/v1/eval/run?agent_name=demo&eval_file=..%2Foutside.json&trials=1",
        headers=_auth_header(),
    )
    assert resp.status_code == 400


def test_eval_run_proxy_rejects_empty_task_list(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "eval").mkdir()
    (tmp_path / "eval" / "empty.json").write_text("[]", encoding="utf-8")
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example")
    client = TestClient(create_app(AgentHarness()))
    resp = client.post(
        "/api/v1/eval/run?agent_name=demo&eval_file=eval%2Fempty.json&trials=1",
        headers=_auth_header(),
    )
    assert resp.status_code == 400
    assert "no tasks" in resp.json().get("detail", "").lower()


def test_eval_tasks_list_route(tmp_path, monkeypatch):
    """Filesystem-backed; does not require DB (unlike GET /eval/runs)."""
    monkeypatch.chdir(tmp_path)
    client = TestClient(create_app(AgentHarness()))
    tasks = client.get("/api/v1/eval/tasks")
    assert tasks.status_code == 200
    assert "tasks" in tasks.json()


def test_eval_control_plane_dataset_and_evaluator_routes(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = TestClient(create_app(AgentHarness()))
    headers = _auth_header()

    save_ds = client.post(
        "/api/v1/eval/datasets",
        json={"name": "smoke", "items": [{"input": "hello", "expected": "hello"}]},
        headers=headers,
    )
    assert save_ds.status_code == 200
    assert save_ds.json()["saved"] == "smoke"

    list_ds = client.get("/api/v1/eval/datasets")
    assert list_ds.status_code == 200
    assert any(d["name"] == "smoke" for d in list_ds.json()["datasets"])

    save_eval = client.post(
        "/api/v1/eval/evaluators",
        json={"name": "contains", "kind": "rule", "config": {"mode": "contains"}},
        headers=headers,
    )
    assert save_eval.status_code == 200
    assert save_eval.json()["saved"] == "contains"

    list_eval = client.get("/api/v1/eval/evaluators")
    assert list_eval.status_code == 200
    assert any(e["name"] == "contains" for e in list_eval.json()["evaluators"])
