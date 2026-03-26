"""Static contract checks for edge bounded DAG API surface."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEPLOY_INDEX = ROOT / "deploy" / "src" / "index.ts"
RUNTIME_LINEAR = ROOT / "deploy" / "src" / "runtime" / "linear_declarative.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_edge_dag_route_exists_and_is_guarded() -> None:
    text = _read(DEPLOY_INDEX)
    assert 'url.pathname === "/api/v1/graphs/dag-run" && request.method === "POST"' in text
    assert 'const serviceToken = env.SERVICE_TOKEN || "";' in text


def test_edge_dag_route_uses_bounded_executor_and_contract_fields() -> None:
    text = _read(DEPLOY_INDEX)
    assert "executeBoundedDagDeclarativeRun" in text
    assert "validation?: { execution_order?: string[]; graph_id?: string }" in text
    assert "execution_order: result.execution_order" in text
    assert "execution_trace: result.execution_trace" in text
    assert "trace_digest_sha256: traceDigestSha256" in text


def test_edge_dag_route_maps_validation_mismatch_to_conflict() -> None:
    text = _read(DEPLOY_INDEX)
    assert 'result.error_code === "VALIDATION_MISMATCH"' in text
    assert "? 409" in text


def test_edge_runtime_dag_executor_enforces_execution_order_validation() -> None:
    text = _read(RUNTIME_LINEAR)
    assert "export function executeBoundedDagDeclarativeRun" in text
    assert "validation.execution_order does not match graph structure" in text
    assert 'error_code: "VALIDATION_MISMATCH"' in text


def test_edge_dag_route_hashes_trace_with_sha256() -> None:
    text = _read(DEPLOY_INDEX)
    assert "async function sha256Hex(" in text
    assert 'crypto.subtle.digest("SHA-256"' in text
    assert "sha256Hex(JSON.stringify(result.execution_trace))" in text
