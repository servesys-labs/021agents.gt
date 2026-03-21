"""Tests for the evolution subsystem — observer, analyzer, proposals, ledger, loop."""

import pytest
import asyncio
import json
import tempfile
from pathlib import Path

from agentos.evolution.session_record import (
    SessionRecord,
    TurnRecord,
    CostBreakdown,
    ErrorRecord,
    ErrorSource,
    StopReason,
    SystemComposition,
)
from agentos.evolution.observer import Observer
from agentos.evolution.analyzer import FailureAnalyzer, AnalysisReport
from agentos.evolution.proposals import Proposal, ProposalStatus, ReviewQueue
from agentos.evolution.ledger import EvolutionLedger, _bump_version
from agentos.core.events import Event, EventBus, EventType


# ── Session Record Tests ─────────────────────────────────────────


class TestSessionRecord:
    def test_create_and_serialize(self):
        rec = SessionRecord(
            agent_name="test-agent",
            input_text="hello",
            output_text="world",
            status="success",
            stop_reason=StopReason.COMPLETED,
            step_count=3,
            action_count=2,
        )
        d = rec.to_dict()
        assert d["agent_name"] == "test-agent"
        assert d["status"] == "success"
        assert d["stop_reason"] == "completed"
        assert d["step_count"] == 3

    def test_cost_breakdown(self):
        cost = CostBreakdown()
        cost.add_llm(0.01, 0.02)
        cost.add_tool(0.005)
        assert cost.total_usd == pytest.approx(0.035)
        assert cost.llm_input_cost_usd == pytest.approx(0.01)
        assert cost.llm_output_cost_usd == pytest.approx(0.02)
        assert cost.tool_cost_usd == pytest.approx(0.005)

    def test_error_record(self):
        err = ErrorRecord(
            source=ErrorSource.TOOL,
            message="timeout",
            tool_name="web-search",
            turn=3,
        )
        assert err.source == ErrorSource.TOOL
        assert err.recoverable is True


# ── Analyzer Tests ────────────────────────────────────────────────


def _make_session(status="success", errors=None, tools=None, cost=0.01):
    """Helper to create test sessions."""
    rec = SessionRecord(
        agent_name="test",
        status=status,
        stop_reason=StopReason.COMPLETED if status == "success" else StopReason.LLM_ERROR,
        input_text="test input",
        output_text="test output",
        composition=SystemComposition(
            agent_name="test",
            tools_available=tools or ["web-search", "calculator"],
        ),
    )
    rec.cost = CostBreakdown(total_usd=cost)
    if errors:
        rec.errors = errors
    return rec


class TestFailureAnalyzer:
    def test_not_enough_sessions(self):
        analyzer = FailureAnalyzer(min_sessions=5)
        report = analyzer.analyze([_make_session()])
        assert report.total_sessions == 1
        assert "Need at least" in report.recommendations[0]

    def test_all_success(self):
        analyzer = FailureAnalyzer(min_sessions=3)
        sessions = [_make_session() for _ in range(5)]
        report = analyzer.analyze(sessions)
        assert report.success_rate == 1.0
        assert len(report.failure_clusters) == 0

    def test_failure_clustering(self):
        analyzer = FailureAnalyzer(min_sessions=3)
        sessions = [_make_session() for _ in range(3)]
        # Add failures
        for _ in range(4):
            sessions.append(_make_session(
                status="error",
                errors=[ErrorRecord(
                    source=ErrorSource.TOOL,
                    message="connection timeout",
                    tool_name="web-search",
                    turn=1,
                )],
            ))
        report = analyzer.analyze(sessions)
        assert report.success_rate < 1.0
        assert len(report.failure_clusters) > 0
        assert report.failure_clusters[0].pattern == "tool:web-search"

    def test_cost_anomaly_detection(self):
        analyzer = FailureAnalyzer(min_sessions=3)
        sessions = [_make_session(cost=0.01) for _ in range(5)]
        sessions.append(_make_session(cost=0.50))  # 50x average
        report = analyzer.analyze(sessions)
        assert len(report.cost_anomalies) > 0
        assert report.cost_anomalies[0].deviation_factor > 3

    def test_unused_tools(self):
        analyzer = FailureAnalyzer(min_sessions=3)
        sessions = [_make_session(tools=["web-search", "calculator", "unused-tool"]) for _ in range(5)]
        # No tool calls at all in these sessions
        report = analyzer.analyze(sessions)
        assert "unused-tool" in report.unused_tools

    def test_generate_proposals(self):
        analyzer = FailureAnalyzer(min_sessions=3)
        sessions = [_make_session() for _ in range(3)]
        for _ in range(4):
            sessions.append(_make_session(
                status="error",
                errors=[ErrorRecord(source=ErrorSource.TOOL, message="fail", tool_name="flaky-tool")],
            ))
        report = analyzer.analyze(sessions)

        config = {
            "name": "test",
            "system_prompt": "You are a test agent.",
            "tools": ["web-search", "flaky-tool"],
            "governance": {"budget_limit_usd": 5.0},
        }
        proposals = analyzer.generate_proposals(report, config)
        assert len(proposals) > 0
        # Should have a proposal about low success rate or tool failures
        categories = {p["category"] for p in proposals}
        assert len(categories) > 0


