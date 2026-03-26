"""Integration tests — verify all systems are wired together, not isolated.

These tests check that:
1. Evolution loop reads feedback from DB
2. Every code path leaves a trace in the database
"""

import json
import pytest
from pathlib import Path
from unittest.mock import patch

from agentos.agent import Agent, AgentConfig, save_agent_config


class TestFeedbackIntegration:
    """Feedback should flow into the evolution analyzer."""

    def test_analyzer_reads_feedback(self, tmp_path, monkeypatch):
        from agentos.core.database import create_database
        from agentos.evolution.analyzer import AnalysisReport, FailureAnalyzer

        db = create_database(tmp_path / "test.db")

        # Insert session + feedback
        db.insert_session({
            "session_id": "sess-fb1",
            "composition": {"agent_name": "bot"},
            "cost": {}, "benchmark_cost": {},
        })
        db.insert_feedback(session_id="sess-fb1", rating=-1, comment="Wrong answer")
        db.insert_feedback(session_id="sess-fb1", rating=-1, comment="Still wrong")
        db.insert_feedback(session_id="sess-fb1", rating=1, comment="Good")

        # Analyzer should incorporate feedback
        analyzer = FailureAnalyzer()
        report = AnalysisReport(total_sessions=3, success_rate=0.33)
        feedback = db.feedback_summary()
        analyzer.incorporate_feedback(report, feedback)

        # Should have a feedback recommendation
        assert any("feedback" in r.lower() for r in report.recommendations)
        db.close()


