from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEPLOY_SRC = ROOT / "deploy" / "src" / "index.ts"
WRANGLER = ROOT / "deploy" / "wrangler.jsonc"
SETUP = ROOT / "deploy" / "scripts" / "setup.mjs"
PKG = ROOT / "deploy" / "package.json"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_deploy_uses_modern_agents_sdk_version() -> None:
    text = _read(PKG)
    assert '"agents": "^0.7.9"' in text


def test_mcp_server_is_sdk_native_and_tool_parity() -> None:
    text = _read(DEPLOY_SRC)
    assert 'import {\n  Agent,' in text or 'Agent,' in text
    assert "class AgentOSMcpServer extends Agent<Env>" in text
    assert 'name: "search-knowledge"' in text
    assert 'if (toolName === "search-knowledge")' in text


def test_callable_methods_and_sql_tables() -> None:
    text = _read(DEPLOY_SRC)
    assert "@callable()" in text
    assert "CREATE TABLE IF NOT EXISTS conversation_messages" in text


def test_setup_script_uses_wrangler_and_secrets() -> None:
    text = _read(SETUP)
    assert "wrangler" in text
    assert "BACKEND_INGEST_TOKEN" in text


def test_wrangler_has_no_unused_ai_gateway_binding() -> None:
    text = _read(WRANGLER)
    assert '"ai_gateway"' not in text