# ── Review Queue Tests ────────────────────────────────────────────


class TestReviewQueue:
    def test_ingest_and_surface(self):
        queue = ReviewQueue(surface_ratio=0.5, min_priority=0.1)
        raw = [
            {"title": "High priority", "priority": 0.9, "category": "prompt", "modification": {}, "rationale": "r", "evidence": {}},
            {"title": "Medium", "priority": 0.5, "category": "tools", "modification": {}, "rationale": "r", "evidence": {}},
            {"title": "Low", "priority": 0.2, "category": "memory", "modification": {}, "rationale": "r", "evidence": {}},
        ]
        surfaced = queue.ingest(raw)
        assert len(surfaced) >= 1
        # Highest priority should be surfaced
        assert surfaced[0].title == "High priority"

    def test_review_approve(self):
        queue = ReviewQueue()
        surfaced = queue.ingest([
            {"title": "Test", "priority": 0.8, "category": "prompt", "modification": {"system_prompt": "new"}, "rationale": "r", "evidence": {}},
        ])
        p = surfaced[0]
        result = queue.review(p.id, approved=True, note="LGTM")
        assert result.status == ProposalStatus.APPROVED
        assert result.reviewer_note == "LGTM"
        assert len(queue.approved) == 1

    def test_review_reject(self):
        queue = ReviewQueue()
        surfaced = queue.ingest([
            {"title": "Test", "priority": 0.8, "category": "prompt", "modification": {}, "rationale": "r", "evidence": {}},
        ])
        result = queue.review(surfaced[0].id, approved=False, note="Too risky")
        assert result.status == ProposalStatus.REJECTED

    def test_summary(self):
        queue = ReviewQueue()
        queue.ingest([
            {"title": "A", "priority": 0.9, "category": "prompt", "modification": {}, "rationale": "r", "evidence": {}},
            {"title": "B", "priority": 0.5, "category": "tools", "modification": {}, "rationale": "r", "evidence": {}},
        ])
        summary = queue.summary()
        assert summary["total_generated"] == 2
        assert summary["surfaced_for_review"] >= 1


# ── Ledger Tests ──────────────────────────────────────────────────


