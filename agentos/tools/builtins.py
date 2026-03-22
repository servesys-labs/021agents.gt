"""Built-in tool handlers for AgentOS bundled tools.

These provide real implementations for the tools shipped in the tools/ directory.
When a tool JSON has no Python handler, these are used as fallbacks.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _agents_dir() -> Path:
    """Resolve the agents directory from cwd."""
    d = Path.cwd() / "agents"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _tools_dir() -> Path:
    """Resolve the tools directory from cwd."""
    d = Path.cwd() / "tools"
    d.mkdir(parents=True, exist_ok=True)
    return d


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web using DuckDuckGo's HTML interface.

    Returns a formatted string of search results.
    """
    import httpx

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={"User-Agent": "AgentOS/0.1.0"},
                timeout=15.0,
            )
            resp.raise_for_status()
    except Exception as exc:
        return f"Search failed: {exc}"

    # Parse results from the HTML response
    html = resp.text
    results = []
    # Extract result snippets from DuckDuckGo HTML
    import re
    # Find result links and snippets
    links = re.findall(
        r'<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)</a>',
        html,
    )
    snippets = re.findall(
        r'<a class="result__snippet"[^>]*>(.*?)</a>',
        html,
        re.DOTALL,
    )

    for i, (url, title) in enumerate(links[:max_results]):
        # Clean HTML tags from title and snippet
        clean_title = re.sub(r"<[^>]+>", "", title).strip()
        snippet = ""
        if i < len(snippets):
            snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip()
        results.append(f"{i+1}. {clean_title}\n   {url}\n   {snippet}")

    if not results:
        return f"No results found for: {query}"

    return "\n\n".join(results)


async def store_knowledge(key: str, content: str, tags: list[str] | None = None) -> str:
    """Store knowledge in the agent's semantic memory.

    This is a pass-through — the actual storage happens via the memory manager
    which is wired at a higher level. This handler returns a confirmation.
    """
    # In a real deployment, this would write to a vector DB.
    # For local use, we store in a simple JSON file.
    import os
    from pathlib import Path

    store_path = Path.cwd() / "data" / "knowledge.jsonl"
    store_path.parent.mkdir(parents=True, exist_ok=True)

    entry = {
        "key": key,
        "content": content,
        "tags": tags or [],
        "timestamp": time.time(),
    }

    with open(store_path, "a") as f:
        f.write(json.dumps(entry) + "\n")

    return f"Stored knowledge: '{key}' ({len(content)} chars)"


async def knowledge_search(query: str, top_k: int = 5) -> str:
    """Search the local knowledge store for relevant information."""
    from pathlib import Path

    store_path = Path.cwd() / "data" / "knowledge.jsonl"
    if not store_path.exists():
        return "Knowledge store is empty. Use store_knowledge to add entries."

    # Load all entries
    entries = []
    for line in store_path.read_text().strip().split("\n"):
        if line.strip():
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not entries:
        return "Knowledge store is empty."

    # Simple keyword matching
    query_words = set(query.lower().split())
    scored = []
    for entry in entries:
        text = f"{entry['key']} {entry['content']}".lower()
        score = sum(1 for w in query_words if w in text)
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:top_k]

    if not top:
        return f"No relevant knowledge found for: {query}"

    results = []
    for score, entry in top:
        results.append(f"[{entry['key']}] {entry['content'][:200]}")

    return "\n\n".join(results)


# ---------------------------------------------------------------------------
# Orchestrator tools
# ---------------------------------------------------------------------------


async def create_agent(description: str, name: str | None = None) -> str:
    """Create a new agent from a description using the AgentBuilder."""
    from agentos.builder import AgentBuilder
    from agentos.agent import save_agent_config

    builder = AgentBuilder(tools_dir=str(_tools_dir()))
    config = await builder.build_from_description(description)

    # Override name if provided
    if name:
        config.name = name

    path = save_agent_config(config, _agents_dir() / f"{config.name}.json")

    tools_list = ", ".join(config.tools) if config.tools else "(none)"
    return (
        f"Agent created: {config.name}\n"
        f"  Path: {path}\n"
        f"  Description: {config.description}\n"
        f"  Model: {config.model}\n"
        f"  Tools: {tools_list}\n"
        f"  Tags: {', '.join(config.tags)}\n\n"
        f"Next: run `eval-agent` to test it, or `evolve-agent` to start the improvement loop."
    )


