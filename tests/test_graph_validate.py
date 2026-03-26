from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from agentos.graph.validate import validate_graph_definition


class TestValidateGraphDefinition:
    def test_valid_dag_summary(self):
        spec = {
            "id": "my-graph",
            "nodes": [
                {"id": "a", "type": "llm"},
                {"id": "b"},
            ],
            "edges": [{"source": "a", "target": "b"}],
        }
        r = validate_graph_definition(spec)
        assert r.valid
        assert r.errors == []
        assert r.summary is not None
        assert r.summary["graph_id"] == "my-graph"
        assert r.summary["node_count"] == 2
        assert r.summary["edge_count"] == 1
        assert r.summary["topological_order"] == ["a", "b"]
        assert r.summary["entry_nodes"] == ["a"]
        assert r.summary["exit_nodes"] == ["b"]

    def test_from_to_edge_aliases(self):
        spec = {
            "nodes": [{"id": "x"}, {"id": "y"}],
            "edges": [{"from": "x", "to": "y"}],
        }
        r = validate_graph_definition(spec)
        assert r.valid

    def test_not_object(self):
        r = validate_graph_definition([])
        assert not r.valid
        assert r.errors[0].code == "GRAPH_NOT_OBJECT"

    def test_invalid_nodes_type(self):
        r = validate_graph_definition({"nodes": {}})
        assert not r.valid
        assert r.errors[0].code == "INVALID_NODES"

    def test_missing_node_id(self):
        r = validate_graph_definition({"nodes": [{"type": "llm"}], "edges": []})
        assert not r.valid
        assert any(e.code == "MISSING_NODE_ID" for e in r.errors)

    def test_duplicate_node_id(self):
        r = validate_graph_definition(
            {"nodes": [{"id": "n"}, {"id": "n"}], "edges": []},
        )
        assert not r.valid
        assert any(e.code == "DUPLICATE_NODE_ID" for e in r.errors)

    def test_missing_node_ref_on_edge(self):
        r = validate_graph_definition(
            {
                "nodes": [{"id": "a"}],
                "edges": [{"source": "a", "target": "ghost"}],
            },
        )
        assert not r.valid
        assert any(e.code == "MISSING_NODE_REF" for e in r.errors)

    def test_self_loop(self):
        r = validate_graph_definition(
            {
                "nodes": [{"id": "a"}],
                "edges": [{"source": "a", "target": "a"}],
            },
        )
        assert not r.valid
        assert any(e.code == "SELF_LOOP" for e in r.errors)

    def test_cycle(self):
        r = validate_graph_definition(
            {
                "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
                "edges": [
                    {"source": "a", "target": "b"},
                    {"source": "b", "target": "c"},
                    {"source": "c", "target": "a"},
                ],
            },
        )
        assert not r.valid
        cyc = [e for e in r.errors if e.code == "CYCLE"]
        assert len(cyc) == 1
        assert "cycle" in cyc[0].details
        assert len(cyc[0].details["cycle"]) >= 3

    def test_isolated_node_warning(self):
        connected = validate_graph_definition(
            {
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"source": "a", "target": "b"}],
            },
        )
        assert connected.valid
        assert not any(w.code == "ISOLATED_NODE" for w in connected.warnings)

        single = validate_graph_definition(
            {
                "nodes": [{"id": "only"}],
                "edges": [],
            },
        )
        assert single.valid
        assert any(w.code == "ISOLATED_NODE" for w in single.warnings)

        two_islands = validate_graph_definition(
            {"nodes": [{"id": "x"}, {"id": "y"}], "edges": []},
        )
        assert two_islands.valid
        assert sum(1 for w in two_islands.warnings if w.code == "ISOLATED_NODE") == 2

    def test_empty_graph_warning(self):
        r = validate_graph_definition({"nodes": [], "edges": []})
        assert r.valid
        assert any(w.code == "EMPTY_GRAPH" for w in r.warnings)
        assert r.summary["node_count"] == 0

    def test_duplicate_edge_warning(self):
        r = validate_graph_definition(
            {
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [
                    {"source": "a", "target": "b"},
                    {"source": "a", "target": "b"},
                ],
            },
        )
        assert r.valid
        assert any(w.code == "DUPLICATE_EDGE" for w in r.warnings)

    def test_invalid_graph_id(self):
        r = validate_graph_definition({"id": "", "nodes": [{"id": "a"}], "edges": []})
        assert not r.valid
        assert any(e.code == "INVALID_GRAPH_ID" for e in r.errors)

    def test_issue_to_dict_json_serializable(self):
        r = validate_graph_definition({"nodes": [{"id": "a"}], "edges": []})
        assert r.valid
        for w in r.warnings:
            json.dumps(w.to_dict())