class TestEvolutionLedger:
    def test_bump_version(self):
        assert _bump_version("0.1.0") == "0.1.1"
        assert _bump_version("1.2.3") == "1.2.4"

    def test_apply_and_rollback(self):
        ledger = EvolutionLedger(agent_name="test")

        proposal = Proposal(
            title="Test change",
            category="prompt",
            modification={"system_prompt": "Updated prompt"},
        )

        config = {"name": "test", "version": "0.1.0", "system_prompt": "Original"}
        new_config = ledger.apply(config, proposal, metrics_before={"pass_rate": 0.5})

        assert new_config["version"] == "0.1.1"
        assert new_config["system_prompt"] == "Updated prompt"
        assert len(ledger.entries) == 1

        # Rollback
        old_config = ledger.rollback("0.1.1")
        assert old_config["system_prompt"] == "Original"
        assert old_config["version"] == "0.1.0"

    def test_record_impact(self):
        ledger = EvolutionLedger(agent_name="test")

        proposal = Proposal(title="Test", category="prompt", modification={"x": 1})
        ledger.apply({"version": "0.1.0"}, proposal, metrics_before={"pass_rate": 0.5})

        impact = ledger.record_impact("0.1.1", {"pass_rate": 0.7})
        assert impact["pass_rate"] == pytest.approx(0.2)

    def test_persistence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "ledger.json"
            ledger = EvolutionLedger(agent_name="test", storage_path=path)
            proposal = Proposal(title="Persist test", category="tools", modification={"tools": []})
            ledger.apply({"version": "0.1.0"}, proposal)

            assert path.exists()
            data = json.loads(path.read_text())
            assert len(data) == 1
            assert data[0]["proposal_title"] == "Persist test"

    def test_timeline(self):
        ledger = EvolutionLedger(agent_name="test")
        for i in range(3):
            proposal = Proposal(title=f"Change {i}", category="prompt", modification={})
            ledger.apply({"version": f"0.1.{i}"}, proposal)

        timeline = ledger.timeline()
        assert len(timeline) == 3
        assert all("version" in entry for entry in timeline)


# ── Observer Tests ────────────────────────────────────────────────


class TestObserver:
    def test_attach(self):
        bus = EventBus()
        observer = Observer(event_bus=bus)
        observer.attach(agent_name="test", agent_config={"model": "claude"})
        assert observer._attached is True

    def test_session_recording(self):
        """Test that observer captures sessions from events."""
        bus = EventBus()
        observer = Observer(event_bus=bus)
        observer.attach(agent_name="test", agent_config={
            "model": "claude-sonnet",
            "version": "0.1.0",
            "tools": ["web-search"],
            "memory": {},
            "governance": {},
            "system_prompt": "test",
        })

        async def simulate_session():
            await bus.emit(Event(type=EventType.SESSION_START, data={"input": "hello"}))
            await bus.emit(Event(type=EventType.TURN_START, data={"turn": 1}))
            await bus.emit(Event(type=EventType.LLM_REQUEST))
            await bus.emit(Event(type=EventType.LLM_RESPONSE, data={
                "model": "claude-sonnet", "content": "hi there",
            }))
            await bus.emit(Event(type=EventType.TURN_END, data={"turn": 1}))
            await bus.emit(Event(type=EventType.SESSION_END))

        asyncio.run(simulate_session())

        assert len(observer.records) == 1
        rec = observer.records[0]
        assert rec.agent_name == "test"
        assert rec.status == "success"
        assert rec.step_count == 1
        assert rec.composition.model == "claude-sonnet"

    def test_summary(self):
        bus = EventBus()
        observer = Observer(event_bus=bus)
        observer.attach(agent_name="test", agent_config={"system_prompt": ""})

        async def run_sessions():
            for _ in range(3):
                await bus.emit(Event(type=EventType.SESSION_START, data={"input": "test"}))
                await bus.emit(Event(type=EventType.TURN_START, data={"turn": 1}))
                await bus.emit(Event(type=EventType.TURN_END, data={"turn": 1}))
                await bus.emit(Event(type=EventType.SESSION_END))

        asyncio.run(run_sessions())

        summary = observer.summary()
        assert summary["total_sessions"] == 3
        assert summary["success_rate"] == 1.0

    def test_export(self):
        bus = EventBus()
        observer = Observer(event_bus=bus)
        observer.attach(agent_name="test", agent_config={"system_prompt": ""})

        async def run():
            await bus.emit(Event(type=EventType.SESSION_START, data={"input": "test"}))
            await bus.emit(Event(type=EventType.SESSION_END))

        asyncio.run(run())

        with tempfile.TemporaryDirectory() as tmpdir:
            path = observer.export(Path(tmpdir) / "sessions.jsonl")
            assert path.exists()
            lines = path.read_text().strip().split("\n")
            assert len(lines) == 1
            data = json.loads(lines[0])
            assert data["agent_name"] == "test"
