"""Event bus for the agent harness."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine


class EventType(str, Enum):
    TASK_RECEIVED = "task_received"
    LLM_REQUEST = "llm_request"
    LLM_RESPONSE = "llm_response"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    MEMORY_READ = "memory_read"
    MEMORY_WRITE = "memory_write"
    RAG_QUERY = "rag_query"
    RAG_RESULT = "rag_result"
    VOICE_INPUT = "voice_input"
    VOICE_OUTPUT = "voice_output"
    ERROR = "error"
    TURN_START = "turn_start"
    TURN_END = "turn_end"
    SESSION_START = "session_start"
    SESSION_END = "session_end"
    GOVERNANCE_CHECK = "governance_check"

    # Middleware events
    MIDDLEWARE_WARNING = "middleware_warning"
    MIDDLEWARE_HALT = "middleware_halt"
    LOOP_DETECTED = "loop_detected"
    CONTEXT_SUMMARIZED = "context_summarized"

    # Skill events
    SKILL_LOADED = "skill_loaded"
    SKILL_INJECTED = "skill_injected"

    # Memory async events
    MEMORY_FACT_EXTRACTED = "memory_fact_extracted"
    MEMORY_UPDATE_QUEUED = "memory_update_queued"
    MEMORY_UPDATE_PROCESSED = "memory_update_processed"

    # Sandbox virtual path events
    SANDBOX_PATH_TRANSLATED = "sandbox_path_translated"

    # Conversation intelligence events
    CONVERSATION_SCORED = "conversation_scored"
    TURN_SCORED = "turn_scored"
    QUALITY_ALERT = "quality_alert"
    SENTIMENT_ALERT = "sentiment_alert"

    # Issue tracking events
    ISSUE_CREATED = "issue_created"
    ISSUE_TRIAGED = "issue_triaged"
    ISSUE_RESOLVED = "issue_resolved"
    ISSUE_FIX_SUGGESTED = "issue_fix_suggested"

    # Gold image and compliance events
    GOLD_IMAGE_CREATED = "gold_image_created"
    GOLD_IMAGE_UPDATED = "gold_image_updated"
    GOLD_IMAGE_APPROVED = "gold_image_approved"
    GOLD_IMAGE_DELETED = "gold_image_deleted"
    COMPLIANCE_CHECK_PASSED = "compliance_check_passed"
    COMPLIANCE_CHECK_FAILED = "compliance_check_failed"

    # Security red-teaming events
    SECURITY_SCAN_STARTED = "security_scan_started"
    SECURITY_SCAN_COMPLETED = "security_scan_completed"
    SECURITY_FINDING_DETECTED = "security_finding_detected"
    SECURITY_RISK_UPDATED = "security_risk_updated"

    # Evolution events (outer-loop agent)
    EVOLUTION_ANALYSIS = "evolution_analysis"
    EVOLUTION_PROPOSAL = "evolution_proposal"
    EVOLUTION_APPROVED = "evolution_approved"
    EVOLUTION_APPLIED = "evolution_applied"
    EVOLUTION_ROLLBACK = "evolution_rollback"


@dataclass
class Event:
    """An event flowing through the agent harness."""

    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: float = field(default_factory=time.time)
    source: str = ""


Listener = Callable[[Event], Coroutine[Any, Any, None]]


class EventBus:
    """Publish-subscribe event bus for decoupled component communication."""

    def __init__(self) -> None:
        self._listeners: dict[EventType, list[Listener]] = {}
        self._global_listeners: list[Listener] = []

    def on(self, event_type: EventType, listener: Listener) -> None:
        self._listeners.setdefault(event_type, []).append(listener)

    def on_all(self, listener: Listener) -> None:
        self._global_listeners.append(listener)

    async def emit(self, event: Event) -> None:
        tasks: list[Coroutine[Any, Any, None]] = []
        for listener in self._listeners.get(event.type, []):
            tasks.append(listener(event))
        for listener in self._global_listeners:
            tasks.append(listener(event))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