async def eval_agent(agent_name: str, eval_file: str | None = None, trials: int = 3) -> str:
    """Run evaluation tasks against a named agent."""
    from agentos.agent import Agent, load_agent_config
    from agentos.eval.gym import EvalGym, EvalTask
    from agentos.eval.grader import ExactMatchGrader, ContainsGrader

    # Resolve agent
    agents_dir = _agents_dir()
    agent_path = None
    for ext in (".json", ".yaml", ".yml"):
        p = agents_dir / f"{agent_name}{ext}"
        if p.exists():
            agent_path = p
            break

    if not agent_path:
        return f"Agent '{agent_name}' not found in {agents_dir}"

    # Resolve eval file
    eval_path = Path(eval_file) if eval_file else Path.cwd() / "eval" / "smoke-test.json"
    if not eval_path.exists():
        return f"Eval file not found: {eval_path}"

    tasks_data = json.loads(eval_path.read_text())
    if not tasks_data:
        return f"No eval tasks found in {eval_path}"

    # Build gym
    graders = {"exact": ExactMatchGrader(), "contains": ContainsGrader()}
    gym = EvalGym(trials_per_task=trials)

    for t in tasks_data:
        grader_name = t.get("grader", "exact")
        gym.add_task(EvalTask(
            name=t.get("name", t.get("input", "unnamed")[:40]),
            input=t["input"],
            expected=t["expected"],
            grader=graders.get(grader_name, ExactMatchGrader()),
        ))

    # Create agent function
    config = load_agent_config(agent_path)
    agent = Agent(config)

    async def agent_fn(user_input: str) -> str:
        results = await agent.run(user_input)
        # Agent.run() returns list[TurnResult] — extract the last LLM content
        for r in reversed(results):
            if r.llm_response and r.llm_response.content:
                return r.llm_response.content
        return ""

    # Run eval
    report = await gym.run(agent_fn)

    # Format results
    lines = [
        f"Eval Report: {agent_name}",
        f"{'=' * 50}",
        f"  Tasks:       {report.total_tasks}",
        f"  Trials:      {report.total_trials}",
        f"  Pass rate:   {report.pass_rate:.1%}",
        f"  Avg score:   {report.avg_score:.2f}",
        f"  Avg latency: {report.avg_latency_ms:.0f}ms",
        f"  Total cost:  ${report.total_cost_usd:.4f}",
        f"  Tool calls:  {report.avg_tool_calls:.1f} avg",
    ]

    # Per-task breakdown
    task_results: dict[str, list] = {}
    for tr in report.trial_results:
        task_results.setdefault(tr.task_name, []).append(tr)

    lines.append(f"\nPer-task breakdown:")
    for task_name, trials_list in task_results.items():
        passed = sum(1 for t in trials_list if t.grade.passed)
        total = len(trials_list)
        lines.append(f"  {task_name}: {passed}/{total} passed")

    return "\n".join(lines)


