"""Typed runtime DAG execution primitives.

Provides a topological runner with per-node retry/timeout/budget controls,
plus basic join reducers for parallel fan-out/fan-in patterns.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable


class NodeType(str, Enum):
    PLAN = "plan"
    TOOL = "tool"
    LLM = "llm"
    REFLECT = "reflect"
    VERIFY = "verify"
    FINALIZE = "finalize"
    PARALLEL_GROUP = "parallel_group"
    JOIN = "join"


class JoinStrategy(str, Enum):
    VOTE = "vote"
    RERANK = "rerank"
    MERGE = "merge"


@dataclass
class NodePolicy:
    retries: int = 0
    timeout_ms: int = 30_000
    budget_usd: float = 0.0  # 0 means no explicit node budget


@dataclass
class NodeSpec:
    node_id: str
    node_type: NodeType
    depends_on: list[str] = field(default_factory=list)
    policy: NodePolicy = field(default_factory=NodePolicy)
    config: dict[str, Any] = field(default_factory=dict)


@dataclass
class NodeResult:
    node_id: str
    status: str
    output: Any = None
    error: str = ""
    cost_usd: float = 0.0
    attempts: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)


NodeExecutor = Callable[[NodeSpec, dict[str, NodeResult]], Awaitable[NodeResult]]


class RuntimeDAGRunner:
    """Topological DAG runner with policy checks."""

    def __init__(self, max_parallel: int = 8) -> None:
        self.max_parallel = max(1, int(max_parallel))

    async def run(
        self,
        nodes: list[NodeSpec],
        execute_node: NodeExecutor,
        total_budget_usd: float = 0.0,
    ) -> dict[str, NodeResult]:
        node_map = {n.node_id: n for n in nodes}
        self._validate(node_map)
        in_degree = {node_id: len(spec.depends_on) for node_id, spec in node_map.items()}
        dependents: dict[str, list[str]] = {node_id: [] for node_id in node_map}
        for spec in nodes:
            for dep in spec.depends_on:
                dependents[dep].append(spec.node_id)

        ready = [node_id for node_id, deg in in_degree.items() if deg == 0]
        processed = 0
        results: dict[str, NodeResult] = {}
        spent_budget = 0.0

        while ready:
            batch = ready[: self.max_parallel]
            ready = ready[self.max_parallel :]

            batch_results = await asyncio.gather(
                *(self._run_with_policy(node_map[node_id], execute_node, results, total_budget_usd, spent_budget) for node_id in batch)
            )
            for res in batch_results:
                results[res.node_id] = res
                spent_budget += max(0.0, float(res.cost_usd))
                processed += 1
                for child in dependents[res.node_id]:
                    in_degree[child] -= 1
                    if in_degree[child] == 0:
                        ready.append(child)

        if processed != len(nodes):
            unresolved = sorted(set(node_map.keys()) - set(results.keys()))
            raise RuntimeError(f"DAG did not fully execute; unresolved nodes: {unresolved}")
        return results

    async def _run_with_policy(
        self,
        spec: NodeSpec,
        execute_node: NodeExecutor,
        partial_results: dict[str, NodeResult],
        total_budget_usd: float,
        spent_budget: float,
    ) -> NodeResult:
        if total_budget_usd > 0 and spent_budget >= total_budget_usd:
            return NodeResult(
                node_id=spec.node_id,
                status="skipped_budget",
                error="Global DAG budget exhausted",
                attempts=0,
            )

        attempts = 0
        last_error = ""
        max_attempts = max(1, int(spec.policy.retries) + 1)
        while attempts < max_attempts:
            attempts += 1
            try:
                timeout_sec = max(0.001, spec.policy.timeout_ms / 1000.0)
                result = await asyncio.wait_for(
                    execute_node(spec, partial_results),
                    timeout=timeout_sec,
                )
                result.attempts = attempts
                if spec.policy.budget_usd > 0 and result.cost_usd > spec.policy.budget_usd:
                    return NodeResult(
                        node_id=spec.node_id,
                        status="failed_budget",
                        error=(
                            f"Node cost {result.cost_usd:.6f} exceeded budget "
                            f"{spec.policy.budget_usd:.6f}"
                        ),
                        cost_usd=result.cost_usd,
                        attempts=attempts,
                    )
                return result
            except asyncio.TimeoutError:
                last_error = f"Node timed out after {spec.policy.timeout_ms}ms"
            except Exception as exc:  # pragma: no cover - defensive
                last_error = str(exc)
        return NodeResult(
            node_id=spec.node_id,
            status="failed",
            error=last_error or "Node execution failed",
            attempts=attempts,
        )

    def _validate(self, node_map: dict[str, NodeSpec]) -> None:
        for node_id, spec in node_map.items():
            for dep in spec.depends_on:
                if dep not in node_map:
                    raise ValueError(f"Node '{node_id}' depends on unknown node '{dep}'")
        # cycle detection
        temp: set[str] = set()
        perm: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in perm:
                return
            if node_id in temp:
                raise ValueError(f"Cycle detected at node '{node_id}'")
            temp.add(node_id)
            for dep in node_map[node_id].depends_on:
                visit(dep)
            temp.remove(node_id)
            perm.add(node_id)

        for node_id in node_map:
            visit(node_id)


def reduce_join_outputs(strategy: JoinStrategy, outputs: list[Any]) -> Any:
    """Reduce branch outputs into a single value."""
    if not outputs:
        return ""
    if strategy == JoinStrategy.MERGE:
        return "\n\n".join(str(o) for o in outputs if o is not None).strip()
    if strategy == JoinStrategy.RERANK:
        # Lightweight placeholder: prefer longest non-empty output.
        ranked = sorted((str(o) for o in outputs if o is not None), key=len, reverse=True)
        return ranked[0] if ranked else ""
    # VOTE default: mode over normalized string outputs.
    counts: dict[str, int] = {}
    for output in outputs:
        key = str(output).strip()
        counts[key] = counts.get(key, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], -len(kv[0])))[0][0]
