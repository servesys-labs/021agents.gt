"""Tests for memory persistence — episodic, procedural, facts to SQLite."""

import pytest
from pathlib import Path


class TestEpisodicPersistence:
    def test_store_persists_to_db(self, tmp_path):
        from agentos.core.database import create_database
        from agentos.memory.episodic import EpisodicMemory, Episode

        db = create_database(tmp_path / "test.db")
        mem = EpisodicMemory(db=db)

        ep = Episode(input="hello", output="world")
        mem.store(ep)

        # Check DB directly
        row = db.conn.execute("SELECT * FROM episodes WHERE id = ?", (ep.id,)).fetchone()
        assert row is not None
        assert row["input"] == "hello"
        assert row["output"] == "world"
        db.close()

    def test_loads_from_db_on_init(self, tmp_path):
        from agentos.core.database import create_database
        from agentos.memory.episodic import EpisodicMemory, Episode

        db = create_database(tmp_path / "test.db")

        # Store episode in first instance
        mem1 = EpisodicMemory(db=db)
        mem1.store(Episode(input="remember this", output="got it"))
        assert mem1.count() == 1

        # Create new instance — should load from DB
        mem2 = EpisodicMemory(db=db)
        assert mem2.count() == 1
        results = mem2.search("remember", limit=5)
        assert len(results) == 1
        assert results[0].input == "remember this"
        db.close()

    def test_works_without_db(self):
        from agentos.memory.episodic import EpisodicMemory, Episode
        mem = EpisodicMemory()
        mem.store(Episode(input="a", output="b"))
        assert mem.count() == 1


class TestProceduralPersistence:
    def test_store_persists_to_db(self, tmp_path):
        from agentos.core.database import create_database
        from agentos.memory.procedural import ProceduralMemory, Procedure

        db = create_database(tmp_path / "test.db")
        mem = ProceduralMemory(db=db)

        proc = Procedure(name="search-and-summarize", steps=[{"tool": "web-search"}, {"tool": "summarize"}])
        mem.store(proc)

        # Check DB
        row = db.conn.execute("SELECT * FROM procedures WHERE name = ?", ("search-and-summarize",)).fetchone()
        assert row is not None
        db.close()

    def test_loads_from_db_on_init(self, tmp_path):
        from agentos.core.database import create_database
        from agentos.memory.procedural import ProceduralMemory, Procedure

        db = create_database(tmp_path / "test.db")

        mem1 = ProceduralMemory(db=db)
        mem1.store(Procedure(name="my-proc", steps=[{"tool": "bash"}], description="run commands"))

        mem2 = ProceduralMemory(db=db)
        assert len(mem2.list_all()) == 1
        assert mem2.get("my-proc") is not None
        db.close()


class TestBillingRecords:
    def test_record_and_summary(self, tmp_path):
        from agentos.core.database import create_database

        db = create_database(tmp_path / "test.db")
        db.record_billing(
            cost_type="inference", total_cost_usd=0.01,
            model="claude-sonnet", input_tokens=100, output_tokens=50,
            inference_cost_usd=0.01, session_id="s1",
        )
        db.record_billing(
            cost_type="inference", total_cost_usd=0.02,
            model="gpt-5.4", input_tokens=200, output_tokens=100,
            inference_cost_usd=0.02, session_id="s2",
        )

        summary = db.billing_summary()
        assert summary["total_cost_usd"] == pytest.approx(0.03)
        assert summary["total_records"] == 2
        assert "claude-sonnet" in summary["by_model"]
        assert "gpt-5.4" in summary["by_model"]
        db.close()


class TestGpuEndpoints:
    def test_register_and_stop(self, tmp_path):
        from agentos.core.database import create_database
        import time

        db = create_database(tmp_path / "test.db")
        db.register_gpu_endpoint(
            endpoint_id="gpu-1", model_id="llama-70b",
            api_base="https://gpu-1.example.com/v1",
            gpu_type="h200", hourly_rate_usd=3.98,
        )

        ep = db.get_gpu_endpoint("gpu-1")
        assert ep is not None
        assert ep["status"] == "running"

        time.sleep(0.1)
        result = db.stop_gpu_endpoint("gpu-1")
        assert result["hours"] > 0
        assert result["cost_usd"] > 0

        ep = db.get_gpu_endpoint("gpu-1")
        assert ep["status"] == "stopped"
        db.close()


class TestTraceChain:
    def test_trace_query_and_rollup(self, tmp_path):
        from agentos.core.database import create_database
        import time

        db = create_database(tmp_path / "test.db")

        # Insert two sessions with same trace_id
        for i, (name, depth, cost) in enumerate([("boss", 0, 0.05), ("worker", 1, 0.01)]):
            db.insert_session({
                "session_id": f"s{i}",
                "agent_name": name,
                "composition": {"agent_id": "", "agent_name": name, "agent_version": "0.1.0", "model": "test"},
                "status": "success", "stop_reason": "completed", "is_finished": True,
                "step_count": 1, "action_count": 0,
                "cost": {"total_usd": cost, "llm_input_cost_usd": 0, "llm_output_cost_usd": 0, "tool_cost_usd": 0},
                "benchmark_cost": {"total_usd": 0, "llm_input_cost_usd": 0, "llm_output_cost_usd": 0, "tool_cost_usd": 0},
                "trace_id": "trace-abc", "parent_session_id": "" if i == 0 else "s0", "depth": depth,
                "timestamp": time.time(), "ended_at": time.time(),
            })

        trace = db.query_trace("trace-abc")
        assert len(trace) == 2

        rollup = db.trace_cost_rollup("trace-abc")
        assert rollup["total_sessions"] == 2
        assert rollup["total_cost_usd"] == pytest.approx(0.06)
        assert rollup["max_depth"] == 1
        db.close()
