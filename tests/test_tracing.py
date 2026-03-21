"""Tests for span-based tracing and observability."""

import pytest
from agentos.core.tracing import Span, Trace, Tracer


class TestSpan:
    def test_span_attributes(self):
        span = Span(trace_id="t1", name="test")
        span.set_attribute("model", "claude")
        span.set_attribute("tokens", 100)
        assert span.attributes["model"] == "claude"
        assert span.attributes["tokens"] == 100

    def test_span_events(self):
        span = Span(trace_id="t1", name="test")
        span.add_event("retry", {"attempt": 2})
        assert len(span.events) == 1
        assert span.events[0]["name"] == "retry"

    def test_span_error(self):
        span = Span(trace_id="t1", name="test")
        span.set_error("Connection failed")
        assert span.status == "error"
        assert span.attributes["error"] == "Connection failed"

    def test_span_finish(self):
        span = Span(trace_id="t1", name="test")
        span.finish()
        assert span.end_time > 0
        assert span.duration_ms >= 0

    def test_span_to_dict(self):
        span = Span(trace_id="t1", span_id="s1", name="test", kind="llm")
        span.set_attribute("model", "claude")
        span.finish()
        d = span.to_dict()
        assert d["trace_id"] == "t1"
        assert d["span_id"] == "s1"
        assert d["kind"] == "llm"
        assert d["attributes"]["model"] == "claude"


class TestTracer:
    def test_start_trace(self):
        tracer = Tracer()
        with tracer.start_trace("my-session") as trace:
            assert trace.trace_id
        assert tracer.span_count == 1  # root span

    def test_nested_spans(self):
        tracer = Tracer()
        with tracer.start_trace("session") as trace:
            with trace.span("turn_1", kind="turn") as turn:
                with turn.span("llm_call", kind="llm") as llm:
                    llm.set_attribute("model", "claude")
                with turn.span("tool_call", kind="tool") as tool:
                    tool.set_attribute("tool_name", "search")

        # 1 root + 1 turn + 2 children = 4 spans
        assert tracer.span_count == 4

    def test_parent_child_ids(self):
        tracer = Tracer()
        with tracer.start_trace("session") as trace:
            with trace.span("turn", kind="turn") as turn:
                with turn.span("llm", kind="llm") as llm:
                    pass

        spans = tracer.export()
        by_name = {s["name"]: s for s in spans}
        # root has no parent
        assert by_name["session"]["parent_span_id"] is None
        # turn's parent is root
        assert by_name["turn"]["parent_span_id"] == by_name["session"]["span_id"]
        # llm's parent is turn
        assert by_name["llm"]["parent_span_id"] == by_name["turn"]["span_id"]

    def test_export_trace(self):
        tracer = Tracer()
        with tracer.start_trace("s1") as t1:
            with t1.span("a"):
                pass
        with tracer.start_trace("s2") as t2:
            with t2.span("b"):
                pass

        # Each trace has root + 1 child = 2 spans
        assert len(tracer.export_trace(t1.trace_id)) == 2
        assert len(tracer.export_trace(t2.trace_id)) == 2

    def test_build_tree(self):
        tracer = Tracer()
        with tracer.start_trace("session") as trace:
            with trace.span("turn_1", kind="turn") as turn:
                with turn.span("llm", kind="llm"):
                    pass
                with turn.span("tool", kind="tool"):
                    pass
            with trace.span("turn_2", kind="turn"):
                pass

        tree = tracer.build_tree(trace.trace_id)
        assert tree["name"] == "session"
        assert len(tree["children"]) == 2  # turn_1, turn_2
        turn_1 = tree["children"][0]
        assert turn_1["name"] == "turn_1"
        assert len(turn_1["children"]) == 2  # llm, tool

    def test_error_propagation(self):
        tracer = Tracer()
        with pytest.raises(ValueError):
            with tracer.start_trace("session") as trace:
                with trace.span("bad", kind="tool"):
                    raise ValueError("boom")

        spans = tracer.export()
        bad = [s for s in spans if s["name"] == "bad"][0]
        assert bad["status"] == "error"
        assert "boom" in bad["attributes"]["error"]

    def test_clear(self):
        tracer = Tracer()
        with tracer.start_trace("s"):
            pass
        assert tracer.span_count > 0
        tracer.clear()
        assert tracer.span_count == 0


