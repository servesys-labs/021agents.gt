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
    assert 'import { McpAgent } from "agents/mcp";' in text
    assert "class AgentOSMcpServer extends McpAgent<Env>" in text
    assert 'name: "search-knowledge"' in text
    assert 'if (toolName === "search-knowledge")' in text


def test_schedule_and_queue_use_modern_call_patterns() -> None:
    text = _read(DEPLOY_SRC)
    assert 'this.schedule(cronOrDelay, "runScheduledTask", { id, taskInput });' in text
    assert 'this.queue("processJob", { jobId, taskInput, priority });' in text
    assert "CREATE TABLE IF NOT EXISTS schedules" in text
    assert "CREATE TABLE IF NOT EXISTS jobs" in text


def test_setup_endpoints_match_current_http_surface() -> None:
    text = _read(SETUP)
    assert "/agents/agentos/:name/stats" in text
    assert "/agents/agentos/:name/sessions" in text
    assert "/agents/agentos/:name/tools" not in text
    assert "/agents/agentos/:name/ingest" not in text
    assert "/agents/agentos/:name/eval" not in text


def test_wrangler_has_no_unused_ai_gateway_binding() -> None:
    text = _read(WRANGLER)
    assert '"ai_gateway"' not in text
