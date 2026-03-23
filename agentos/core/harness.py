"""The Composable Agent Harness — central orchestrator of AgentOS.

Now with middleware chain support for composable cross-cutting concerns
(loop detection, summarization, memory updates, etc.).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from agentos.core.events import Event, EventBus, EventType
from agentos.core.governance import GovernanceLayer, GovernancePolicy
from agentos.llm.provider import LLMResponse
from agentos.llm.router import LLMRouter
from agentos.memory.manager import MemoryManager
from agentos.middleware.base import Middleware, MiddlewareChain, MiddlewareContext
from agentos.skills.loader import SkillLoader
from agentos.tools.executor import ToolExecutor

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent.parent / "config" / "default.json"


def _default_config_candidates() -> list[Path]:
    """Return possible default-config paths in priority order."""
    return [
        DEFAULT_CONFIG,
        Path.cwd() / "config" / "default.json",
    ]


@dataclass
class HarnessConfig:
    max_turns: int = 50
    timeout_seconds: float = 300.0
    retry_on_tool_failure: bool = True
    max_retries: int = 3
    enable_loop_detection: bool = True
    enable_summarization: bool = True
    enable_skills: bool = True
    enable_async_memory: bool = False
    enable_planner_artifact: bool = True
    enable_reflection_stage: bool = True
    enable_typed_runtime_dag: bool = True
    reflection_gate_on_finalize: bool = True
    reflection_min_confidence: float = 0.6
    max_reflection_attempts: int = 1
    parallel_tool_calls: bool = True
    max_context_tokens: int = 100_000
    skills_dir: str = ""


@dataclass
class TurnResult:
    """Result of a single agent turn."""

    turn_number: int
    llm_response: LLMResponse | None = None
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    done: bool = False
    stop_reason: str = ""  # completed / max_turns / budget / timeout / llm_error / loop_detected / middleware_halt
    cost_usd: float = 0.0
    cumulative_cost_usd: float = 0.0
    model_used: str = ""
    middleware_warnings: list[str] = field(default_factory=list)
    execution_mode: str = "sequential"
    plan_artifact: dict[str, Any] = field(default_factory=dict)
    reflection: dict[str, Any] = field(default_factory=dict)


class AgentHarness:
    """Central orchestrator managing the agent lifecycle.

    Separates orchestration (execution flow) from governance (safety checks).
    Supports multi-turn execution with graceful error recovery.
    Integrates composable middleware chain for cross-cutting concerns.
    """

    def __init__(
        self,
        config: HarnessConfig | None = None,
        llm_router: LLMRouter | None = None,
        tool_executor: ToolExecutor | None = None,
        memory_manager: MemoryManager | None = None,
        governance: GovernanceLayer | None = None,
        event_bus: EventBus | None = None,
        middleware_chain: MiddlewareChain | None = None,
        skill_loader: SkillLoader | None = None,
    ) -> None:
        self.config = config or HarnessConfig()
        self.event_bus = event_bus or EventBus()
        self.governance = governance or GovernanceLayer()
        self.llm_router = llm_router or LLMRouter()
        self.tool_executor = tool_executor or ToolExecutor()
        self.memory_manager = memory_manager or MemoryManager()
        self.system_prompt: str = ""
        self._turn = 0
        # Trace context — set by parent when running as sub-agent
        self.trace_id: str = ""
        self.parent_session_id: str = ""
        self.depth: int = 0
        # Streaming callback — called after each turn completes
        self.on_turn_complete: Callable | None = None

        # Middleware chain — composable hooks around each LLM call
        self.middleware_chain = middleware_chain or self._build_default_middleware()

        # Skill loader
        skills_dir = Path(self.config.skills_dir) if self.config.skills_dir else None
        self.skill_loader = skill_loader or SkillLoader(skills_dir=skills_dir)

        # Async memory updater
        self._async_memory_updater = None
        self._async_memory_started = False
        if self.config.enable_async_memory:
            from agentos.memory.async_updater import AsyncMemoryUpdater
            self._async_memory_updater = AsyncMemoryUpdater()

    def _build_default_middleware(self) -> MiddlewareChain:
        """Build the default middleware chain based on config."""
        middlewares: list[Middleware] = []

        if self.config.enable_loop_detection:
            from agentos.middleware.loop_detection import LoopDetectionMiddleware
            middlewares.append(LoopDetectionMiddleware())

        if self.config.enable_summarization:
            from agentos.middleware.summarization import SummarizationMiddleware
            middlewares.append(SummarizationMiddleware(
                max_context_tokens=self.config.max_context_tokens,
            ))

        return MiddlewareChain(middlewares)

    @classmethod
    def from_config_file(cls, path: str | Path | None = None) -> AgentHarness:
        if path:
            config_path = Path(path)
        else:
            config_path = next((p for p in _default_config_candidates() if p.exists()), None)

        if config_path and config_path.exists():
            raw = json.loads(config_path.read_text())
        else:
            raw = {}

        harness_cfg = HarnessConfig(**{
            k: v for k, v in raw.get("harness", {}).items()
            if k in HarnessConfig.__dataclass_fields__
        })
        gov_policy = GovernancePolicy(**raw.get("governance", {}))
        return cls(config=harness_cfg, governance=GovernanceLayer(gov_policy))

    async def run(self, user_input: str) -> list[TurnResult]:
        """Execute a multi-turn agent loop for the given user input."""
        import asyncio

        try:
            return await asyncio.wait_for(
                self._run_inner(user_input),
                timeout=self.config.timeout_seconds,
            )
        except asyncio.TimeoutError:
            logger.warning("Agent run timed out after %.0fs", self.config.timeout_seconds)
            return [TurnResult(
                turn_number=self._turn or 1,
                error=f"Timed out after {self.config.timeout_seconds:.0f}s",
                done=True,
                stop_reason="timeout",
            )]

    async def _run_inner(self, user_input: str) -> list[TurnResult]:
        """Inner run loop — separated so timeout can wrap it."""
        results: list[TurnResult] = []
        cumulative_cost = 0.0
        self.governance.reset_for_session()
        # Generate trace_id and session_id for this run
        import uuid as _uuid
        if not self.trace_id:
            self.trace_id = _uuid.uuid4().hex[:16]
        self._current_session_id = _uuid.uuid4().hex[:16]

        # Initialize middleware context for this session
        mw_ctx = MiddlewareContext(
            session_id=self._current_session_id,
            trace_id=self.trace_id,
            event_bus=self.event_bus,
        )

        # Start async memory updater if enabled (deferred to first run)
        if self._async_memory_updater and not self._async_memory_started:
            self._async_memory_updater.start()
            self._async_memory_started = True

        # Notify middleware chain of session start
        await self.middleware_chain.run_on_session_start(mw_ctx)

        await self.event_bus.emit(Event(type=EventType.SESSION_START, data={
            "input": user_input,
            "session_id": self._current_session_id,
            "trace_id": self.trace_id,
            "parent_session_id": self.parent_session_id,
            "depth": self.depth,
            "middleware_chain": self.middleware_chain.middleware_names,
        }))

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

        # Step 3b: Load async memory context if available
        async_memory_section = ""
        if self._async_memory_updater:
            async_memory_section = self._async_memory_updater.memory.to_prompt_section()

        # Step 4: Discover available tools
        available_tools = self.tool_executor.available_tools()
        self.llm_router.set_tools(available_tools)
        # Step 3c: Load learned procedures relevant to this task
        procedures_section = ""
        best_procs = self.memory_manager.procedural.find_best(user_input, limit=3)
        if best_procs:
            proc_lines = []
            for p in best_procs:
                steps_str = " → ".join(s.get("tool", "?") for s in p.steps[:5])
                proc_lines.append(f"- {p.name} ({p.success_rate:.0%} success): {steps_str}")
            procedures_section = "Learned procedures (from past successes):\n" + "\n".join(proc_lines)

        # Step 4b: Load enabled skills
        skills_section = ""
        if self.config.enable_skills:
            skills_section = self.skill_loader.build_prompt_section()

        # Step 5: Build messages and begin execution
        messages: list[dict[str, str]] = [{"role": "user", "content": user_input}]

        # Build system message from agent identity + memory + skills
        system_parts: list[str] = []
        if self.system_prompt:
            system_parts.append(self.system_prompt)
        if skills_section:
            system_parts.append(skills_section)
        if memory_context:
            system_parts.append(memory_context)
        if async_memory_section:
            system_parts.append(async_memory_section)
        if procedures_section:
            system_parts.append(procedures_section)
        if system_parts:
            messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})

        # Track successful tool sequences for procedural memory
        tool_sequence: list[dict[str, Any]] = []
        failure_retries = 0
        reflection_retries = 0

        for turn in range(1, self.config.max_turns + 1):
            self._turn = turn
            mw_ctx.turn_number = turn
            mw_ctx.messages = messages
            mw_ctx.injected_messages = []
            await self.event_bus.emit(Event(type=EventType.TURN_START, data={"turn": turn}))

            # --- Middleware: before_model ---
            await self.middleware_chain.run_before_model(mw_ctx)
            messages = mw_ctx.messages  # Middleware may have modified messages

            # Check if middleware halted execution
            if mw_ctx.halt:
                result = TurnResult(
                    turn_number=turn,
                    error=mw_ctx.halt_reason or "Halted by middleware",
                    done=True,
                    stop_reason="middleware_halt",
                    cumulative_cost_usd=cumulative_cost,
                )
                results.append(result)
                self._notify_turn(result)
                await self.event_bus.emit(Event(type=EventType.MIDDLEWARE_HALT, data={
                    "turn": turn, "reason": mw_ctx.halt_reason,
                }))
                await self.event_bus.emit(Event(type=EventType.TURN_END, data={"turn": turn}))
                break

            # 1. LLM call (skip if middleware says so)
            if mw_ctx.skip_llm_call:
                mw_ctx.skip_llm_call = False
                continue

            llm_response = await self._call_llm(messages)
            if llm_response is None:
                is_budget = not self.governance.check_budget(0.01)
                stop = "budget" if is_budget else "llm_error"
                error_msg = "Budget exhausted" if is_budget else "LLM call failed"
                result = TurnResult(
                    turn_number=turn, error=error_msg, done=True, stop_reason=stop,
                    cumulative_cost_usd=cumulative_cost,
                )
                results.append(result)
                self._notify_turn(result)
                await self.event_bus.emit(Event(type=EventType.TURN_END, data={"turn": turn}))
                break

            cumulative_cost += llm_response.cost_usd

            # --- Middleware: after_model ---
            mw_ctx.llm_response = llm_response
            await self.middleware_chain.run_after_model(mw_ctx)

            # Apply force_text_response (e.g., from loop detection)
            if mw_ctx.force_text_response and llm_response.tool_calls:
                llm_response.tool_calls = []
                mw_ctx.force_text_response = False

            # Collect middleware warnings for the turn result
            turn_warnings = [
                m.get("content", "") for m in mw_ctx.injected_messages
                if m.get("role") == "system"
            ]

            # Inject middleware messages into conversation
            for msg in mw_ctx.injected_messages:
                messages.append(msg)
            mw_ctx.injected_messages = []

            # 2. Check for tool calls
            if llm_response.tool_calls:
                tool_results = await self._execute_tools(llm_response.tool_calls)
                execution_mode = (
                    "parallel"
                    if self.config.parallel_tool_calls and len(llm_response.tool_calls) > 1
                    else "sequential"
                )
                plan_artifact = self._build_turn_plan_artifact(
                    user_input=user_input,
                    complexity=complexity.value,
                    available_tools=available_tools,
                    turn_number=turn,
                    execution_mode=execution_mode,
                    has_tool_calls=True,
                    done=False,
                )

                # Track tool results for procedural memory
                for tr in tool_results:
                    tool_sequence.append(tr)

                # Update middleware context with tool results
                mw_ctx.tool_results = tool_results

                # Check for failures and attempt alternative approaches
                failed = [tr for tr in tool_results if "error" in tr]
                if failed and self.config.retry_on_tool_failure:
                    if failure_retries >= self.config.max_retries:
                        result = TurnResult(
                            turn_number=turn,
                            llm_response=llm_response,
                            tool_results=tool_results,
                            error=(
                                "Tool failures exceeded retry limit "
                                f"({self.config.max_retries})"
                            ),
                            done=True,
                            stop_reason="tool_error",
                            cost_usd=llm_response.cost_usd,
                            cumulative_cost_usd=cumulative_cost,
                            model_used=llm_response.model,
                            middleware_warnings=turn_warnings,
                            execution_mode=execution_mode,
                            plan_artifact=plan_artifact,
                            reflection=self._build_reflection_artifact(
                                llm_response=llm_response,
                                tool_results=tool_results,
                                middleware_warnings=turn_warnings,
                                done=True,
                                error=(
                                    "Tool failures exceeded retry limit "
                                    f"({self.config.max_retries})"
                                ),
                            ),
                        )
                        results.append(result)
                        self._notify_turn(result)
                        await self.event_bus.emit(Event(type=EventType.TURN_END, data={
                            "turn": turn,
                            "execution_mode": result.execution_mode,
                            "plan_artifact": result.plan_artifact,
                            "reflection": result.reflection,
                        }))
                        break
                    failure_retries += 1
                    # Inject failure context so LLM can try alternative approach
                    error_summary = "; ".join(
                        f"{tr.get('tool', '?')}: {tr['error']}" for tr in failed
                    )
                    messages.append({
                        "role": "assistant",
                        "content": llm_response.content,
                        "tool_calls": llm_response.tool_calls,
                    })
                    for tc, tr in zip(llm_response.tool_calls, tool_results):
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "name": tc.get("name", ""),
                            "content": json.dumps(tr),
                        })
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
                        cost_usd=llm_response.cost_usd,
                        cumulative_cost_usd=cumulative_cost,
                        model_used=llm_response.model,
                        middleware_warnings=turn_warnings,
                        execution_mode=execution_mode,
                        plan_artifact=plan_artifact,
                        reflection=self._build_reflection_artifact(
                            llm_response=llm_response,
                            tool_results=tool_results,
                            middleware_warnings=turn_warnings,
                            done=False,
                        ),
                    )
                    results.append(result)
                    self._notify_turn(result)
                else:
                    result = TurnResult(
                        turn_number=turn,
                        llm_response=llm_response,
                        tool_results=tool_results,
                        cost_usd=llm_response.cost_usd,
                        cumulative_cost_usd=cumulative_cost,
                        model_used=llm_response.model,
                        middleware_warnings=turn_warnings,
                        execution_mode=execution_mode,
                        plan_artifact=plan_artifact,
                        reflection=self._build_reflection_artifact(
                            llm_response=llm_response,
                            tool_results=tool_results,
                            middleware_warnings=turn_warnings,
                            done=False,
                        ),
                    )
                    results.append(result)
                    self._notify_turn(result)
                    failure_retries = 0
                    reflection_retries = 0
                    messages.append({
                        "role": "assistant",
                        "content": llm_response.content,
                        "tool_calls": llm_response.tool_calls,
                    })
                    for tc, tr in zip(llm_response.tool_calls, tool_results):
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "name": tc.get("name", ""),
                            "content": json.dumps(tr),
                        })
            else:
                # No tool calls — finalize, with optional reflection gate.
                plan_artifact = self._build_turn_plan_artifact(
                    user_input=user_input,
                    complexity=complexity.value,
                    available_tools=available_tools,
                    turn_number=turn,
                    execution_mode="sequential",
                    has_tool_calls=False,
                    done=True,
                )
                reflection = self._build_reflection_artifact(
                    llm_response=llm_response,
                    tool_results=[],
                    middleware_warnings=turn_warnings,
                    done=True,
                )
                if self._should_retry_for_reflection(
                    reflection=reflection,
                    reflection_retries=reflection_retries,
                    turn=turn,
                ):
                    reflection_retries += 1
                    result = TurnResult(
                        turn_number=turn, llm_response=llm_response, done=False,
                        stop_reason="reflection_retry",
                        cost_usd=llm_response.cost_usd,
                        cumulative_cost_usd=cumulative_cost,
                        model_used=llm_response.model,
                        middleware_warnings=turn_warnings,
                        execution_mode="sequential",
                        plan_artifact=plan_artifact,
                        reflection=reflection,
                    )
                    results.append(result)
                    self._notify_turn(result)
                    messages.append({"role": "assistant", "content": llm_response.content})
                    messages.append({
                        "role": "system",
                        "content": (
                            "Reflection gate triggered: confidence is below threshold. "
                            "Revise your answer with clearer reasoning and verification."
                        ),
                    })
                    await self.event_bus.emit(Event(type=EventType.TURN_END, data={
                        "turn": turn,
                        "execution_mode": result.execution_mode,
                        "plan_artifact": result.plan_artifact,
                        "reflection": result.reflection,
                    }))
                    continue

                result = TurnResult(
                    turn_number=turn, llm_response=llm_response, done=True,
                    stop_reason="completed",
                    cost_usd=llm_response.cost_usd,
                    cumulative_cost_usd=cumulative_cost,
                    model_used=llm_response.model,
                    middleware_warnings=turn_warnings,
                    execution_mode="sequential",
                    plan_artifact=plan_artifact,
                    reflection=reflection,
                )
                results.append(result)
                self._notify_turn(result)

                # Store interaction in episodic memory
                await self.memory_manager.store_episode(user_input, llm_response.content)

                # Queue async memory update if enabled
                if self._async_memory_updater:
                    from agentos.memory.async_updater import MemoryUpdate
                    self._async_memory_updater.queue_update(MemoryUpdate(
                        user_message=user_input,
                        assistant_message=llm_response.content,
                        session_id=self._current_session_id,
                    ))

                # Store successful tool sequence in procedural memory
                if tool_sequence:
                    await self._store_procedure(user_input, tool_sequence)
                failure_retries = 0
                reflection_retries = 0

                await self.event_bus.emit(Event(type=EventType.TURN_END, data={
                    "turn": turn,
                    "execution_mode": result.execution_mode,
                    "plan_artifact": result.plan_artifact,
                    "reflection": result.reflection,
                }))
                break

            # --- Middleware: on_turn_end ---
            await self.middleware_chain.run_on_turn_end(mw_ctx)
            last_result = results[-1] if results else None
            await self.event_bus.emit(Event(type=EventType.TURN_END, data={
                "turn": turn,
                "execution_mode": last_result.execution_mode if last_result else "sequential",
                "plan_artifact": last_result.plan_artifact if last_result else {},
                "reflection": last_result.reflection if last_result else {},
            }))

        # --- Middleware: on_session_end ---
        await self.middleware_chain.run_on_session_end(mw_ctx)
        await self.event_bus.emit(Event(type=EventType.SESSION_END))
        return results

    def _notify_turn(self, result: TurnResult) -> None:
        """Fire the on_turn_complete callback if set."""
        if self.on_turn_complete is not None:
            try:
                self.on_turn_complete(result)
            except Exception:
                pass  # Don't let callback errors break the run

    async def _call_llm(self, messages: list[dict[str, str]]) -> LLMResponse | None:
        """Route to the appropriate LLM and return the response."""
        if not self.governance.check_budget(0.01):
            logger.warning("Budget exhausted")
            return None

        await self.event_bus.emit(Event(type=EventType.LLM_REQUEST))
        try:
            response = await self.llm_router.route(messages)
        except Exception as exc:
            logger.error("LLM call failed: %s", exc)
            await self.event_bus.emit(Event(type=EventType.ERROR, data={"source": "llm", "message": str(exc)}))
            return None
        await self.event_bus.emit(
            Event(type=EventType.LLM_RESPONSE, data={
                "model": response.model,
                "content": response.content[:200] if response.content else "",
                "cost_usd": response.cost_usd,
                "input_tokens": response.usage.get("input_tokens", 0),
                "output_tokens": response.usage.get("output_tokens", 0),
            })
        )
        self.governance.record_cost(response.cost_usd)
        return response

    async def _execute_tools(self, tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Execute tool calls with governance checks and retries."""
        async def _run_call(call: dict[str, Any]) -> dict[str, Any]:
            tool_name = call.get("name", "")
            if not self.governance.is_tool_allowed(tool_name):
                return {"tool": tool_name, "error": "Tool blocked by governance policy"}
            if self.governance.requires_confirmation(call):
                return {"tool": tool_name, "error": "Requires user confirmation"}

            await self.event_bus.emit(Event(type=EventType.TOOL_CALL, data=call))
            arguments = call.get("arguments", {})
            # Inject trace context for sub-agent calls
            if tool_name == "run-agent" and self.trace_id:
                arguments = {
                    **arguments,
                    "_parent_trace_id": self.trace_id,
                    "_parent_session_id": getattr(self, '_current_session_id', ''),
                    "_parent_depth": self.depth,
                }
            result = await self.tool_executor.execute(tool_name, arguments)
            await self.event_bus.emit(Event(type=EventType.TOOL_RESULT, data=result))
            return result

        if self.config.parallel_tool_calls and len(tool_calls) > 1:
            import asyncio
            return list(await asyncio.gather(*(_run_call(call) for call in tool_calls)))
        return [await _run_call(call) for call in tool_calls]

    def _build_turn_plan_artifact(
        self,
        user_input: str,
        complexity: str,
        available_tools: list[dict[str, Any]],
        turn_number: int,
        execution_mode: str,
        has_tool_calls: bool,
        done: bool,
    ) -> dict[str, Any]:
        """Generate a typed DAG-like plan artifact for each runtime turn."""
        if not self.config.enable_planner_artifact:
            return {}
        nodes = [
            {"id": "plan", "type": "plan", "status": "completed"},
            {"id": "llm", "type": "llm", "status": "completed"},
        ]
        edges = [{"from": "plan", "to": "llm"}]
        if has_tool_calls:
            nodes.append({
                "id": "tools",
                "type": "tool_fanout" if execution_mode == "parallel" else "tool",
                "status": "completed",
            })
            edges.append({"from": "llm", "to": "tools"})
            nodes.append({"id": "reflect", "type": "reflect", "status": "completed"})
            edges.append({"from": "tools", "to": "reflect"})
        else:
            nodes.append({"id": "reflect", "type": "reflect", "status": "completed"})
            edges.append({"from": "llm", "to": "reflect"})
        nodes.append({"id": "finalize", "type": "finalize", "status": "completed" if done else "in_progress"})
        edges.append({"from": "reflect", "to": "finalize"})
        return {
            "version": 1,
            "turn_number": turn_number,
            "goal": user_input[:400],
            "complexity": complexity,
            "tool_candidates": [str(t.get("name", "")) for t in available_tools[:20]],
            "execution_mode": execution_mode,
            "dag": {"nodes": nodes, "edges": edges},
        }

    def _build_reflection_artifact(
        self,
        llm_response: LLMResponse,
        tool_results: list[dict[str, Any]],
        middleware_warnings: list[str],
        done: bool,
        error: str = "",
    ) -> dict[str, Any]:
        """Produce a per-turn reflection payload for run diagnostics."""
        if not self.config.enable_reflection_stage:
            return {}
        failed_tools = [r.get("tool", "") for r in tool_results if "error" in r]
        confidence = 1.0
        if failed_tools:
            confidence -= min(0.6, 0.2 * len(failed_tools))
        if middleware_warnings:
            confidence -= 0.2
        if error:
            confidence = min(confidence, 0.2)
        confidence = max(0.0, round(confidence, 3))
        return {
            "done": done,
            "confidence": confidence,
            "tool_failures": failed_tools,
            "warnings": middleware_warnings,
            "response_chars": len(llm_response.content or ""),
            "error": error,
            "next_action": "finalize" if done and not error else ("recover" if failed_tools or error else "continue"),
        }

    def _should_retry_for_reflection(
        self,
        reflection: dict[str, Any],
        reflection_retries: int,
        turn: int,
    ) -> bool:
        """Gate finalization on reflection confidence when configured."""
        if not self.config.enable_reflection_stage:
            return False
        if not self.config.reflection_gate_on_finalize:
            return False
        if reflection_retries >= self.config.max_reflection_attempts:
            return False
        if turn >= self.config.max_turns:
            return False
        confidence = reflection.get("confidence")
        if not isinstance(confidence, (int, float)):
            return False
        return float(confidence) < float(self.config.reflection_min_confidence)

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

    def middleware_status(self) -> list[dict[str, Any]]:
        """Return status of all middlewares (for API/observability)."""
        return self.middleware_chain.status()
