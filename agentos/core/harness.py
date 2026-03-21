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
        """Execute a multi-turn agent loop for the given user input.

        Follows the initialization sequence:
        1. Analyze request — determine intent and complexity
        2. Select LLM — choose appropriate model via router
        3. Load context — retrieve from all memory tiers + RAG
        4. Discover tools — verify availability via MCP
        5. Plan & Execute — formulate plan and begin execution
        """
        results: list[TurnResult] = []
        await self.event_bus.emit(Event(type=EventType.SESSION_START, data={"input": user_input}))

        # --- Initialization Sequence ---

        # Step 1: Analyze request (complexity classification)
        from agentos.llm.router import Complexity
        complexity = self.llm_router.classify([{"role": "user", "content": user_input}])
        await self.event_bus.emit(Event(
            type=EventType.TASK_RECEIVED,
            data={"input": user_input, "complexity": complexity.value},
        ))

        # Step 2: LLM selection is handled dynamically by the router

        # Step 3: Load context from all memory tiers
        memory_context = await self.memory_manager.build_context(user_input)

        # Step 4: Discover available tools
        available_tools = self.tool_executor.available_tools()
        self.llm_router.set_tools(available_tools)

        # Step 5: Build messages and begin execution
        messages: list[dict[str, str]] = [{"role": "user", "content": user_input}]
        if memory_context:
            messages.insert(0, {"role": "system", "content": memory_context})

        # Track successful tool sequences for procedural memory
        tool_sequence: list[dict[str, Any]] = []

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

                # Track tool results for procedural memory
                for tr in tool_results:
                    tool_sequence.append(tr)

                # Check for failures and attempt alternative approaches
                failed = [tr for tr in tool_results if "error" in tr]
                if failed and self.config.retry_on_tool_failure:
                    # Inject failure context so LLM can try alternative approach
                    error_summary = "; ".join(
                        f"{tr.get('tool', '?')}: {tr['error']}" for tr in failed
                    )
                    messages.append({"role": "assistant", "content": llm_response.content})
                    for tr in tool_results:
                        messages.append({"role": "tool", "content": json.dumps(tr)})
                    messages.append({
                        "role": "system",
                        "content": f"Tool failures occurred: {error_summary}. "
                        "Analyze the error and try an alternative approach. "
                        "Do not repeat the exact same failed action.",
                    })
                    result = TurnResult(
                        turn_number=turn,
                        llm_response=llm_response,
                        tool_results=tool_results,
                    )
                    results.append(result)
                else:
                    result = TurnResult(
                        turn_number=turn,
                        llm_response=llm_response,
                        tool_results=tool_results,
                    )
                    results.append(result)
                    messages.append({"role": "assistant", "content": llm_response.content})
                    for tr in tool_results:
                        messages.append({"role": "tool", "content": json.dumps(tr)})
            else:
                # No tool calls — agent is done
                result = TurnResult(turn_number=turn, llm_response=llm_response, done=True)
                results.append(result)

                # Store interaction in episodic memory
                await self.memory_manager.store_episode(user_input, llm_response.content)

                # Store successful tool sequence in procedural memory
                if tool_sequence:
                    await self._store_procedure(user_input, tool_sequence)

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

    async def _store_procedure(
        self, task_description: str, tool_sequence: list[dict[str, Any]]
    ) -> None:
        """Store a successful tool sequence as a learned procedure."""
        from agentos.memory.procedural import Procedure

        # Build a name from the first few words of the task
        words = task_description.split()[:5]
        name = "_".join(w.lower().strip("?.!,") for w in words if w.strip())
        if not name:
            return

        steps = [
            {"tool": tr.get("tool", "unknown"), "result_keys": list(tr.keys())}
            for tr in tool_sequence
        ]
        success = all("error" not in tr for tr in tool_sequence)

        existing = self.memory_manager.procedural.get(name)
        if existing:
            self.memory_manager.procedural.record_outcome(name, success)
        else:
            proc = Procedure(
                name=name,
                steps=steps,
                description=task_description[:120],
                success_count=1 if success else 0,
                failure_count=0 if success else 1,
            )
            self.memory_manager.procedural.store(proc)
