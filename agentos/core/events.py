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
