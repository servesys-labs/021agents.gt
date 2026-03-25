"""Graph nodes that wrap current harness behavior for migration parity."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from agentos.core.events import Event, EventType
from agentos.core.harness import AgentHarness, TurnResult
from agentos.graph.context import GraphContext
from agentos.middleware.base import MiddlewareContext


@dataclass
class GraphTurnState:
    """Mutable execution state shared across graph nodes."""

    user_input: str
    complexity: str = "simple"
    available_tools: list[dict[str, Any]] | None = None
    initialized: bool = False
    done: bool = False
    cumulative_cost: float = 0.0
    failure_retries: int = 0
    reflection_retries: int = 0
    backlog: list[dict[str, Any]] | None = None
    tool_sequence: list[dict[str, Any]] | None = None


class HarnessSetupNode:
    node_id = "setup"

    def __init__(self, harness: AgentHarness, state: GraphTurnState):
        self.harness = harness
        self.state = state

    def should_skip(self, ctx: GraphContext) -> bool:
        return self.state.initialized

    async def execute(self, ctx: GraphContext) -> GraphContext:
        self.harness.governance.reset_for_session()
        complexity = self.harness.llm_router.classify(
            [{"role": "user", "content": self.state.user_input}]
        )
        self.state.complexity = complexity.value
        self.state.available_tools = self.harness.tool_executor.available_tools()
        self.harness.llm_router.set_tools(self.state.available_tools)
        memory_context = await self.harness.memory_manager.build_context(self.state.user_input)
        async_memory_section = ""
        if self.harness._async_memory_updater:
            async_memory_section = self.harness._async_memory_updater.memory.to_prompt_section()
        procedures_section = ""
        best_procs = self.harness.memory_manager.procedural.find_best(self.state.user_input, limit=3)
        if best_procs:
            proc_lines = []
            for p in best_procs:
                steps_str = " -> ".join(s.get("tool", "?") for s in p.steps[:5])
                proc_lines.append(f"- {p.name} ({p.success_rate:.0%} success): {steps_str}")
            procedures_section = "Learned procedures (from past successes):\n" + "\n".join(proc_lines)
        skills_section = ""
        if self.harness.config.enable_skills:
            skills_section = self.harness.skill_loader.build_prompt_section()
        system_parts: list[str] = []
        if self.harness.system_prompt:
            system_parts.append(self.harness.system_prompt)
        if skills_section:
            system_parts.append(skills_section)
        if memory_context:
            system_parts.append(memory_context)
        if async_memory_section:
            system_parts.append(async_memory_section)
        if procedures_section:
            system_parts.append(procedures_section)
        system_parts.append(self.harness._reasoning_instruction(self.harness.config.reasoning_strategy))
        ctx.messages = [{"role": "user", "content": self.state.user_input}]
        if system_parts:
            ctx.messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})
        ctx.session_state.setdefault("results", [])
        self.state.backlog = self.harness._build_initial_backlog(
            self.state.user_input, self.state.complexity
        )
        self.state.tool_sequence = []
        self.state.initialized = True
        return ctx


class GovernanceNode:
    node_id = "governance"

    def __init__(self, harness: AgentHarness):
        self.harness = harness

    def should_skip(self, ctx: GraphContext) -> bool:
        return False

    async def execute(self, ctx: GraphContext) -> GraphContext:
        # Keep policy intent explicit in graph mode; LLM node reads this flag.
        ctx.session_state["budget_blocked"] = not self.harness.governance.check_budget(0.01)
        return ctx


class LLMNode:
    node_id = "llm"

    def __init__(self, harness: AgentHarness):
        self.harness = harness

    def should_skip(self, ctx: GraphContext) -> bool:
        return False

    async def execute(self, ctx: GraphContext) -> GraphContext:
        mw_ctx = ctx.session_state.get("middleware_ctx")
        if isinstance(mw_ctx, MiddlewareContext):
            mw_ctx.messages = ctx.messages
            mw_ctx.injected_messages = []
            await self.harness.middleware_chain.run_before_model(mw_ctx)
            ctx.messages = mw_ctx.messages
            if mw_ctx.halt:
                ctx.session_state["halted"] = True
                ctx.session_state["halt_reason"] = mw_ctx.halt_reason or "Halted by middleware"
                ctx.session_state["llm_response"] = None
                return ctx
            if mw_ctx.skip_llm_call:
                mw_ctx.skip_llm_call = False
                ctx.session_state["llm_response"] = None
                ctx.session_state["skipped_llm"] = True
                return ctx

        if ctx.session_state.get("budget_blocked"):
            ctx.session_state["llm_response"] = None
            return ctx
        llm_response = await self.harness._call_llm(ctx.messages)
        if isinstance(mw_ctx, MiddlewareContext) and llm_response is not None:
            mw_ctx.llm_response = llm_response
            await self.harness.middleware_chain.run_after_model(mw_ctx)
            if mw_ctx.force_text_response and llm_response.tool_calls:
                llm_response.tool_calls = []
                mw_ctx.force_text_response = False
            for msg in mw_ctx.injected_messages:
                ctx.messages.append(msg)
            ctx.session_state["turn_warnings"] = [
                m.get("content", "")
                for m in mw_ctx.injected_messages
                if m.get("role") == "system"
            ]
            mw_ctx.injected_messages = []
        ctx.session_state["llm_response"] = llm_response
        return ctx


class ToolExecNode:
    node_id = "tools"

    def __init__(self, harness: AgentHarness):
        self.harness = harness

    def should_skip(self, ctx: GraphContext) -> bool:
        llm_response = ctx.session_state.get("llm_response")
        return not bool(llm_response and llm_response.tool_calls)

    async def execute(self, ctx: GraphContext) -> GraphContext:
        llm_response = ctx.session_state.get("llm_response")
        if llm_response is None or not llm_response.tool_calls:
            ctx.session_state["tool_results"] = []
            ctx.session_state["execution_mode"] = "sequential"
            return ctx
        tool_results = await self.harness._execute_tools(llm_response.tool_calls)
        execution_mode = (
            "parallel"
            if self.harness.config.parallel_tool_calls and len(llm_response.tool_calls) > 1
            else "sequential"
        )
        ctx.session_state["tool_results"] = tool_results
        ctx.session_state["execution_mode"] = execution_mode
        return ctx


class TurnResultNode:
    node_id = "turn_result"

    def __init__(self, harness: AgentHarness, state: GraphTurnState):
        self.harness = harness
        self.state = state

    def should_skip(self, ctx: GraphContext) -> bool:
        return self.state.done

    async def execute(self, ctx: GraphContext) -> GraphContext:
        turn_number = len(ctx.session_state["results"]) + 1
        llm_response = ctx.session_state.get("llm_response")
        turn_warnings = ctx.session_state.get("turn_warnings", [])
        if not isinstance(turn_warnings, list):
            turn_warnings = []

        if ctx.session_state.get("skipped_llm"):
            ctx.session_state["skipped_llm"] = False
            ctx.session_state["skip_turn_end"] = True
            return ctx

        if llm_response is None:
            if ctx.session_state.get("halted"):
                stop_reason = "middleware_halt"
                error_msg = str(ctx.session_state.get("halt_reason", "Halted by middleware"))
            else:
                is_budget = bool(ctx.session_state.get("budget_blocked"))
                stop_reason = "budget" if is_budget else "llm_error"
                error_msg = "Budget exhausted" if is_budget else "LLM call failed"
            result = TurnResult(
                turn_number=turn_number,
                error=error_msg,
                done=True,
                stop_reason=stop_reason,
                middleware_warnings=turn_warnings,
                cumulative_cost_usd=self.state.cumulative_cost,
            )
            ctx.session_state["results"].append(result)
            self.state.done = True
            return ctx

        self.state.cumulative_cost += llm_response.cost_usd
        tool_results = ctx.session_state.get("tool_results", [])
        has_tool_calls = bool(llm_response.tool_calls)
        execution_mode = ctx.session_state.get("execution_mode", "sequential")
        plan_artifact = self.harness._build_turn_plan_artifact(
            user_input=self.state.user_input,
            complexity=self.state.complexity,
            available_tools=self.state.available_tools or [],
            turn_number=turn_number,
            execution_mode=execution_mode,
            has_tool_calls=has_tool_calls,
            done=not has_tool_calls,
            reasoning_strategy=self.harness.config.reasoning_strategy,
            backlog=self.state.backlog or [],
        )

        if has_tool_calls:
            failed = [tr for tr in tool_results if "error" in tr]
            if self.state.tool_sequence is not None:
                self.state.tool_sequence.extend(tool_results)
            if failed and self.harness.config.retry_on_tool_failure:
                if self.state.failure_retries >= self.harness.config.max_retries:
                    error_text = (
                        "Tool failures exceeded retry limit "
                        f"({self.harness.config.max_retries})"
                    )
                    result = TurnResult(
                        turn_number=turn_number,
                        llm_response=llm_response,
                        tool_results=tool_results,
                        error=error_text,
                        done=True,
                        stop_reason="tool_error",
                        cost_usd=llm_response.cost_usd,
                        cumulative_cost_usd=self.state.cumulative_cost,
                        model_used=llm_response.model,
                        execution_mode=execution_mode,
                        plan_artifact=plan_artifact,
                        reflection=self.harness._build_reflection_artifact(
                            llm_response=llm_response,
                            tool_results=tool_results,
                            middleware_warnings=turn_warnings,
                            done=True,
                            error=error_text,
                        ),
                    )
                    ctx.session_state["results"].append(result)
                    self.state.done = True
                    return ctx
                self.state.failure_retries += 1
                error_summary = "; ".join(
                    f"{tr.get('tool', '?')}: {tr['error']}" for tr in failed
                )
                result = TurnResult(
                    turn_number=turn_number,
                    llm_response=llm_response,
                    tool_results=tool_results,
                    cost_usd=llm_response.cost_usd,
                    cumulative_cost_usd=self.state.cumulative_cost,
                    model_used=llm_response.model,
                    execution_mode=execution_mode,
                    plan_artifact=plan_artifact,
                    reflection=self.harness._build_reflection_artifact(
                        llm_response=llm_response,
                        tool_results=tool_results,
                        middleware_warnings=turn_warnings,
                        done=False,
                    ),
                )
                ctx.session_state["results"].append(result)
                ctx.messages.append({
                    "role": "assistant",
                    "content": llm_response.content,
                    "tool_calls": llm_response.tool_calls,
                })
                for tc, tr in zip(llm_response.tool_calls, tool_results):
                    ctx.messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "name": tc.get("name", ""),
                        "content": json.dumps(tr),
                    })
                ctx.messages.append({
                    "role": "system",
                    "content": f"Tool failures occurred: {error_summary}. "
                    "Analyze the error and try an alternative approach. "
                    "Do not repeat the exact same failed action.",
                })
                return ctx

            result = TurnResult(
                turn_number=turn_number,
                llm_response=llm_response,
                tool_results=tool_results,
                cost_usd=llm_response.cost_usd,
                cumulative_cost_usd=self.state.cumulative_cost,
                model_used=llm_response.model,
                middleware_warnings=turn_warnings,
                execution_mode=execution_mode,
                plan_artifact=plan_artifact,
                reflection=self.harness._build_reflection_artifact(
                    llm_response=llm_response,
                    tool_results=tool_results,
                    middleware_warnings=turn_warnings,
                    done=False,
                ),
            )
            ctx.session_state["results"].append(result)
            self.state.failure_retries = 0
            self.state.reflection_retries = 0
            ctx.messages.append({
                "role": "assistant",
                "content": llm_response.content,
                "tool_calls": llm_response.tool_calls,
            })
            for tc, tr in zip(llm_response.tool_calls, tool_results):
                ctx.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "name": tc.get("name", ""),
                    "content": json.dumps(tr),
                })
            return ctx

        reflection = self.harness._build_reflection_artifact(
            llm_response=llm_response,
            tool_results=[],
            middleware_warnings=turn_warnings,
            done=True,
        )
        if self.harness._should_retry_for_reflection(
            reflection=reflection,
            reflection_retries=self.state.reflection_retries,
            turn=turn_number,
        ):
            self.state.reflection_retries += 1
            result = TurnResult(
                turn_number=turn_number,
                llm_response=llm_response,
                done=False,
                stop_reason="reflection_retry",
                cost_usd=llm_response.cost_usd,
                cumulative_cost_usd=self.state.cumulative_cost,
                model_used=llm_response.model,
                middleware_warnings=turn_warnings,
                execution_mode="sequential",
                plan_artifact=plan_artifact,
                reflection=reflection,
            )
            ctx.session_state["results"].append(result)
            ctx.messages.append({"role": "assistant", "content": llm_response.content})
            ctx.messages.append({
                "role": "system",
                "content": (
                    "Reflection gate triggered: confidence is below threshold. "
                    "Revise your answer with clearer reasoning and verification."
                ),
            })
            self.state.backlog = self.harness._update_backlog_from_reflection(
                self.state.backlog or [],
                reflection,
            )
            return ctx

        result = TurnResult(
            turn_number=turn_number,
            llm_response=llm_response,
            done=True,
            stop_reason="completed",
            cost_usd=llm_response.cost_usd,
            cumulative_cost_usd=self.state.cumulative_cost,
            model_used=llm_response.model,
            middleware_warnings=turn_warnings,
            execution_mode="sequential",
            plan_artifact=plan_artifact,
            reflection=reflection,
        )
        ctx.session_state["results"].append(result)
        self.state.failure_retries = 0
        self.state.reflection_retries = 0
        self.state.done = True
        self.state.backlog = self.harness._update_backlog_from_reflection(
            self.state.backlog or [],
            reflection,
        )
        await self.harness.memory_manager.store_episode(self.state.user_input, llm_response.content)
        if self.harness._async_memory_updater:
            from agentos.memory.async_updater import MemoryUpdate
            self.harness._async_memory_updater.queue_update(MemoryUpdate(
                user_message=self.state.user_input,
                assistant_message=llm_response.content,
                session_id=getattr(self.harness, "_current_session_id", ""),
            ))
        if self.state.tool_sequence:
            await self.harness._store_procedure(self.state.user_input, self.state.tool_sequence)
        return ctx


class RecordNode:
    """Record per-turn side effects (callbacks, middleware turn end, events)."""

    node_id = "record"

    def __init__(self, harness: AgentHarness):
        self.harness = harness

    def should_skip(self, ctx: GraphContext) -> bool:
        return False

    async def execute(self, ctx: GraphContext) -> GraphContext:
        if ctx.session_state.pop("skip_turn_end", False):
            return ctx

        current_turn = int(ctx.session_state.get("current_turn", 0))
        previous_count = int(ctx.session_state.get("previous_results_count", 0))
        results = ctx.session_state.get("results", [])
        latest = results[-1] if isinstance(results, list) and len(results) > previous_count else None

        mw_ctx = ctx.session_state.get("middleware_ctx")
        if isinstance(mw_ctx, MiddlewareContext):
            mw_ctx.tool_results = latest.tool_results if latest else []

        if latest is not None:
            self.harness._notify_turn(latest)
            if latest.stop_reason == "middleware_halt":
                await self.harness.event_bus.emit(Event(type=EventType.MIDDLEWARE_HALT, data={
                    "turn": current_turn,
                    "reason": latest.error or "Halted by middleware",
                }))

        if isinstance(mw_ctx, MiddlewareContext):
            await self.harness.middleware_chain.run_on_turn_end(mw_ctx)

        await self.harness.event_bus.emit(Event(type=EventType.TURN_END, data={
            "turn": current_turn,
            "execution_mode": latest.execution_mode if latest else "sequential",
            "plan_artifact": latest.plan_artifact if latest else {},
            "reflection": latest.reflection if latest else {},
        }))
        return ctx
