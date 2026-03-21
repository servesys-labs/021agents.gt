"""The Composable Agent Harness — central orchestrator of AgentOS."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentos.core.events import Event, EventBus, EventType
from agentos.core.governance import GovernanceLayer, GovernancePolicy
from agentos.llm.provider import LLMResponse
from agentos.llm.router import LLMRouter
from agentos.memory.manager import MemoryManager
from agentos.tools.executor import ToolExecutor

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent.parent / "config" / "default.json"


@dataclass
class HarnessConfig:
    max_turns: int = 50
    timeout_seconds: float = 300.0
    retry_on_tool_failure: bool = True
    max_retries: int = 3


@dataclass
class TurnResult:
    """Result of a single agent turn."""

    turn_number: int
    llm_response: LLMResponse | None = None
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    done: bool = False


class AgentHarness:
    """Central orchestrator managing the agent lifecycle.

    Separates orchestration (execution flow) from governance (safety checks).
    Supports multi-turn execution with graceful error recovery.
    """

    def __init__(
        self,
        config: HarnessConfig | None = None,
        llm_router: LLMRouter | None = None,
        tool_executor: ToolExecutor | None = None,
        memory_manager: MemoryManager | None = None,
        governance: GovernanceLayer | None = None,
        event_bus: EventBus | None = None,
    ) -> None:
        self.config = config or HarnessConfig()
        self.event_bus = event_bus or EventBus()
        self.governance = governance or GovernanceLayer()
        self.llm_router = llm_router or LLMRouter()
        self.tool_executor = tool_executor or ToolExecutor()
        self.memory_manager = memory_manager or MemoryManager()
        self._turn = 0

    @classmethod
    def from_config_file(cls, path: str | Path | None = None) -> AgentHarness:
        path = Path(path) if path else DEFAULT_CONFIG
        if path.exists():
            raw = json.loads(path.read_text())
        else:
            raw = {}

        harness_cfg = HarnessConfig(**raw.get("harness", {}))
        gov_policy = GovernancePolicy(**raw.get("governance", {}))
        return cls(config=harness_cfg, governance=GovernanceLayer(gov_policy))

    async def run(self, user_input: str) -> list[TurnResult]:
        """Execute a multi-turn agent loop for the given user input."""
        results: list[TurnResult] = []
        await self.event_bus.emit(Event(type=EventType.SESSION_START, data={"input": user_input}))

        messages: list[dict[str, str]] = [{"role": "user", "content": user_input}]

        # Load relevant memory context
        memory_context = await self.memory_manager.build_context(user_input)
        if memory_context:
            messages.insert(0, {"role": "system", "content": memory_context})

        for turn in range(1, self.config.max_turns + 1):
            self._turn = turn
            await self.event_bus.emit(Event(type=EventType.TURN_START, data={"turn": turn}))

            # 1. LLM call
            llm_response = await self._call_llm(messages)
            if llm_response is None:
                result = TurnResult(turn_number=turn, error="LLM call failed", done=True)
                results.append(result)
                break

            # 2. Check for tool calls
            if llm_response.tool_calls:
                tool_results = await self._execute_tools(llm_response.tool_calls)
                result = TurnResult(
                    turn_number=turn,
                    llm_response=llm_response,
                    tool_results=tool_results,
                )
                results.append(result)

                # Feed tool results back as messages
                messages.append({"role": "assistant", "content": llm_response.content})
                for tr in tool_results:
                    messages.append({"role": "tool", "content": json.dumps(tr)})
            else:
                # No tool calls — agent is done
                result = TurnResult(turn_number=turn, llm_response=llm_response, done=True)
                results.append(result)

                # Store interaction in episodic memory
                await self.memory_manager.store_episode(user_input, llm_response.content)
                break

            await self.event_bus.emit(Event(type=EventType.TURN_END, data={"turn": turn}))

        await self.event_bus.emit(Event(type=EventType.SESSION_END))
        return results

    async def _call_llm(self, messages: list[dict[str, str]]) -> LLMResponse | None:
        """Route to the appropriate LLM and return the response."""
        if not self.governance.check_budget(0.01):
            logger.warning("Budget exhausted")
            return None

        await self.event_bus.emit(Event(type=EventType.LLM_REQUEST))
        response = await self.llm_router.route(messages)
        await self.event_bus.emit(
            Event(type=EventType.LLM_RESPONSE, data={"model": response.model})
        )
        self.governance.record_cost(response.cost_usd)
        return response

    async def _execute_tools(self, tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Execute tool calls with governance checks and retries."""
        results: list[dict[str, Any]] = []
        for call in tool_calls:
            tool_name = call.get("name", "")
            if not self.governance.is_tool_allowed(tool_name):
                results.append({"tool": tool_name, "error": "Tool blocked by governance policy"})
                continue
            if self.governance.requires_confirmation(call):
                results.append({"tool": tool_name, "error": "Requires user confirmation"})
                continue

            await self.event_bus.emit(Event(type=EventType.TOOL_CALL, data=call))
            result = await self.tool_executor.execute(
                tool_name, call.get("arguments", {})
            )
            await self.event_bus.emit(Event(type=EventType.TOOL_RESULT, data=result))
            results.append(result)
        return results
