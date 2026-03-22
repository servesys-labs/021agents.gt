"""Agent Scheduler — run agents on cron schedules.

Manages scheduled agent runs with persistence to data/schedules.json.
Uses a lightweight internal loop (no external cron dependency).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Schedule:
    """A scheduled agent run."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    agent_name: str = ""
    task: str = ""
    cron: str = ""  # cron expression: "0 9 * * *" = every day at 9am
    enabled: bool = True
    last_run: float = 0.0
    next_run: float = 0.0
    run_count: int = 0
    last_status: str = ""
    last_output: str = ""
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "agent_name": self.agent_name,
            "task": self.task,
            "cron": self.cron,
            "enabled": self.enabled,
            "last_run": self.last_run,
            "next_run": self.next_run,
            "run_count": self.run_count,
            "last_status": self.last_status,
            "last_output": self.last_output[:200],
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Schedule:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


def _schedules_path() -> Path:
    return Path.cwd() / "data" / "schedules.json"


def load_schedules() -> list[Schedule]:
    p = _schedules_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text())
        return [Schedule.from_dict(s) for s in data]
    except Exception:
        return []


def save_schedules(schedules: list[Schedule]) -> None:
    p = _schedules_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps([s.to_dict() for s in schedules], indent=2) + "\n")


def parse_cron(expr: str) -> dict[str, Any]:
    """Parse a simple cron expression into components.

    Supports: minute hour day_of_month month day_of_week
    Also supports shortcuts: @hourly, @daily, @weekly
    """
    shortcuts = {
        "@hourly": "0 * * * *",
        "@daily": "0 9 * * *",
        "@weekly": "0 9 * * 1",
        "@every-5m": "*/5 * * * *",
        "@every-15m": "*/15 * * * *",
        "@every-30m": "*/30 * * * *",
    }
    expr = shortcuts.get(expr, expr)
    parts = expr.split()
    if len(parts) != 5:
        raise ValueError(f"Invalid cron expression: {expr} (need 5 fields: min hour dom month dow)")
    return {"minute": parts[0], "hour": parts[1], "dom": parts[2], "month": parts[3], "dow": parts[4]}


def cron_matches_now(expr: str) -> bool:
    """Check if a cron expression matches the current time."""
    try:
        parsed = parse_cron(expr)
    except ValueError:
        return False

    now = datetime.now()

    def _matches(field_val: str, current: int, max_val: int) -> bool:
        if field_val == "*":
            return True
        if "/" in field_val:
            base, step = field_val.split("/")
            base = 0 if base == "*" else int(base)
            return (current - base) % int(step) == 0
        if "," in field_val:
            return current in [int(v) for v in field_val.split(",")]
        if "-" in field_val:
            lo, hi = field_val.split("-")
            return int(lo) <= current <= int(hi)
        return current == int(field_val)

    return (
        _matches(parsed["minute"], now.minute, 59)
        and _matches(parsed["hour"], now.hour, 23)
        and _matches(parsed["dom"], now.day, 31)
        and _matches(parsed["month"], now.month, 12)
        and _matches(parsed["dow"], now.weekday(), 6)  # 0=Monday
    )


async def run_schedule(schedule: Schedule) -> str:
    """Execute a scheduled agent run."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(schedule.agent_name)
        results = await agent.run(schedule.task)

        output = ""
        for r in results:
            if r.llm_response and r.llm_response.content:
                output = r.llm_response.content

        schedule.last_run = time.time()
        schedule.run_count += 1
        schedule.last_status = "success"
        schedule.last_output = output[:500]
        return output

    except Exception as exc:
        schedule.last_run = time.time()
        schedule.run_count += 1
        schedule.last_status = f"error: {exc}"
        schedule.last_output = str(exc)[:500]
        return f"Error: {exc}"


async def scheduler_loop(check_interval: int = 60) -> None:
    """Main scheduler loop — checks every minute for due schedules."""
    logger.info("Scheduler started (checking every %ds)", check_interval)
    last_check_minute = -1

    while True:
        now = datetime.now()
        current_minute = now.hour * 60 + now.minute

        # Only check once per minute
        if current_minute != last_check_minute:
            last_check_minute = current_minute
            schedules = load_schedules()

            for schedule in schedules:
                if not schedule.enabled:
                    continue
                if cron_matches_now(schedule.cron):
                    logger.info("Running scheduled task: %s → %s", schedule.agent_name, schedule.task[:50])
                    try:
                        await run_schedule(schedule)
                    except Exception as exc:
                        logger.error("Scheduled run failed: %s", exc)

            save_schedules(schedules)

        await asyncio.sleep(check_interval)
