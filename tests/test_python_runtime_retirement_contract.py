"""Static guards to prevent reintroducing Python runtime execution."""

from __future__ import annotations

import ast
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent

# FastAPI route decorators we treat as HTTP entrypoints (not app.on_event / lifespan).
_HTTP_ROUTE_METHODS = frozenset(
    {"get", "post", "put", "delete", "patch", "head", "options", "websocket"},
)

# `await gym.run(...)` is EvalGym orchestration, not the Agent harness loop.
_ALLOWED_AWAIT_RUN_RECEIVERS = frozenset({"gym"})

# Routers that still invoke Agent.run inside nested eval helpers (EvalGym + agent_fn).
_ROUTER_FILES_EXEMPT_FROM_AWAIT_RUN_SCAN = frozenset({"compare.py"})


def _route_decorator_binding(dec: ast.expr) -> str | None:
    """Return 'app' or 'router' for @app.get / @router.post; else None."""
    target = dec
    if isinstance(target, ast.Call):
        target = target.func
    if isinstance(target, ast.Attribute):
        if target.attr in _HTTP_ROUTE_METHODS and isinstance(target.value, ast.Name):
            if target.value.id in ("app", "router"):
                return target.value.id
    return None


def _iter_http_route_functions(
    tree: ast.AST,
    *,
    binding: str,
) -> list[ast.AsyncFunctionDef | ast.FunctionDef]:
    out: list[ast.AsyncFunctionDef | ast.FunctionDef] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        for dec in node.decorator_list:
            if _route_decorator_binding(dec) == binding:
                out.append(node)
                break
    return out


def _awaited_run_violations(func: ast.AST) -> list[tuple[int, str]]:
    """Find `await <recv>.run(...)` patterns in a function subtree."""
    bad: list[tuple[int, str]] = []
    for node in ast.walk(func):
        if not isinstance(node, ast.Await):
            continue
        call = node.value
        if not isinstance(call, ast.Call):
            continue
        fn = call.func
        if not isinstance(fn, ast.Attribute) or fn.attr != "run":
            continue
        recv = fn.value
        if isinstance(recv, ast.Name):
            if recv.id in _ALLOWED_AWAIT_RUN_RECEIVERS:
                continue
            bad.append((node.lineno, recv.id))
        else:
            bad.append((node.lineno, ast.unparse(recv)))
    return bad


def _assert_no_awaited_agent_runtime_in_routes(
    rel_path: str,
    *,
    binding: str,
) -> None:
    path = _REPO_ROOT / rel_path
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    violations: list[str] = []
    for fn in _iter_http_route_functions(tree, binding=binding):
        for lineno, detail in _awaited_run_violations(fn):
            violations.append(f"{rel_path}:{lineno}: await … .run() in `{fn.name}` ({detail})")
    if violations:
        joined = "\n".join(violations)
        raise AssertionError(
            "HTTP route handlers must not await Agent/AgentHarness-style .run() "
            f"(edge runtime is canonical). Violations:\n{joined}"
        )


def test_app_top_level_routes_do_not_await_agent_runtime() -> None:
    """CI guard: legacy @app.* handlers must not execute the Python agent loop."""
    _assert_no_awaited_agent_runtime_in_routes("agentos/api/app.py", binding="app")


def test_v1_router_handlers_do_not_await_agent_runtime() -> None:
    """CI guard: /api/v1 routers must not await harness/agent .run() (edge-only execution)."""
    routers_dir = _REPO_ROOT / "agentos" / "api" / "routers"
    for path in sorted(routers_dir.glob("*.py")):
        if path.name.startswith("_"):
            continue
        if path.name in _ROUTER_FILES_EXEMPT_FROM_AWAIT_RUN_SCAN:
            continue
        _assert_no_awaited_agent_runtime_in_routes(
            str(path.relative_to(_REPO_ROOT)),
            binding="router",
        )


def test_app_runtime_endpoints_are_deprecated_to_edge() -> None:
    text = (_REPO_ROOT / "agentos/api/app.py").read_text(encoding="utf-8")
    assert 'status_code=410' in text
    assert "/api/v1/runtime-proxy/agent/run" in text
    assert "Backend runtime execution is removed (edge-first architecture)." in text


def test_runtime_proxy_agent_run_is_blocked() -> None:
    text = (_REPO_ROOT / "agentos/api/routers/runtime_proxy.py").read_text(encoding="utf-8")
    assert "@router.post(\"/agent/run\")" in text
    assert "status_code=410" in text
    assert "worker `/api/v1/runtime-proxy/agent/run`" in text
