"""Observer — the outer-loop agent that watches every inner-agent session.

The Observer hooks into the EventBus and builds structured SessionRecords.
It accumulates records over time and feeds them to the Analyzer for
pattern detection and improvement proposals.

Think of it as an agent sitting beside the main agent, taking notes on
everything that happens — then periodically reviewing those notes to
suggest improvements that a human can approve.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from agentos.core.events import Event, EventBus, EventType
from agentos.evolution.session_record import (
    CostBreakdown,
    ErrorRecord,
    ErrorSource,
    EvalConditions,
    SessionRecord,
    StopReason,
    SystemComposition,
    TurnRecord,
)

logger = logging.getLogger(__name__)


class Observer:
    """Watches agent sessions via EventBus, builds SessionRecords.

    Usage:
        observer = Observer(event_bus=harness.event_bus)
        observer.attach(agent_name="my-agent", agent_config=config.to_dict())

        # ... agent runs happen, observer captures everything ...

        records = observer.records  # All captured sessions
        observer.export("sessions.jsonl")  # Export for dashboards

    With SQLite (preferred):
        from agentos.core.database import AgentDB
        db = AgentDB("data/agent.db")
        observer = Observer(event_bus=bus, db=db)
        # Sessions auto-persist to SQLite with indexes, atomicity, etc.
    """

    def __init__(
        self,
        event_bus: EventBus | None = None,
        storage_path: Path | None = None,
        db: Any | None = None,
    ) -> None:
        self.event_bus = event_bus or EventBus()
        self.storage_path = storage_path
        self._db = db  # AgentDB instance (optional, preferred over JSONL)
        self._records: list[SessionRecord] = []
        self._sessions: dict[str, SessionRecord] = {}
        self._session_start_times: dict[str, float] = {}
        self._first_action_times: dict[str, float | None] = {}
        self._current_session_id: str | None = None
        self._attached = False

    @property
    def records(self) -> list[SessionRecord]:
        return list(self._records)

    def attach(
        self,
        agent_name: str = "",
        agent_config: dict[str, Any] | None = None,
    ) -> None:
        """Attach to the event bus and start observing."""
        if self._attached:
            return

        self._agent_name = agent_name
        self._agent_config = agent_config or {}

        # Subscribe to all events
        self.event_bus.on(EventType.SESSION_START, self._on_session_start)
        self.event_bus.on(EventType.SESSION_END, self._on_session_end)
        self.event_bus.on(EventType.TURN_START, self._on_turn_start)
        self.event_bus.on(EventType.TURN_END, self._on_turn_end)
        self.event_bus.on(EventType.LLM_REQUEST, self._on_llm_request)
        self.event_bus.on(EventType.LLM_RESPONSE, self._on_llm_response)
        self.event_bus.on(EventType.TOOL_CALL, self._on_tool_call)
        self.event_bus.on(EventType.TOOL_RESULT, self._on_tool_result)
        self.event_bus.on(EventType.ERROR, self._on_error)

        self._attached = True
        logger.info("Observer attached for agent '%s'", agent_name)

    def detach(self) -> None:
        """Stop observing (event bus listeners remain but flag prevents processing)."""
        self._attached = False

    async def _on_session_start(self, event: Event) -> None:
        """Begin tracking a new session."""
        if not self._attached:
            return
        session_id = event.data.get("session_id") or uuid.uuid4().hex[:16]
        self._current_session_id = session_id
        self._session_start_times[session_id] = time.time()
        self._first_action_times[session_id] = None

        config = self._agent_config
        system_prompt = config.get("system_prompt", "")
        prompt_hash = hashlib.sha256(system_prompt.encode()).hexdigest()[:12]

        self._sessions[session_id] = SessionRecord(
            session_id=session_id,
            agent_name=self._agent_name,
            input_text=event.data.get("input", ""),
            trace_id=event.data.get("trace_id", ""),
            parent_session_id=event.data.get("parent_session_id", ""),
            depth=event.data.get("depth", 0),
            composition=SystemComposition(
                agent_id=config.get("agent_id", ""),
                agent_name=self._agent_name,
                agent_version=config.get("version", "0.0.0"),
                model=config.get("model", "unknown"),
                tools_available=_extract_tool_names(config.get("tools", [])),
                memory_config=config.get("memory", {}),
                system_prompt_hash=prompt_hash,
                governance_config=config.get("governance", {}),
            ),
        )

    async def _on_session_end(self, event: Event) -> None:
        """Finalize and store the session record."""
        if not self._attached:
            return
        sid = self._current_session_id
        if not sid or sid not in self._sessions:
            return

        rec = self._sessions[sid]
        start_time = self._session_start_times.get(sid, time.time())
        rec.wall_clock_seconds = time.time() - start_time
        rec.step_count = len(rec.turns)
        rec.is_finished = True

        # Determine stop reason from session state
        if rec.errors and any(e.source == ErrorSource.TIMEOUT for e in rec.errors):
            rec.stop_reason = StopReason.TIMEOUT
            rec.status = "timeout"
        elif rec.errors and not any(e.recoverable for e in rec.errors):
            rec.stop_reason = StopReason.LLM_ERROR
            rec.status = "error"
            rec.error_attribution = rec.errors[-1].source
        else:
            rec.stop_reason = StopReason.COMPLETED
            rec.status = "success"

        # Extract output from last turn
        if rec.turns:
            last = rec.turns[-1]
            rec.output_text = last.llm_content

        # Aggregate costs
        total_cost = CostBreakdown()
        for turn in rec.turns:
            total_cost.llm_input_cost_usd += turn.cost.llm_input_cost_usd
            total_cost.llm_output_cost_usd += turn.cost.llm_output_cost_usd
            total_cost.tool_cost_usd += turn.cost.tool_cost_usd
            total_cost.total_usd += turn.cost.total_usd
        rec.cost = total_cost

        # Count total actions
        rec.action_count = sum(len(t.tool_calls) for t in rec.turns)

        # Time to first action
        first_action = self._first_action_times.get(sid)
        if first_action:
            rec.time_to_first_action_ms = (
                first_action - start_time
            ) * 1000

        self._records.append(rec)

        # Auto-persist: prefer SQLite, fall back to JSONL
        if self._db is not None:
            self._persist_to_db(rec)
            self._persist_turns_to_db(rec)
        elif self.storage_path:
            self._append_to_storage(rec)

        logger.info(
            "Session %s recorded: status=%s, turns=%d, cost=$%.4f",
            rec.session_id,
            rec.status,
            rec.step_count,
            rec.cost.total_usd,
        )
        # Clean up session-specific state
        self._sessions.pop(sid, None)
        self._session_start_times.pop(sid, None)
        self._first_action_times.pop(sid, None)
        self._current_session_id = None

    async def _on_turn_start(self, event: Event) -> None:
        if not self._attached:
            return
        rec = self._sessions.get(self._current_session_id or "")
        if not rec:
            return
        turn_num = event.data.get("turn", len(rec.turns) + 1)
        rec.turns.append(TurnRecord(
            turn_number=turn_num,
        ))

    async def _on_turn_end(self, event: Event) -> None:
        if not self._attached:
            return
        rec = self._sessions.get(self._current_session_id or "")
        if rec and rec.turns:
            turn = rec.turns[-1]
            turn.ended_at = time.time()
            turn.execution_mode = event.data.get("execution_mode", "sequential")
            turn.plan_artifact = event.data.get("plan_artifact", {}) or {}
            turn.reflection = event.data.get("reflection", {}) or {}

    async def _on_llm_request(self, event: Event) -> None:
        if not self._attached:
            return
        rec = self._sessions.get(self._current_session_id or "")
        if not rec or not rec.turns:
            return
        rec.turns[-1].latency_ms = time.time() * 1000  # Will compute delta on response

    async def _on_llm_response(self, event: Event) -> None:
        if not self._attached:
            return
        rec = self._sessions.get(self._current_session_id or "")
        if not rec or not rec.turns:
            return
        turn = rec.turns[-1]
        if turn.latency_ms > 0:
            turn.latency_ms = (time.time() * 1000) - turn.latency_ms
        turn.model_used = event.data.get("model", "")
        turn.input_tokens = event.data.get("input_tokens", 0)
        turn.output_tokens = event.data.get("output_tokens", 0)
        turn.llm_content = event.data.get("content", "")
        # Populate cost breakdown from the LLM response event
        cost_usd = event.data.get("cost_usd", 0.0)
        if cost_usd:
            turn.cost.total_usd = cost_usd
            # Compute per-component breakdown from token counts
            if turn.input_tokens or turn.output_tokens:
                try:
                    from agentos.llm.tokens import estimate_cost
                    model = turn.model_used or self._agent_config.get("model", "")
                    total_est = estimate_cost(turn.input_tokens, turn.output_tokens, model)
                    if total_est > 0:
                        input_ratio = (turn.input_tokens * 3.0) / (turn.input_tokens * 3.0 + turn.output_tokens * 15.0) if (turn.input_tokens + turn.output_tokens) > 0 else 0.5
                        turn.cost.llm_input_cost_usd = cost_usd * input_ratio
                        turn.cost.llm_output_cost_usd = cost_usd * (1 - input_ratio)
                except Exception:
                    pass

    async def _on_tool_call(self, event: Event) -> None:
        if not self._attached:
            return
        sid = self._current_session_id or ""
        rec = self._sessions.get(sid)
        if not rec or not rec.turns:
            return
        if self._first_action_times.get(sid) is None:
            self._first_action_times[sid] = time.time()
        rec.turns[-1].tool_calls.append(event.data)

    async def _on_tool_result(self, event: Event) -> None:
        if not self._attached:
            return
        rec = self._sessions.get(self._current_session_id or "")
        if not rec or not rec.turns:
            return
        turn = rec.turns[-1]
        turn.tool_results.append(event.data)
        if "error" in event.data:
            turn.errors.append(ErrorRecord(
                source=ErrorSource.TOOL,
                message=event.data.get("error", ""),
                tool_name=event.data.get("tool", ""),
                turn=turn.turn_number,
            ))
            rec.errors.append(turn.errors[-1])

    async def _on_error(self, event: Event) -> None:
        if not self._attached:
            return
        rec = self._sessions.get(self._current_session_id or "")
        if not rec:
            return
        try:
            source = ErrorSource(event.data.get("source", "unknown"))
        except ValueError:
            source = ErrorSource.UNKNOWN
        err = ErrorRecord(
            source=source,
            message=event.data.get("message", str(event.data)),
            turn=len(rec.turns),
        )
        rec.errors.append(err)

    def _append_to_storage(self, record: SessionRecord) -> None:
        """Append a record to JSONL storage."""
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.storage_path, "a") as f:
            f.write(json.dumps(record.to_dict()) + "\n")

    def _persist_turns_to_db(self, record: SessionRecord) -> None:
        """Persist turn-level detail to the turns table."""
        if not record.turns:
            return
        try:
            turns_data = []
            for turn in record.turns:
                turn_dict = {
                    "turn_number": turn.turn_number,
                    "model_used": turn.model_used,
                    "input_tokens": turn.input_tokens,
                    "output_tokens": turn.output_tokens,
                    "latency_ms": turn.latency_ms,
                    "llm_content": turn.llm_content,
                    "cost": {
                        "llm_input_cost_usd": turn.cost.llm_input_cost_usd,
                        "llm_output_cost_usd": turn.cost.llm_output_cost_usd,
                        "tool_cost_usd": turn.cost.tool_cost_usd,
                        "total_usd": turn.cost.total_usd,
                    },
                    "started_at": turn.started_at,
                    "ended_at": turn.ended_at or time.time(),
                    "tool_calls": turn.tool_calls,
                    "tool_results": turn.tool_results,
                    "execution_mode": turn.execution_mode,
                    "plan_artifact": turn.plan_artifact,
                    "reflection": turn.reflection,
                    "errors": [
                        {"source": e.source.value, "message": e.message}
                        for e in turn.errors
                    ],
                }
                turns_data.append(turn_dict)
            self._db.insert_turns(record.session_id, turns_data)
        except Exception as exc:
            logger.error("Failed to persist turns to SQLite: %s", exc)

    def _persist_to_db(self, record: SessionRecord) -> None:
        """Persist a session record to SQLite (atomic, indexed)."""
        try:
            data = record.to_dict()
            data["ended_at"] = time.time()  # Session end timestamp
            self._db.insert_session(data)
            if data.get("errors"):
                self._db.insert_session_errors(data["session_id"], data["errors"])
            # Record cost in the cost ledger for aggregate tracking
            total_input = sum(t.input_tokens for t in record.turns)
            total_output = sum(t.output_tokens for t in record.turns)
            comp = data.get("composition", {})
            if record.cost.total_usd > 0:
                self._db.record_cost(
                    session_id=data["session_id"],
                    agent_id=comp.get("agent_id", ""),
                    agent_name=comp.get("agent_name", ""),
                    model=comp.get("model", ""),
                    input_tokens=total_input,
                    output_tokens=total_output,
                    cost_usd=record.cost.total_usd,
                )
            # Record billing entry for customer charging
            try:
                self._db.record_billing(
                    cost_type="inference",
                    total_cost_usd=record.cost.total_usd,
                    agent_name=comp.get("agent_name", ""),
                    model=comp.get("model", ""),
                    provider=self._agent_config.get("_provider", ""),
                    input_tokens=total_input,
                    output_tokens=total_output,
                    inference_cost_usd=record.cost.total_usd,
                    session_id=data["session_id"],
                    trace_id=data.get("trace_id", ""),
                )
            except Exception:
                pass  # billing table may not exist in older DBs
        except Exception as exc:
            logger.error("Failed to persist session to SQLite: %s", exc)
            # Fall back to JSONL if configured
            if self.storage_path:
                self._append_to_storage(record)

    def export(self, path: str | Path) -> Path:
        """Export all records to a JSONL file."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            for rec in self._records:
                f.write(json.dumps(rec.to_dict()) + "\n")
        logger.info("Exported %d session records to %s", len(self._records), path)
        return path

    def summary(self) -> dict[str, Any]:
        """Quick summary stats across all observed sessions."""
        if not self._records:
            return {"total_sessions": 0}

        successes = sum(1 for r in self._records if r.status == "success")
        errors = sum(1 for r in self._records if r.status == "error")
        timeouts = sum(1 for r in self._records if r.status == "timeout")
        total_cost = sum(r.cost.total_usd for r in self._records)
        avg_turns = sum(r.step_count for r in self._records) / len(self._records)
        avg_latency = (
            sum(r.wall_clock_seconds for r in self._records) / len(self._records)
        )

        # Error breakdown by source
        error_sources: dict[str, int] = {}
        for rec in self._records:
            for err in rec.errors:
                key = err.source.value
                error_sources[key] = error_sources.get(key, 0) + 1

        return {
            "total_sessions": len(self._records),
            "success_rate": successes / len(self._records),
            "successes": successes,
            "errors": errors,
            "timeouts": timeouts,
            "total_cost_usd": total_cost,
            "avg_turns": avg_turns,
            "avg_wall_clock_seconds": avg_latency,
            "error_sources": error_sources,
        }


def _extract_tool_names(tools: list) -> list[str]:
    """Extract tool names from a mixed list of strings and dicts."""
    names = []
    for t in tools:
        if isinstance(t, str):
            names.append(t)
        elif isinstance(t, dict):
            names.append(t.get("name", "unknown"))
    return names
