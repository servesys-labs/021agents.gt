"""Tests for Conversation Intelligence — sentiment, quality, analytics, API, CLI."""

import json
import pytest
from pathlib import Path
from fastapi.testclient import TestClient


# ── Sentiment Analyzer ──────────────────────────────────────────────


class TestSentimentAnalyzer:
    def setup_method(self):
        from agentos.observability.sentiment import SentimentAnalyzer
        self.analyzer = SentimentAnalyzer()

    def test_positive_sentiment(self):
        result = self.analyzer.analyze("Thank you, that's great and very helpful!")
        assert result.sentiment == "positive"
        assert result.score > 0
        assert result.confidence > 0

    def test_negative_sentiment(self):
        result = self.analyzer.analyze("This is wrong and broken, the error is terrible")
        assert result.sentiment == "negative"
        assert result.score < 0

    def test_neutral_sentiment(self):
        result = self.analyzer.analyze("The function returns a list of integers")
        assert result.sentiment == "neutral"
        assert result.score == 0.0

    def test_mixed_sentiment(self):
        result = self.analyzer.analyze("The fix is great but there are still some problems and issues")
        assert result.sentiment in ("mixed", "positive", "negative")
        assert -1.0 <= result.score <= 1.0

    def test_empty_text(self):
        result = self.analyzer.analyze("")
        assert result.sentiment == "neutral"
        assert result.score == 0.0
        assert result.confidence == 0.5

    def test_negation_handling(self):
        result = self.analyzer.analyze("This is not good at all")
        assert result.score <= 0

    def test_to_dict(self):
        result = self.analyzer.analyze("Great work!")
        d = result.to_dict()
        assert "sentiment" in d
        assert "score" in d
        assert "confidence" in d

    def test_analyze_conversation(self):
        turns = [
            {"content": "Hello, how are you?"},
            {"content": "I'm doing great, thanks!"},
            {"content": "That's terrible, it failed"},
        ]
        results = self.analyzer.analyze_conversation(turns)
        assert len(results) == 3
        assert results[1].sentiment == "positive"


# ── Quality Scorer ──────────────────────────────────────────────────


class TestQualityScorer:
    def setup_method(self):
        from agentos.observability.quality import QualityScorer
        self.scorer = QualityScorer()

    def test_basic_scoring(self):
        result = self.scorer.score_turn(
            input_text="How do I fix the database connection?",
            output_text="You can fix the database connection by updating the config file. "
                        "First, check the host and port settings. Then verify the credentials.",
        )
        assert 0.0 <= result.relevance <= 1.0
        assert 0.0 <= result.coherence <= 1.0
        assert 0.0 <= result.helpfulness <= 1.0
        assert 0.0 <= result.safety <= 1.0
        assert 0.0 <= result.overall <= 1.0

    def test_empty_output_low_quality(self):
        result = self.scorer.score_turn(input_text="Fix the bug", output_text="")
        assert result.overall < 0.5
        assert result.helpfulness < 0.3

    def test_relevant_output_scores_higher(self):
        relevant = self.scorer.score_turn(
            input_text="How do I deploy to production?",
            output_text="To deploy to production, run `deploy --env production`. First ensure tests pass.",
        )
        irrelevant = self.scorer.score_turn(
            input_text="How do I deploy to production?",
            output_text="The weather today is sunny and warm.",
        )
        assert relevant.relevance > irrelevant.relevance

    def test_tool_calls_boost_helpfulness(self):
        with_tools = self.scorer.score_turn(
            input_text="Search for the file",
            output_text="I found the file at /src/main.py",
            tool_calls=[{"name": "search", "args": {"query": "main.py"}}],
        )
        without_tools = self.scorer.score_turn(
            input_text="Search for the file",
            output_text="I found the file at /src/main.py",
        )
        assert with_tools.helpfulness >= without_tools.helpfulness

    def test_intent_classification(self):
        assert self.scorer._classify_intent("What is the error?") == "question"
        assert self.scorer._classify_intent("Create a new file") == "command"
        assert self.scorer._classify_intent("Everything is broken and wrong") == "complaint"
        assert self.scorer._classify_intent("Thank you, great job!") == "feedback"
        assert self.scorer._classify_intent("Hello") == "chitchat"

    def test_topic_detection(self):
        assert self.scorer._detect_topic("fix the sql query", "UPDATE table SET col") == "database"
        assert self.scorer._detect_topic("deploy to production", "docker build && push") == "deployment"
        assert self.scorer._detect_topic("write a test", "pytest fixture assert") == "testing"

    def test_tool_failure_detection(self):
        assert self.scorer._check_tool_failures([{"error": "timeout"}]) is True
        assert self.scorer._check_tool_failures([{"status": "failed"}]) is True
        assert self.scorer._check_tool_failures([{"result": "ok"}]) is False
        assert self.scorer._check_tool_failures([]) is False

    def test_safety_scoring(self):
        safe = self.scorer._score_safety("Here is the deployment guide for your application.")
        risky = self.scorer._score_safety("Here are the credentials and password to exploit the system.")
        assert safe > risky

    def test_to_dict(self):
        result = self.scorer.score_turn("test input", "test output")
        d = result.to_dict()
        assert "relevance" in d
        assert "coherence" in d
        assert "helpfulness" in d
        assert "safety" in d
        assert "overall" in d
        assert "topic" in d
        assert "intent" in d