@pytest.fixture
def graph_api_client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "agents").mkdir()
    from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4

    db = create_database(tmp_path / "data" / "agent.db")
    for migration in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
        for stmt in migration.split(";"):
            stmt = stmt.strip()
            if stmt and not stmt.startswith("--"):
                try:
                    db.conn.execute(stmt)
                except Exception:
                    pass
    db.conn.commit()
    db.close()

    from agentos.api.app import create_app
    from agentos.core.harness import AgentHarness

    return TestClient(create_app(AgentHarness()))


class TestGraphValidateApi:
    def test_requires_auth(self, graph_api_client):
        resp = graph_api_client.post(
            "/api/v1/graphs/validate",
            json={"graph": {"nodes": [{"id": "a"}], "edges": []}},
        )
        assert resp.status_code == 401

    def test_validate_ok_and_cycle(self, graph_api_client):
        password = "pass12345"
        signup = graph_api_client.post(
            "/api/v1/auth/signup",
            json={"email": "graph-val@test.com", "password": password},
        )
        if signup.status_code == 200:
            token = signup.json()["token"]
        else:
            assert signup.status_code == 409
            login = graph_api_client.post(
                "/api/v1/auth/login",
                json={"email": "graph-val@test.com", "password": password},
            )
            assert login.status_code == 200
            token = login.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        ok = graph_api_client.post(
            "/api/v1/graphs/validate",
            json={
                "graph": {
                    "nodes": [{"id": "a"}, {"id": "b"}],
                    "edges": [{"source": "a", "target": "b"}],
                },
            },
            headers=headers,
        )
        assert ok.status_code == 200
        body = ok.json()
        assert body["valid"] is True
        assert body["errors"] == []
        assert body["summary"]["topological_order"] == ["a", "b"]

        bad = graph_api_client.post(
            "/api/v1/graphs/validate",
            json={
                "graph": {
                    "nodes": [{"id": "a"}, {"id": "b"}],
                    "edges": [
                        {"source": "a", "target": "b"},
                        {"source": "b", "target": "a"},
                    ],
                },
            },
            headers=headers,
        )
        assert bad.status_code == 200
        b2 = bad.json()
        assert b2["valid"] is False
        assert any(e["code"] == "CYCLE" for e in b2["errors"])
        assert b2["summary"] is None

    def test_contracts_validate_reports_contract_summary(self, graph_api_client):
        password = "pass12345"
        signup = graph_api_client.post(
            "/api/v1/auth/signup",
            json={"email": "graph-contracts@test.com", "password": password},
        )
        if signup.status_code == 200:
            token = signup.json()["token"]
        else:
            assert signup.status_code == 409
            login = graph_api_client.post(
                "/api/v1/auth/login",
                json={"email": "graph-contracts@test.com", "password": password},
            )
            assert login.status_code == 200
            token = login.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        spec = {
            "state_contract": {"reducers": {"memory.facts": "append"}},
            "nodes": [
                {"id": "a", "kind": "bootstrap"},
                {
                    "id": "b",
                    "kind": "tools",
                    "skills": [{"id": "skill.memory.writer", "side_effects": "write", "state_writes": ["memory.facts"]}],
                    "state_writes": ["memory.facts"],
                },
                {"id": "c", "kind": "final"},
            ],
            "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "c"}],
        }
        resp = graph_api_client.post(
            "/api/v1/graphs/contracts/validate",
            json={"graph": spec, "strict": True},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is True
        contracts = body["summary"]["contracts"]
        assert contracts["state_contract_present"] is True
        assert contracts["skill_manifest_count"] == 1
        assert contracts["state_write_refs"] == 1
