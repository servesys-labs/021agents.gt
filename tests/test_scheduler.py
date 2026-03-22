"""Tests for the cron scheduler."""

import pytest
from pathlib import Path


class TestCronParsing:
    def test_parse_valid(self):
        from agentos.scheduler import parse_cron
        result = parse_cron("0 9 * * *")
        assert result["minute"] == "0"
        assert result["hour"] == "9"

    def test_parse_shortcuts(self):
        from agentos.scheduler import parse_cron
        result = parse_cron("@daily")
        assert result["minute"] == "0"
        assert result["hour"] == "9"

    def test_parse_invalid(self):
        from agentos.scheduler import parse_cron
        with pytest.raises(ValueError):
            parse_cron("bad")

    def test_parse_every_5m(self):
        from agentos.scheduler import parse_cron
        result = parse_cron("@every-5m")
        assert result["minute"] == "*/5"


class TestCronMatching:
    def test_star_always_matches(self):
        from agentos.scheduler import cron_matches_now
        # * * * * * should always match
        assert cron_matches_now("* * * * *") is True


class TestSchedulePersistence:
    def test_save_and_load(self, tmp_path, monkeypatch):
        from agentos.scheduler import Schedule, save_schedules, load_schedules
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        s = Schedule(agent_name="bot", task="do stuff", cron="@daily")
        save_schedules([s])

        loaded = load_schedules()
        assert len(loaded) == 1
        assert loaded[0].agent_name == "bot"
        assert loaded[0].cron == "@daily"

    def test_load_empty(self, tmp_path, monkeypatch):
        from agentos.scheduler import load_schedules
        monkeypatch.chdir(tmp_path)
        assert load_schedules() == []


class TestScheduleToDict:
    def test_roundtrip(self):
        from agentos.scheduler import Schedule
        s = Schedule(agent_name="x", task="y", cron="0 * * * *")
        d = s.to_dict()
        s2 = Schedule.from_dict(d)
        assert s2.agent_name == "x"
        assert s2.cron == "0 * * * *"