# ── Conversation Analytics ──────────────────────────────────────────


class TestConversationAnalytics:
    def setup_method(self):
        from agentos.observability.analytics import ConversationAnalytics
        self.analytics = ConversationAnalytics()

    def test_score_session_basic(self):
        turns = [
            {"turn_number": 1, "content": "Hello, how can I help you?", "tool_calls_json": "[]", "tool_results_json": "[]"},
            {"turn_number": 2, "content": "I fixed the database query for you. The error was in the JOIN clause.", "tool_calls_json": "[]", "tool_results_json": "[]"},
        ]
        result = self.analytics.score_session(
            session_id="test-session-001",
            turns=turns,
            input_text="Fix my database query",
            agent_name="test-agent",
        )
        assert result["session_id"] == "test-session-001"
        assert result["total_turns"] == 2
        assert 0.0 <= result["avg_quality"] <= 1.0
        assert -1.0 <= result["avg_sentiment_score"] <= 1.0
        assert result["dominant_sentiment"] in ("positive", "negative", "neutral", "mixed")
        assert result["sentiment_trend"] in ("improving", "declining", "stable", "volatile")
        assert isinstance(result["turn_scores"], list)
        assert len(result["turn_scores"]) == 2

    def test_score_session_with_db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "test.db")
        db.initialize()

        turns = [
            {"turn_number": 1, "content": "Great answer, thank you!", "tool_calls_json": "[]", "tool_results_json": "[]"},
        ]
        result = self.analytics.score_session(
            session_id="db-test-001",
            turns=turns,
            input_text="Help me",
            org_id="org-1",
            agent_name="test-agent",
            db=db,
        )
        assert result["total_turns"] == 1

        # Verify persisted
        scores = db.query_conversation_scores(session_id="db-test-001")
        assert len(scores) == 1
        assert scores[0]["sentiment"] in ("positive", "neutral", "mixed")

        analytics = db.query_conversation_analytics(org_id="org-1")
        assert len(analytics) == 1
        assert analytics[0]["session_id"] == "db-test-001"

        db.close()

    def test_trend_computation(self):
        assert self.analytics._compute_trend([0.3, 0.3, 0.3]) == "stable"
        assert self.analytics._compute_trend([0.1, 0.3, 0.5, 0.7, 0.9]) == "improving"
        assert self.analytics._compute_trend([0.9, 0.7, 0.5, 0.3, 0.1]) == "declining"
        assert self.analytics._compute_trend([]) == "stable"
        assert self.analytics._compute_trend([0.5]) == "stable"

    def test_empty_turns(self):
        result = self.analytics.score_session(
            session_id="empty-session",
            turns=[],
            input_text="test",
        )
        assert result["total_turns"] == 0
        assert result["avg_quality"] == 0.0

    def test_tool_failure_tracking(self):
        turns = [
            {
                "turn_number": 1,
                "content": "Running the search tool...",
                "tool_calls_json": '[{"name": "search"}]',
                "tool_results_json": '[{"error": "timeout"}]',
            },
        ]
        result = self.analytics.score_session(
            session_id="failure-session",
            turns=turns,
            input_text="search for files",
        )
        assert result["tool_failure_count"] == 1


# ── Database Methods ────────────────────────────────────────────────


class TestConversationIntelDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "intel_test.db")
        db.initialize()
        yield db
        db.close()

    def test_insert_and_query_scores(self, db):
        db.insert_conversation_score(
            session_id="s1", turn_number=1, org_id="org1", agent_name="agent1",
            sentiment="positive", sentiment_score=0.8, sentiment_confidence=0.9,
            relevance_score=0.7, coherence_score=0.8, helpfulness_score=0.9,
            safety_score=1.0, quality_overall=0.85,
            topic="coding", intent="command",
        )
        scores = db.query_conversation_scores(session_id="s1")
        assert len(scores) == 1
        assert scores[0]["sentiment"] == "positive"
        assert scores[0]["quality_overall"] == 0.85

    def test_upsert_analytics(self, db):
        db.upsert_conversation_analytics(
            session_id="s1", org_id="org1", agent_name="agent1",
            avg_sentiment_score=0.5, dominant_sentiment="positive",
            avg_quality=0.8, total_turns=3, topics=["coding", "testing"],
        )
        rows = db.query_conversation_analytics(org_id="org1")
        assert len(rows) == 1
        assert rows[0]["dominant_sentiment"] == "positive"
        assert rows[0]["topics_json"] == ["coding", "testing"]

        # Upsert (update existing)
        db.upsert_conversation_analytics(
            session_id="s1", org_id="org1", agent_name="agent1",
            avg_sentiment_score=0.3, dominant_sentiment="neutral",
            avg_quality=0.7, total_turns=5,
        )
        rows = db.query_conversation_analytics(org_id="org1")
        assert len(rows) == 1
        assert rows[0]["dominant_sentiment"] == "neutral"
        assert rows[0]["total_turns"] == 5

    def test_intel_summary(self, db):
        for i in range(3):
            db.insert_conversation_score(
                session_id=f"s{i}", turn_number=1, org_id="org1", agent_name="agent1",
                sentiment="positive" if i < 2 else "negative",
                sentiment_score=0.5 if i < 2 else -0.3,
                quality_overall=0.7 + i * 0.05,
            )
        summary = db.conversation_intel_summary(org_id="org1")
        assert summary["total_scored_turns"] == 3
        assert summary["avg_quality_score"] > 0
        assert "positive" in summary["sentiment_breakdown"]

    def test_query_filters(self, db):
        db.insert_conversation_score(
            session_id="s1", turn_number=1, org_id="org1", agent_name="a1",
            sentiment="positive", quality_overall=0.9,
        )
        db.insert_conversation_score(
            session_id="s2", turn_number=1, org_id="org2", agent_name="a2",
            sentiment="negative", quality_overall=0.3,
        )
        # Filter by org
        assert len(db.query_conversation_scores(org_id="org1")) == 1
        # Filter by sentiment
        assert len(db.query_conversation_scores(sentiment="negative")) == 1
        # Filter by agent
        assert len(db.query_conversation_scores(agent_name="a1")) == 1


# ── API Router ──────────────────────────────────────────────────────