class TestSpanPersistence:
    def test_insert_and_query_spans(self, tmp_path):
        from agentos.core.database import create_database
        db = create_database(tmp_path / "test.db")

        tracer = Tracer()
        with tracer.start_trace("session") as trace:
            with trace.span("turn_1", kind="turn") as turn:
                turn.set_attribute("model", "claude")
                with turn.span("llm_call", kind="llm") as llm:
                    llm.set_attribute("tokens", 150)

        db.insert_spans(tracer.export(), session_id="sess-001")

        # Query by trace
        spans = db.query_trace(trace.trace_id)
        assert len(spans) == 3  # root + turn + llm

        # Query by kind
        llm_spans = db.query_spans(kind="llm")
        assert len(llm_spans) == 1
        assert llm_spans[0]["attributes"]["tokens"] == 150

        # Query by session
        session_spans = db.query_spans(session_id="sess-001")
        assert len(session_spans) == 3
        db.close()


class TestFeedbackPersistence:
    def test_insert_and_query_feedback(self, tmp_path):
        from agentos.core.database import create_database
        db = create_database(tmp_path / "test.db")

        # Insert session first (FK)
        db.insert_session({
            "session_id": "sess-f1",
            "composition": {},
            "cost": {},
            "benchmark_cost": {},
        })

        # Insert feedback
        fid = db.insert_feedback(
            session_id="sess-f1",
            rating=1,
            turn_number=2,
            correction="The answer should be 42",
            comment="Good effort but wrong number",
            tags=["math", "factual"],
        )
        assert fid > 0

        # Query
        feedback = db.query_feedback(session_id="sess-f1")
        assert len(feedback) == 1
        assert feedback[0]["rating"] == 1
        assert feedback[0]["correction"] == "The answer should be 42"
        assert feedback[0]["tags"] == ["math", "factual"]

        # Negative feedback
        db.insert_feedback(session_id="sess-f1", rating=-1, comment="Bad")
        db.insert_feedback(session_id="sess-f1", rating=1, comment="Good")

        neg = db.query_feedback(rating=-1)
        assert len(neg) == 1
        db.close()

    def test_feedback_summary(self, tmp_path):
        from agentos.core.database import create_database
        db = create_database(tmp_path / "test.db")

        db.insert_session({
            "session_id": "sess-fs1",
            "composition": {"agent_name": "bot"},
            "cost": {},
            "benchmark_cost": {},
        })
        db.insert_feedback(session_id="sess-fs1", rating=1)
        db.insert_feedback(session_id="sess-fs1", rating=1)
        db.insert_feedback(session_id="sess-fs1", rating=-1)

        summary = db.feedback_summary()
        assert summary["total"] == 3
        assert summary["positive"] == 2
        assert summary["negative"] == 1
        assert summary["approval_rate"] == pytest.approx(2 / 3)
        db.close()


class TestTraceSummary:
    """Tests for the Phase 3 programmatic trace query API."""

    def test_trace_summary_full(self, tmp_path):
        from agentos.core.database import create_database
        db = create_database(tmp_path / "test.db")

        db.insert_session({
            "session_id": "sess-ts1",
            "composition": {"agent_name": "bot", "model": "claude"},
            "status": "success",
            "stop_reason": "completed",
            "stop_initiated_by": "agent",
            "finish_accepted": True,
            "wall_clock_seconds": 2.5,
            "step_count": 2,
            "action_count": 3,
            "cost": {"total_usd": 0.05, "llm_input_cost_usd": 0.02, "llm_output_cost_usd": 0.03, "tool_cost_usd": 0.0},
            "benchmark_cost": {"total_usd": 0.001, "llm_input_cost_usd": 0.0, "llm_output_cost_usd": 0.001, "tool_cost_usd": 0.0},
        })
        db.insert_turns("sess-ts1", [
            {"turn_number": 1, "model_used": "claude", "input_tokens": 100, "output_tokens": 50,
             "latency_ms": 200, "llm_content": "Hi", "cost": {"total_usd": 0.03},
             "tool_calls": [{"name": "search"}], "tool_results": [], "errors": []},
            {"turn_number": 2, "model_used": "claude", "input_tokens": 150, "output_tokens": 80,
             "latency_ms": 300, "llm_content": "Done", "cost": {"total_usd": 0.02},
             "tool_calls": [], "tool_results": [], "errors": []},
        ])
        db.insert_feedback(session_id="sess-ts1", rating=1, comment="Great")

        summary = db.trace_summary("sess-ts1")
        assert summary["session"]["status"] == "success"
        assert summary["session"]["stop_initiated_by"] == "agent"
        assert summary["session"]["cost_total_usd"] == pytest.approx(0.05)
        assert len(summary["turns"]) == 2
        assert summary["turns"][0]["tool_calls"] == 1
        assert len(summary["feedback"]) == 1
        assert summary["feedback"][0]["rating"] == 1

    def test_trace_summary_missing_session(self, tmp_path):
        from agentos.core.database import create_database
        db = create_database(tmp_path / "test.db")
        assert db.trace_summary("nonexistent") == {}
        db.close()