async def evolve_agent(agent_name: str, action: str = "analyze") -> str:
    """Analyze, propose improvements, or show status for an agent."""
    from agentos.agent import load_agent_config
    from agentos.evolution.loop import EvolutionLoop

    # Resolve agent
    agents_dir = _agents_dir()
    agent_path = None
    for ext in (".json", ".yaml", ".yml"):
        p = agents_dir / f"{agent_name}{ext}"
        if p.exists():
            agent_path = p
            break

    if not agent_path:
        return f"Agent '{agent_name}' not found in {agents_dir}"

    config = load_agent_config(agent_path)
    loop = EvolutionLoop(agent_config=config)

    if action == "status":
        status = loop.status()
        lines = [
            f"Evolution Status: {agent_name} (v{config.version})",
            f"{'=' * 50}",
        ]
        obs = status.get("observer", {})
        lines.append(f"  Sessions observed: {obs.get('total_sessions', 0)}")
        lines.append(f"  Success rate:      {obs.get('success_rate', 0):.1%}")
        lines.append(f"  Total cost:        ${obs.get('total_cost', 0):.4f}")

        rq = status.get("review_queue", {})
        lines.append(f"  Pending proposals: {rq.get('pending', 0)}")
        lines.append(f"  Applied changes:   {rq.get('applied', 0)}")

        timeline = status.get("evolution_timeline", [])
        if timeline:
            lines.append(f"\nEvolution timeline:")
            for entry in timeline[-5:]:  # Last 5 entries
                lines.append(f"  v{entry.get('version', '?')}: {entry.get('title', '?')}")

        return "\n".join(lines)

    elif action == "propose":
        report = loop.analyze()
        proposals = loop.propose(report)
        if not proposals:
            return (
                f"No proposals generated for {agent_name}.\n"
                f"Analysis: {report.total_sessions} sessions, "
                f"{report.success_rate:.0%} success rate.\n"
                f"Recommendations: {'; '.join(report.recommendations) if report.recommendations else 'None'}"
            )
        return loop.show_proposals()

    else:  # analyze
        report = loop.analyze()
        lines = [
            f"Analysis Report: {agent_name}",
            f"{'=' * 50}",
            f"  Sessions analyzed:  {report.total_sessions}",
            f"  Success rate:       {report.success_rate:.1%}",
        ]

        if report.failure_clusters:
            lines.append(f"\nFailure clusters:")
            for cluster in report.failure_clusters[:5]:
                lines.append(
                    f"  [{cluster.severity:.0%} severity] "
                    f"{cluster.error_source}/{cluster.tool_name or 'general'}: "
                    f"{cluster.count} occurrences"
                )

        if report.cost_anomalies:
            lines.append(f"\nCost anomalies: {len(report.cost_anomalies)} sessions with >3x avg cost")

        if report.unused_tools:
            lines.append(f"\nUnused tools: {', '.join(report.unused_tools)}")

        if report.tool_failure_rates:
            lines.append(f"\nTool failure rates:")
            for tool, rate in sorted(report.tool_failure_rates.items(), key=lambda x: -x[1]):
                lines.append(f"  {tool}: {rate:.0%}")

        if report.recommendations:
            lines.append(f"\nRecommendations:")
            for rec in report.recommendations:
                lines.append(f"  • {rec}")

        return "\n".join(lines)


async def list_agents_handler() -> str:
    """List all agent definitions in the project."""
    from agentos.agent import list_agents

    agents = list_agents(str(_agents_dir()))
    if not agents:
        return "No agents found. Use `create-agent` to create one."

    lines = [f"Agents ({len(agents)}):"]
    lines.append("-" * 50)
    for a in agents:
        tools_str = f" [{len(a.tools)} tools]" if a.tools else ""
        tags_str = f" ({', '.join(a.tags)})" if a.tags else ""
        lines.append(f"  {a.name}{tools_str}{tags_str}")
        if a.description:
            lines.append(f"    {a.description[:80]}")

    return "\n".join(lines)


async def list_tools_handler() -> str:
    """List all available tool plugins in the project."""
    from agentos.tools.registry import ToolRegistry

    registry = ToolRegistry(str(_tools_dir()))
    plugins = registry.list_all()

    if not plugins:
        return "No tools found in tools/ directory."

    lines = [f"Available tools ({len(plugins)}):"]
    lines.append("-" * 50)
    for p in plugins:
        handler_status = "handler" if p.handler else "no handler"
        lines.append(f"  {p.name} ({handler_status})")
        if p.description:
            lines.append(f"    {p.description[:80]}")

    return "\n".join(lines)


# Registry of built-in handlers keyed by tool name
BUILTIN_HANDLERS: dict[str, Any] = {
    "web-search": web_search,
    "store-knowledge": store_knowledge,
    "knowledge-search": knowledge_search,
    "create-agent": create_agent,
    "eval-agent": eval_agent,
    "evolve-agent": evolve_agent,
    "list-agents": list_agents_handler,
    "list-tools": list_tools_handler,
}
