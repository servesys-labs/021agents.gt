"""Contract parity checks for runnable metadata between backend and edge."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PY_SCHEMAS = ROOT / "agentos" / "api" / "schemas.py"
TS_TYPES = ROOT / "deploy" / "src" / "runtime" / "types.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _extract_python_fields(text: str, class_name: str) -> set[str]:
    m = re.search(rf"class {class_name}\(BaseModel\):([\s\S]*?)(?:\nclass |\Z)", text)
    assert m, f"missing {class_name} in schemas.py"
    body = m.group(1)
    return set(re.findall(r"^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:", body, flags=re.MULTILINE))


def _extract_ts_fields(text: str, interface_name: str) -> set[str]:
    m = re.search(rf"export interface {interface_name} \{{([\s\S]*?)\n\}}", text)
    assert m, f"missing {interface_name} in types.ts"
    body = m.group(1)
    return set(re.findall(r"^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:", body, flags=re.MULTILINE))


def test_runnable_metadata_fields_match_between_backend_and_edge() -> None:
    py_text = _read(PY_SCHEMAS)
    ts_text = _read(TS_TYPES)
    py_fields = _extract_python_fields(py_text, "RunnableRunMetadata")
    ts_fields = _extract_ts_fields(ts_text, "RunnableRunMetadata")
    assert py_fields == ts_fields


def test_runnable_metadata_required_contract_keys_present() -> None:
    py_text = _read(PY_SCHEMAS)
    fields = _extract_python_fields(py_text, "RunnableRunMetadata")
    required = {
        "success",
        "turns",
        "tool_calls",
        "cost_usd",
        "latency_ms",
        "session_id",
        "trace_id",
        "run_id",
        "stop_reason",
        "checkpoint_id",
        "parent_session_id",
        "resumed_from_checkpoint",
        "run_name",
        "tags",
        "metadata",
        "input_raw",
    }
    assert required.issubset(fields)
