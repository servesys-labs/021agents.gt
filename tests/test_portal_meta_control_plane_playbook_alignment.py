"""Ensure canvas meta-agent rail consumes meta-control-plane playbook payload."""

from __future__ import annotations

from pathlib import Path


def _canvas_source() -> str:
    root = Path(__file__).resolve().parents[1]
    return (root / "portal" / "src" / "pages" / "canvas" / "index.tsx").read_text(encoding="utf-8")


def _assist_source() -> str:
    root = Path(__file__).resolve().parents[1]
    return (root / "portal" / "src" / "components" / "canvas" / "MetaAgentAssist.tsx").read_text(encoding="utf-8")


def test_canvas_fetches_meta_control_plane_for_active_agent() -> None:
    text = _canvas_source()
    assert "/api/v1/observability/agents/" in text
    assert "meta-control-plane?generate_proposals=false&persist_generated=false" in text
    assert "playbookAgentName" in text
    assert "playbookQuery" in text


def test_meta_agent_assist_renders_playbook_sections() -> None:
    text = _assist_source()
    assert "Meta Agent Playbook" in text
    assert "control_plane_entrypoints" in text
    assert "langchain_equivalent_runtime" in text
    assert "multi_agent_blueprint" in text
    assert "Use In Prompt" in text
    assert "playbookPromptTemplates" in text
    assert "Auto-Fix + Gate Pack" in text
    assert "Gate Decision:" in text
    assert "I understand gate decision is hold" in text
    assert "Type OVERRIDE to confirm" in text
    assert "Override reason (required)" in text
    assert "Run Maintenance Cycle" in text
    assert "Approval Packet" in text
    assert "Open proposals" in text
    assert "Run gate-pack" in text
    assert "Promote candidate" in text