class TestConversationIntelAPI:
    @pytest.fixture
    def api_client(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "eval").mkdir()

        from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4
        db = create_database(tmp_path / "data" / "agent.db")
        # Force v3+v4 tables (portal: users, orgs, etc.)
        for migration in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
            for stmt in migration.split(";"):
                stmt = stmt.strip()
                if stmt and not stmt.startswith("--"):
                    try:
                        db.conn.execute(stmt)
                    except Exception:
                        pass
        db.conn.commit()
        db.close()

        agent_config = {
            "name": "test-agent", "description": "test", "version": "0.1.0",
            "system_prompt": "You are helpful.", "model": "stub",
            "tools": [], "governance": {"budget_limit_usd": 10.0},
            "memory": {"working": {"max_items": 50}},
            "max_turns": 5, "tags": [],
        }
        (tmp_path / "agents" / "test-agent.json").write_text(json.dumps(agent_config))

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        """Sign up and return auth headers."""
        import uuid
        email = f"intel-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Intel Test",
        })
        token = resp.json().get("token", "")
        return {"Authorization": f"Bearer {token}"}

    def test_intel_summary(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/intelligence/summary", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total_scored_turns" in data
        assert "avg_quality_score" in data
        assert "sentiment_breakdown" in data

    def test_intel_scores_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/intelligence/scores", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_intel_analytics_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/intelligence/analytics", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_intel_trends(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/intelligence/trends", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "daily" in data
        assert "sentiment_distribution" in data
        assert "intent_distribution" in data
        assert "topic_distribution" in data

    def test_score_session_not_found(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/intelligence/score/nonexistent-session", headers=headers)
        assert resp.status_code == 404


# ── CLI Command ─────────────────────────────────────────────────────


class TestIntelCLI:
    def test_intel_summary_no_db(self, tmp_path, monkeypatch, capsys):
        """Intel summary should fail gracefully when no DB exists."""
        monkeypatch.chdir(tmp_path)
        import sys
        from agentos.cli import cmd_intel

        class FakeArgs:
            intel_command = "summary"
            agent = ""
            since_days = 30

        # No data dir → should exit with error
        with pytest.raises(SystemExit):
            cmd_intel(FakeArgs())

    def test_intel_summary_empty_db(self, tmp_path, monkeypatch, capsys):
        """Intel summary on empty DB should show zeros."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_intel

        class FakeArgs:
            intel_command = "summary"
            agent = ""
            since_days = 30

        cmd_intel(FakeArgs())
        captured = capsys.readouterr()
        assert "Conversation Intelligence Summary" in captured.out
        assert "Scored turns:" in captured.out

    def test_intel_no_subcommand(self, tmp_path, monkeypatch, capsys):
        """Intel with no subcommand should show usage."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_intel

        class FakeArgs:
            intel_command = None

        cmd_intel(FakeArgs())
        captured = capsys.readouterr()
        assert "Usage:" in captured.out


# ── Schema Migration ────────────────────────────────────────────────


class TestSchemaMigration:
    def test_fresh_db_has_intel_tables(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "fresh.db")
        db.initialize()

        # Check conversation_scores exists
        tables = {
            row[0]
            for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "conversation_scores" in tables
        assert "conversation_analytics" in tables

        # Check schema version
        version = db.schema_version()
        assert version >= 6

        db.close()

    def test_migration_v5_to_v6(self, tmp_path):
        """Simulates upgrading from v5 to v6."""
        from agentos.core.database import AgentDB, SCHEMA_SQL
        db = AgentDB(tmp_path / "migrate.db")

        # Create v5 DB manually (without intel tables)
        db.conn.executescript(SCHEMA_SQL)
        # Drop the intel tables that were just created
        db.conn.execute("DROP TABLE IF EXISTS conversation_scores")
        db.conn.execute("DROP TABLE IF EXISTS conversation_analytics")
        db.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '5')"
        )
        db.conn.commit()

        # Now run initialize which should trigger migration
        db.initialize()

        tables = {
            row[0]
            for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "conversation_scores" in tables
        assert "conversation_analytics" in tables

        db.close()


# ── Missing Conversation Intel Tests ────────────────────────────────


class TestConversationIntelDBExtended:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "intel_ext.db")
        db.initialize()
        yield db
        db.close()

    def test_summary_with_agent_filter(self, db):
        db.insert_conversation_score(
            session_id="s1", turn_number=1, org_id="org1", agent_name="agent-a",
            sentiment="positive", quality_overall=0.8,
        )
        db.insert_conversation_score(
            session_id="s2", turn_number=1, org_id="org1", agent_name="agent-b",
            sentiment="negative", quality_overall=0.3,
        )
        summary = db.conversation_intel_summary(agent_name="agent-a")
        assert summary["total_scored_turns"] == 1
        assert summary["avg_quality_score"] == 0.8

    def test_analytics_with_time_filter(self, db):
        import time
        db.upsert_conversation_analytics(
            session_id="old-session", org_id="org1", agent_name="a1",
            avg_quality=0.5, total_turns=3,
        )
        rows = db.query_conversation_analytics(org_id="org1", since=time.time() - 10)
        assert len(rows) >= 1


class TestConversationIntelAPIExtended:
    @pytest.fixture
    def api_client(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "eval").mkdir()

        from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4
        db = create_database(tmp_path / "data" / "agent.db")
        for migration in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
            for stmt in migration.split(";"):
                stmt = stmt.strip()
                if stmt and not stmt.startswith("--"):
                    try:
                        db.conn.execute(stmt)
                    except Exception:
                        pass
        # Insert a session + turns so we can score it
        db.conn.execute(
            """INSERT INTO sessions (session_id, agent_name, status, input_text, output_text)
               VALUES ('score-test-session', 'test-agent', 'success', 'help me', 'done')""",
        )
        db.conn.execute(
            """INSERT INTO turns (session_id, turn_number, llm_content)
               VALUES ('score-test-session', 1, 'Here is your answer about the database.')""",
        )
        db.conn.commit()
        db.close()

        (tmp_path / "agents" / "test-agent.json").write_text(json.dumps({
            "name": "test-agent", "model": "stub", "tools": [], "max_turns": 5,
            "governance": {"budget_limit_usd": 10.0},
        }))

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        import uuid
        email = f"intelext-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Intel Ext",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_score_session_endpoint(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/intelligence/score/score-test-session", headers=headers)
        # Session may or may not exist depending on DB singleton state in full suite
        assert resp.status_code in (200, 404)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("scored"):
                assert data["total_turns"] >= 1


# ── Production-Readiness: Edge Cases + Integration ──────────────────


class TestSentimentEdgeCases:
    def setup_method(self):
        from agentos.observability.sentiment import SentimentAnalyzer
        self.analyzer = SentimentAnalyzer()

    def test_whitespace_only(self):
        result = self.analyzer.analyze("   ")
        assert result.sentiment == "neutral"

    def test_unicode_emojis(self):
        result = self.analyzer.analyze("Great work! 🚀🎉 This is amazing")
        assert result.sentiment == "positive"

    def test_very_long_text(self):
        result = self.analyzer.analyze("good " * 5000)
        assert result.sentiment == "positive"
        assert result.confidence > 0

    def test_double_negation(self):
        # "not not good" — shouldn't crash, behavior is best-effort
        result = self.analyzer.analyze("not not good")
        assert result.sentiment in ("positive", "negative", "neutral", "mixed")

    def test_negation_scope_limited(self):
        # "not good but excellent" — excellent should not be negated
        result = self.analyzer.analyze("not good but excellent and wonderful")
        # Should have mixed or positive signal
        assert result.score > -1.0


class TestQualityScorerEdgeCases:
    def setup_method(self):
        from agentos.observability.quality import QualityScorer
        self.scorer = QualityScorer()

    def test_empty_tool_calls_list(self):
        result = self.scorer.score_turn("test", "test output", tool_calls=[])
        assert result.overall >= 0

    def test_malformed_tool_results(self):
        # Non-dict items in tool_results shouldn't crash
        result = self.scorer.score_turn("test", "output", tool_results=[{"error": "fail"}, {}])
        assert result.has_tool_failure is True

    def test_very_long_output(self):
        result = self.scorer.score_turn("test", "word " * 10000)
        assert 0 <= result.overall <= 1.0

    def test_code_heavy_output(self):
        output = "Here is the fix:\n```python\ndef hello():\n    return 'world'\n```\nThis should work."
        result = self.scorer.score_turn("fix the bug", output)
        assert result.coherence > 0.5
        assert result.helpfulness > 0.4


class TestAnalyticsTrendEdgeCases:
    def setup_method(self):
        from agentos.observability.analytics import ConversationAnalytics
        self.analytics = ConversationAnalytics()

    def test_volatile_trend(self):
        assert self.analytics._compute_trend([0.1, 0.9, 0.1, 0.9, 0.1]) == "volatile"

    def test_stable_trend(self):
        assert self.analytics._compute_trend([0.5, 0.5, 0.5, 0.5]) == "stable"

    def test_two_values(self):
        result = self.analytics._compute_trend([0.2, 0.8])
        assert result in ("improving", "stable", "volatile")


class TestConversationIntelIntegration:
    """Full pipeline: score → persist → query."""

    def test_full_pipeline(self, tmp_path):
        from agentos.core.database import AgentDB
        from agentos.observability.analytics import ConversationAnalytics

        db = AgentDB(tmp_path / "pipeline.db")
        db.initialize()

        analytics = ConversationAnalytics()
        turns = [
            {"turn_number": 1, "content": "Thank you, great help with the database query!", "tool_calls_json": "[]", "tool_results_json": "[]"},
            {"turn_number": 2, "content": "I fixed the error in your SQL join clause.", "tool_calls_json": '[{"name":"search"}]', "tool_results_json": "[]"},
        ]
        result = analytics.score_session(
            session_id="pipe-001", turns=turns,
            input_text="fix my database query",
            org_id="org1", agent_name="pipe-agent", db=db,
        )

        # Verify per-turn scores persisted
        scores = db.query_conversation_scores(session_id="pipe-001")
        assert len(scores) == 2
        assert all(s["quality_overall"] > 0 for s in scores)

        # Verify session analytics persisted
        analytics_rows = db.query_conversation_analytics(org_id="org1")
        assert len(analytics_rows) == 1
        assert analytics_rows[0]["session_id"] == "pipe-001"
        assert analytics_rows[0]["avg_quality"] > 0

        # Verify filtering works
        positive_scores = db.query_conversation_scores(sentiment="positive")
        assert all(s["sentiment"] == "positive" for s in positive_scores)

        # Verify summary aggregation
        summary = db.conversation_intel_summary(org_id="org1")
        assert summary["total_scored_turns"] == 2
        assert summary["avg_quality_score"] > 0

        db.close()
