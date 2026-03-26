"""Adapter interoperability fixtures for LangChain-shaped object models (no LangChain dep)."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentos.api.routers.runtime_proxy import _merge_tool_schemas_metadata, _resolve_runnable_task
from agentos.integrations.lc_adapters import (
    RunnableOutputParse,
    RunnablePromptFormat,
    RunnableToolSchema,
    coerce_tool_call_request,
    format_runnable_prompt,
    merge_prompt_variables,
    normalize_tool_schemas,
)


# Fixtures mimicking common LCEL / tool-call JSON shapes from external clients.
LC_PROMPT_FIXTURE = {
    "template": "Translate to {lang}: {text}",
    "variables": {"lang": "fr", "text": "hello"},
}

LC_TOOL_SCHEMA_FIXTURE = {
    "name": "weather_lookup",
    "description": "Get weather",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}

LC_OUTPUT_JSON_FIXTURE = '{"answer": 42}'

LC_TOOL_CALL_BODY = {
    "name": "web_search",
    "tool_input": {"query": "pytest", "max_results": 3},
}


def test_runnable_prompt_format_roundtrip():
    fmt = RunnablePromptFormat.from_spec(LC_PROMPT_FIXTURE)
    merged = merge_prompt_variables(LC_PROMPT_FIXTURE, {"extra": 1})
    assert "extra" in merged
    assert fmt.format(merged) == "Translate to fr: hello"


def test_format_runnable_prompt_with_dict_input():
    spec = {"template": "Q: {q}\nCtx: {ctx}", "variables": {"ctx": "none"}}
    out = format_runnable_prompt(spec, {"q": "why?"})
    assert "why?" in out
    assert "none" in out


def test_runnable_output_parse_json_and_fences():
    p = RunnableOutputParse.from_spec({"kind": "json"})
    assert p.parse(LC_OUTPUT_JSON_FIXTURE) == {"answer": 42}
    fenced = '```json\n{"a": 1}\n```'
    assert p.parse(fenced) == {"a": 1}


def test_runnable_output_parse_lines():
    p = RunnableOutputParse.from_spec({"kind": "lines"})
    assert p.parse(" a \n\nb ") == ["a", "b"]


def test_runnable_tool_schema_openai_style():
    ts = RunnableToolSchema.from_dict(LC_TOOL_SCHEMA_FIXTURE)
    oai = ts.to_openai_style()
    assert oai["type"] == "function"
    assert oai["function"]["name"] == "weather_lookup"


def test_normalize_tool_schemas_skips_invalid():
    out = normalize_tool_schemas(
        [
            LC_TOOL_SCHEMA_FIXTURE,
            {"bad": True},
            {"name": "x", "parameters": {}},
        ]
    )
    assert len(out) == 2
    assert out[0]["name"] == "weather_lookup"
    assert out[1]["name"] == "x"


def test_coerce_tool_call_request_langchain_shape():
    name, args = coerce_tool_call_request(LC_TOOL_CALL_BODY)
    assert name == "web_search"
    assert args["query"] == "pytest"


def test_coerce_prefers_non_empty_args_bucket():
    name, args = coerce_tool_call_request(
        {
            "tool": "web_search",
            "args": {},
            "tool_input": {"query": "x"},
        }
    )
    assert name == "web_search"
    assert args == {"query": "x"}


def test_resolve_runnable_task_uses_template():
    task = _resolve_runnable_task({"q": "hi"}, {"template": "Say {q}", "variables": {}})
    assert task == "Say hi"


def test_merge_tool_schemas_metadata():
    base = {"run": "a"}
    merged = _merge_tool_schemas_metadata(base, [LC_TOOL_SCHEMA_FIXTURE])
    assert "tool_schemas" in merged
    assert merged["tool_schemas"][0]["name"] == "weather_lookup"
    assert _merge_tool_schemas_metadata(base, None) == base


@pytest.fixture
def proxy_client(monkeypatch) -> TestClient:
    """Minimal app: main ``create_app`` does not mount runtime-proxy (edge-only deploys)."""
    monkeypatch.setenv("EDGE_INGEST_TOKEN", "edge-lc-test")
    from agentos.api.routers import runtime_proxy as rp

    app = FastAPI()
    app.include_router(rp.router, prefix="/api/v1")
    return TestClient(app)


def test_tool_call_proxy_accepts_name_and_tool_input(proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """Runtime proxy /tool/call accepts LangChain-shaped field names."""
    import agentos.tools.builtins as builtins_mod

    async def fake_web_search(query: str = "", max_results: int = 5) -> str:
        return json.dumps({"stub": query, "max_results": max_results})

    monkeypatch.setattr(builtins_mod, "web_search", fake_web_search)

    r = proxy_client.post(
        "/api/v1/runtime-proxy/tool/call",
        headers={"X-Edge-Token": "edge-lc-test"},
        json=LC_TOOL_CALL_BODY,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "pytest" in body.get("output", "")
    assert body.get("tool") == "web_search"


def test_tool_call_proxy_requires_tool_or_name(proxy_client: TestClient):
    r = proxy_client.post(
        "/api/v1/runtime-proxy/tool/call",
        headers={"X-Edge-Token": "edge-lc-test"},
        json={"args": {}},
    )
    assert r.status_code == 400
