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


async def create_agent(description: str, name: str | None = None, tools: list[str] | None = None) -> str:
    """Create a new agent from a description using the AgentBuilder.

    Args:
        description: What the agent should do
        name: Optional name override
        tools: Optional list of tool names. If not provided, tools are auto-detected from description.
    """
    from agentos.builder import AgentBuilder, recommend_tools
    from agentos.agent import save_agent_config

    builder = AgentBuilder(tools_dir=str(_tools_dir()))
    config = await builder.build_from_description(description)

    # Override name if provided
    if name:
        config.name = name

    # Apply tool override or auto-detect
    if tools is not None:
        config.tools = tools
    elif not config.tools:
        # Auto-detect tools from description if builder didn't assign any
        config.tools = recommend_tools(description)

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


# ---------------------------------------------------------------------------
# Practical tools — bash, file ops, search, planning
# ---------------------------------------------------------------------------

async def bash_exec(command: str, timeout_seconds: int = 30) -> str:
    """Execute a shell command and return stdout + stderr.

    Capped at 30s by default. Returns exit code, stdout, stderr.
    """
    import asyncio
    import shlex

    # Safety: block obviously destructive commands
    dangerous = ["rm -rf /", "mkfs", "dd if=", ":(){", "fork bomb"]
    cmd_lower = command.lower()
    for d in dangerous:
        if d in cmd_lower:
            return f"Blocked: command contains dangerous pattern '{d}'"

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            proc.kill()
            return f"Command timed out after {timeout_seconds}s"

        out = stdout.decode(errors="replace")[:10000]
        err = stderr.decode(errors="replace")[:5000]
        result = f"[exit code: {proc.returncode}]\n"
        if out.strip():
            result += f"stdout:\n{out}\n"
        if err.strip():
            result += f"stderr:\n{err}\n"
        return result.strip()
    except Exception as exc:
        return f"Error executing command: {exc}"


async def read_file(path: str, offset: int = 0, limit: int = 200) -> str:
    """Read a file and return its contents with line numbers.

    Args:
        path: File path (relative to cwd or absolute)
        offset: Line number to start from (0-based)
        limit: Maximum number of lines to read
    """
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        if not p.exists():
            return f"File not found: {path}"
        if not p.is_file():
            return f"Not a file: {path}"
        if p.stat().st_size > 5_000_000:
            return f"File too large ({p.stat().st_size:,} bytes). Use offset/limit to read portions."

        lines = p.read_text(errors="replace").splitlines()
        total = len(lines)
        selected = lines[offset:offset + limit]
        numbered = [f"{i + offset + 1:4d} | {line}" for i, line in enumerate(selected)]
        header = f"File: {path} ({total} lines total, showing {offset + 1}-{offset + len(selected)})\n"
        return header + "\n".join(numbered)
    except Exception as exc:
        return f"Error reading file: {exc}"


async def write_file(path: str, content: str) -> str:
    """Write content to a file. Creates parent directories if needed."""
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return f"Written {len(content)} bytes to {path}"
    except Exception as exc:
        return f"Error writing file: {exc}"


async def edit_file(path: str, old_string: str, new_string: str) -> str:
    """Replace a string in a file. The old_string must appear exactly once."""
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        if not p.exists():
            return f"File not found: {path}"

        content = p.read_text()
        count = content.count(old_string)
        if count == 0:
            return f"String not found in {path}. No changes made."
        if count > 1:
            return f"String found {count} times in {path}. Provide more context to make it unique."

        new_content = content.replace(old_string, new_string, 1)
        p.write_text(new_content)
        return f"Edited {path}: replaced 1 occurrence ({len(old_string)} chars → {len(new_string)} chars)"
    except Exception as exc:
        return f"Error editing file: {exc}"


async def grep_search(pattern: str, path: str = ".", file_glob: str = "", max_results: int = 20) -> str:
    """Search file contents for a regex pattern.

    Args:
        pattern: Regex pattern to search for
        path: Directory or file to search in
        file_glob: Optional glob filter (e.g., '*.py', '*.ts')
        max_results: Maximum matches to return
    """
    import re

    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p

        if p.is_file():
            files = [p]
        elif p.is_dir():
            if file_glob:
                files = sorted(p.rglob(file_glob))
            else:
                files = sorted(p.rglob("*"))
        else:
            return f"Path not found: {path}"

        regex = re.compile(pattern)
        results: list[str] = []
        for f in files:
            if not f.is_file() or f.stat().st_size > 2_000_000:
                continue
            try:
                for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
                    if regex.search(line):
                        results.append(f"{f}:{i}: {line[:200]}")
                        if len(results) >= max_results:
                            break
            except Exception:
                continue
            if len(results) >= max_results:
                break

        if not results:
            return f"No matches for '{pattern}' in {path}"
        return f"Found {len(results)} match(es):\n" + "\n".join(results)
    except re.error as exc:
        return f"Invalid regex pattern: {exc}"
    except Exception as exc:
        return f"Error searching: {exc}"


async def glob_find(pattern: str, path: str = ".") -> str:
    """Find files matching a glob pattern.

    Args:
        pattern: Glob pattern (e.g., '**/*.py', 'src/**/*.ts')
        path: Base directory to search from
    """
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        if not p.is_dir():
            return f"Directory not found: {path}"

        matches = sorted(p.glob(pattern))[:100]
        if not matches:
            return f"No files matching '{pattern}' in {path}"

        lines = [f"Found {len(matches)} file(s):"]
        for m in matches:
            rel = m.relative_to(p) if m.is_relative_to(p) else m
            size = m.stat().st_size if m.is_file() else 0
            lines.append(f"  {rel} ({size:,} bytes)" if m.is_file() else f"  {rel}/")
        return "\n".join(lines)
    except Exception as exc:
        return f"Error finding files: {exc}"


async def python_exec(code: str, timeout_seconds: int = 30) -> str:
    """Execute Python code and return the output.

    The code runs in a subprocess with stdout/stderr captured.
    Use print() to produce output. The code can import standard libraries.
    """
    import asyncio
    import tempfile

    # Write code to a temp file for clean execution
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        proc = await asyncio.create_subprocess_exec(
            "python3", tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            proc.kill()
            return f"Code execution timed out after {timeout_seconds}s"

        out = stdout.decode(errors="replace")[:10000]
        err = stderr.decode(errors="replace")[:5000]
        result = f"[exit code: {proc.returncode}]\n"
        if out.strip():
            result += f"Output:\n{out}\n"
        if err.strip():
            result += f"Errors:\n{err}\n"
        if not out.strip() and not err.strip():
            result += "(no output)\n"
        return result.strip()
    except Exception as exc:
        return f"Error executing code: {exc}"
    finally:
        Path(tmp_path).unlink(missing_ok=True)


async def http_request(url: str, method: str = "GET", headers: dict[str, str] | None = None,
                       body: str = "", timeout_seconds: int = 30) -> str:
    """Make an HTTP request and return the response.

    Args:
        url: The URL to request
        method: HTTP method (GET, POST, PUT, DELETE, PATCH)
        headers: Optional request headers
        body: Optional request body (for POST/PUT/PATCH)
        timeout_seconds: Request timeout
    """
    import httpx

    method = method.upper()
    if method not in ("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"):
        return f"Invalid HTTP method: {method}"
    try:
        _ensure_public_http_url(url)
    except ValueError as exc:
        return f"Blocked URL: {exc}"

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            kwargs: dict[str, Any] = {"headers": headers or {}}
            if body and method in ("POST", "PUT", "PATCH"):
                kwargs["content"] = body
                if "content-type" not in {k.lower() for k in (headers or {})}:
                    kwargs["headers"]["Content-Type"] = "application/json"

            resp = await client.request(method, url, **kwargs)

        # Format response
        body_text = resp.text[:10000]
        result = f"[{resp.status_code} {resp.reason_phrase}]\n"
        result += f"Content-Type: {resp.headers.get('content-type', 'unknown')}\n"
        result += f"Content-Length: {len(resp.content)}\n\n"
        result += body_text
        return result
    except httpx.TimeoutException:
        return f"Request timed out after {timeout_seconds}s"
    except Exception as exc:
        return f"HTTP request failed: {exc}"


async def run_agent(agent_name: str, task: str, max_turns: int = 10,
                    _parent_trace_id: str = "", _parent_session_id: str = "", _parent_depth: int = 0) -> str:
    """Run another agent as a sub-agent and return its output.

    This enables hierarchical agent workflows where a parent agent can
    delegate tasks to specialized child agents. Trace context is automatically
    propagated for audit/compliance.

    Args:
        agent_name: Name of the agent to invoke (must exist in agents/)
        task: The task/input to give the sub-agent
        max_turns: Max turns for the sub-agent (prevents runaway)
    """
    try:
        from agentos.agent import Agent

        agent = Agent.from_name(agent_name)
        harness = agent._harness
        original_config = harness.config
        original_trace_id = harness.trace_id
        original_parent_session_id = harness.parent_session_id
        original_depth = harness.depth

        # Cap sub-agent turns to prevent infinite chains
        if harness.config.max_turns > max_turns:
            harness.config = type(harness.config)(
                max_turns=max_turns,
                timeout_seconds=harness.config.timeout_seconds,
                retry_on_tool_failure=harness.config.retry_on_tool_failure,
                max_retries=harness.config.max_retries,
            )

        # Propagate trace context for audit trail
        if _parent_trace_id:
            harness.trace_id = _parent_trace_id
            harness.parent_session_id = _parent_session_id
            harness.depth = _parent_depth + 1

        try:
            results = await agent.run(task)
        finally:
            # Restore original harness state so subsequent runs are isolated.
            harness.config = original_config
            harness.trace_id = original_trace_id
            harness.parent_session_id = original_parent_session_id
            harness.depth = original_depth

        # Extract the final output
        output = ""
        total_turns = len(results)
        total_tool_calls = 0
        total_cost = 0.0
        for r in results:
            if r.llm_response and r.llm_response.content:
                output = r.llm_response.content
            total_tool_calls += len(r.tool_results)
            total_cost += r.cost_usd

        return (
            f"[Sub-agent '{agent_name}' completed]\n"
            f"  Turns: {total_turns} | Tool calls: {total_tool_calls} | Cost: ${total_cost:.4f}\n\n"
            f"{output}"
        )
    except FileNotFoundError:
        return f"Agent '{agent_name}' not found. Use 'list-agents' to see available agents."
    except Exception as exc:
        return f"Sub-agent '{agent_name}' failed: {exc}"


async def browse_page(url: str, extract: str = "text", selector: str = "") -> str:
    """Fetch a web page and extract content.

    Renders the page via HTTP (no JavaScript). For JS-heavy pages, use
    the E2B sandbox with a headless browser.

    Args:
        url: URL to fetch
        extract: What to extract — 'text' (readable text), 'html' (raw HTML), 'links' (all links)
        selector: Optional CSS-like filter (e.g., 'title', 'h1', 'p', 'a')
    """
    import httpx
    import re

    try:
        _ensure_public_http_url(url)
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; AgentOS/0.2.0)",
            })
            resp.raise_for_status()

        html = resp.text

        if extract == "html":
            if selector:
                # Simple tag extraction
                pattern = f"<{selector}[^>]*>(.*?)</{selector}>"
                matches = re.findall(pattern, html, re.DOTALL | re.IGNORECASE)
                return "\n".join(_strip_tags(m) for m in matches[:20]) or f"No <{selector}> tags found"
            return html[:15000]

        if extract == "links":
            links = re.findall(r'href="(https?://[^"]+)"', html)
            unique = list(dict.fromkeys(links))[:50]
            return f"Found {len(unique)} links:\n" + "\n".join(f"  {l}" for l in unique)

        # Default: extract readable text
        # Strip script/style tags
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
        # Strip remaining HTML tags
        text = _strip_tags(text)
        # Collapse whitespace
        text = re.sub(r"\s+", " ", text).strip()

        if selector:
            # Extract text from specific tags before stripping
            pattern = f"<{selector}[^>]*>(.*?)</{selector}>"
            matches = re.findall(pattern, html, re.DOTALL | re.IGNORECASE)
            if matches:
                return "\n".join(_strip_tags(m).strip() for m in matches[:20])
            return f"No <{selector}> tags found on page"

        return text[:10000] if text else "(empty page)"

    except httpx.TimeoutException:
        return f"Page load timed out: {url}"
    except Exception as exc:
        return f"Failed to load page: {exc}"


def _strip_tags(html: str) -> str:
    """Remove HTML tags from a string."""
    import re
    return re.sub(r"<[^>]+>", "", html)


def _ensure_public_http_url(url: str) -> None:
    """Reject non-http(s) and obvious local/private network URLs."""
    import ipaddress
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in {"http", "https"} or not host:
        raise ValueError("URL must be valid http(s)")
    if host in {"localhost"} or host.endswith(".local") or host.endswith(".internal"):
        raise ValueError("local/internal hosts are not allowed")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Non-IP hostnames are allowed.
        return
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
        raise ValueError("private/loopback IPs are not allowed")


async def a2a_send(url: str, message: str, agent_name: str = "") -> str:
    """Send a message to an external A2A-compatible agent.

    This enables communication with agents built in any framework
    (LangChain, CrewAI, AutoGen, AWS Bedrock, etc.) via the A2A protocol.

    Args:
        url: Base URL of the A2A agent (e.g., https://agent.example.com)
        message: Message text to send
        agent_name: Optional name of specific agent on multi-agent servers
    """
    try:
        _ensure_public_http_url(url)
        from agentos.a2a.client import A2AClient

        client = A2AClient(base_url=url)

        # Try to discover the agent first
        try:
            card = await client.discover()
            agent_desc = card.get("description", card.get("name", "unknown"))
        except Exception:
            agent_desc = "unknown"

        # Send message
        response_text = await client.send_and_get_text(message, agent_name=agent_name)

        return (
            f"[A2A Response from {agent_desc}]\n\n"
            f"{response_text}"
        )
    except Exception as exc:
        return f"A2A communication failed: {exc}"


async def connector_call(tool_name: str, app: str = "", arguments: dict[str, Any] | None = None) -> str:
    """Call an external app/API via the connector hub (Pipedream).

    Access 3,000+ apps (Slack, GitHub, Notion, Google, Linear, etc.)
    without building individual integrations. OAuth is managed automatically.

    Args:
        tool_name: The tool to call (e.g., 'slack_send_message', 'github_create_issue')
        app: App filter (e.g., 'slack', 'github') — helps find the right tool
        arguments: Arguments for the tool call
    """
    import os
    try:
        from agentos.connectors.hub import ConnectorHub

        hub = ConnectorHub(
            provider=os.environ.get("CONNECTOR_PROVIDER", "pipedream"),
            project_id=os.environ.get("PIPEDREAM_PROJECT_ID", ""),
            client_id=os.environ.get("PIPEDREAM_CLIENT_ID", ""),
            client_secret=os.environ.get("PIPEDREAM_CLIENT_SECRET", ""),
            environment=os.environ.get("PIPEDREAM_ENVIRONMENT", "production"),
        )

        # Billing tracked inside ConnectorHub.call_tool() automatically
        result = await hub.call_tool(tool_name, arguments or {}, app=app)

        if result.auth_required:
            return (
                f"Authentication required for this app.\n"
                f"Connect your account: {result.auth_url}\n"
                f"Then retry the tool call."
            )

        if not result.success:
            return f"Connector error: {result.error}"

        return f"[Connector Result]\n{result.data}"

    except Exception as exc:
        return f"Connector call failed: {exc}"


async def sandbox_exec(command: str, sandbox_id: str = "", timeout_ms: int = 30000) -> str:
    """Execute a shell command in a secure sandbox."""
    try:
        from agentos.sandbox.tools import handle_sandbox_tool

        result = await handle_sandbox_tool(
            "sandbox_exec",
            {"command": command, "sandbox_id": sandbox_id or None, "timeout_ms": timeout_ms},
        )
        return json.dumps(result, indent=2)
    except Exception as exc:
        return f"Sandbox exec failed: {exc}"


async def sandbox_file_write(path: str, content: str, sandbox_id: str = "") -> str:
    """Write a file inside a secure sandbox."""
    try:
        from agentos.sandbox.tools import handle_sandbox_tool

        result = await handle_sandbox_tool(
            "sandbox_file_write",
            {"path": path, "content": content, "sandbox_id": sandbox_id or None},
        )
        return json.dumps(result, indent=2)
    except Exception as exc:
        return f"Sandbox file write failed: {exc}"


async def sandbox_file_read(path: str, sandbox_id: str = "") -> str:
    """Read a file from a secure sandbox."""
    try:
        from agentos.sandbox.tools import handle_sandbox_tool

        result = await handle_sandbox_tool(
            "sandbox_file_read",
            {"path": path, "sandbox_id": sandbox_id or None},
        )
        return json.dumps(result, indent=2)
    except Exception as exc:
        return f"Sandbox file read failed: {exc}"


async def sandbox_kill(sandbox_id: str) -> str:
    """Terminate a secure sandbox session."""
    try:
        from agentos.sandbox.tools import handle_sandbox_tool

        result = await handle_sandbox_tool("sandbox_kill", {"sandbox_id": sandbox_id})
        return json.dumps(result, indent=2)
    except Exception as exc:
        return f"Sandbox kill failed: {exc}"


# In-memory todo list for agent planning
_todo_items: dict[str, list[dict[str, Any]]] = {}


async def todo(action: str, text: str = "", item_id: int = 0, status: str = "") -> str:
    """Manage a task/todo list for planning and tracking work.

    Args:
        action: 'add', 'list', 'update', 'complete', or 'clear'
        text: Task description (for 'add' and 'update')
        item_id: Task ID (for 'update' and 'complete')
        status: New status (for 'update': 'pending', 'in_progress', 'done')
    """
    # Use a per-session key based on cwd
    key = str(Path.cwd())
    if key not in _todo_items:
        _todo_items[key] = []
    items = _todo_items[key]

    if action == "add":
        if not text:
            return "Error: 'text' required for add"
        item = {"id": len(items) + 1, "text": text, "status": "pending"}
        items.append(item)
        return f"Added task #{item['id']}: {text}"

    elif action == "list":
        if not items:
            return "No tasks. Use todo(action='add', text='...') to create one."
        lines = ["Tasks:"]
        for item in items:
            marker = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}.get(item["status"], "[ ]")
            lines.append(f"  {marker} #{item['id']}: {item['text']}")
        pending = sum(1 for i in items if i["status"] == "pending")
        done = sum(1 for i in items if i["status"] == "done")
        lines.append(f"\n{done}/{len(items)} completed, {pending} pending")
        return "\n".join(lines)

    elif action == "complete":
        for item in items:
            if item["id"] == item_id:
                item["status"] = "done"
                return f"Completed task #{item_id}: {item['text']}"
        return f"Task #{item_id} not found"

    elif action == "update":
        for item in items:
            if item["id"] == item_id:
                if text:
                    item["text"] = text
                if status:
                    item["status"] = status
                return f"Updated task #{item_id}: {item['text']} [{item['status']}]"
        return f"Task #{item_id} not found"

    elif action == "clear":
        count = len(items)
        _todo_items[key] = []
        return f"Cleared {count} tasks"

    return f"Unknown action: {action}. Use 'add', 'list', 'update', 'complete', or 'clear'."


# ---------------------------------------------------------------------------
# Multimodal tools — image gen, TTS, STT via GMI Cloud
# ---------------------------------------------------------------------------

async def image_generate(prompt: str, model: str = "", size: str = "1024x1024",
                         num_images: int = 1) -> str:
    """Generate images via GMI Cloud (Nano Banana 2, Seedream, GLM-Image, FLUX, etc.).

    Returns a JSON array of image URLs or base64 data.
    """
    import httpx
    import os

    api_key = os.environ.get("GMI_API_KEY", "")
    if not api_key:
        return "Error: GMI_API_KEY not configured. Set it to use image generation."

    api_base = os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
    model = model or os.environ.get("DEFAULT_IMAGE_MODEL", "Seedream-5.0-lite")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{api_base}/images/generations",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "prompt": prompt,
                    "n": min(num_images, 4),
                    "size": size,
                },
            )
            if resp.status_code != 200:
                return f"Image generation failed ({resp.status_code}): {resp.text[:300]}"

            data = resp.json()
            images = data.get("data", [])
            results = []
            for img in images:
                url = img.get("url", "")
                if url:
                    results.append(url)
                elif img.get("b64_json"):
                    results.append(f"[base64 image, {len(img['b64_json'])} chars]")
            return json.dumps({"images": results, "model": model, "count": len(results)})
    except Exception as exc:
        return f"Image generation error: {exc}"


async def text_to_speech(text: str, model: str = "", voice: str = "default") -> str:
    """Convert text to speech via GMI Cloud (ElevenLabs, MiniMax TTS, Inworld, etc.).

    Returns path to the generated audio file or base64 audio data.
    """
    import httpx
    import os

    api_key = os.environ.get("GMI_API_KEY", "")
    if not api_key:
        return "Error: GMI_API_KEY not configured. Set it to use text-to-speech."

    api_base = os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
    model = model or os.environ.get("DEFAULT_TTS_MODEL", "minimax-tts-speech-2.6-turbo")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{api_base}/audio/speech",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "input": text[:5000],
                    "voice": voice,
                },
            )
            if resp.status_code != 200:
                return f"TTS failed ({resp.status_code}): {resp.text[:300]}"

            # Save audio to file
            audio_path = Path.cwd() / "data" / f"tts_{int(time.time())}.mp3"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(resp.content)
            return json.dumps({
                "audio_file": str(audio_path),
                "model": model,
                "voice": voice,
                "size_bytes": len(resp.content),
                "text_length": len(text),
            })
    except Exception as exc:
        return f"TTS error: {exc}"


async def speech_to_text(audio_path: str, model: str = "", language: str = "") -> str:
    """Transcribe audio to text via GMI Cloud (Whisper, etc.).

    Accepts a path to an audio file (mp3, wav, m4a, webm, etc.).
    """
    import httpx
    import os

    api_key = os.environ.get("GMI_API_KEY", "")
    if not api_key:
        return "Error: GMI_API_KEY not configured. Set it to use speech-to-text."

    api_base = os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
    model = model or os.environ.get("DEFAULT_STT_MODEL", "whisper-large-v3")

    audio_file = Path(audio_path)
    if not audio_file.exists():
        return f"Error: Audio file not found: {audio_path}"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            files = {"file": (audio_file.name, audio_file.read_bytes())}
            data_fields: dict[str, str] = {"model": model}
            if language:
                data_fields["language"] = language

            resp = await client.post(
                f"{api_base}/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data=data_fields,
            )
            if resp.status_code != 200:
                return f"STT failed ({resp.status_code}): {resp.text[:300]}"

            result = resp.json()
            return json.dumps({
                "text": result.get("text", ""),
                "model": model,
                "language": result.get("language", language),
                "duration": result.get("duration", 0),
            })
    except Exception as exc:
        return f"STT error: {exc}"


async def autoresearch(
    agent_name: str,
    action: str = "run",
    eval_file: str | None = None,
    max_iterations: int = 10,
    metric: str = "pass_rate",
    apply_best: bool = False,
) -> str:
    """Autonomous agent self-improvement via the autoresearch loop.

    The agent can call this tool to improve itself (or another agent) by
    running the autoresearch loop: an LLM proposes modifications to the
    agent config, evaluates them on eval tasks, and keeps improvements.

    Actions:
      run     — Run the autoresearch loop (requires eval_file)
      status  — Show current autoresearch results for the agent
      results — Show experiment history
    """
    from agentos.agent import Agent, load_agent_config
    from agentos.autoresearch.results import ResultsLog

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

    if action == "status":
        results_path = Path("data") / "autoresearch" / agent_name / "results.tsv"
        if not results_path.exists():
            return f"No autoresearch results found for '{agent_name}'. Run with action='run' first."
        log = ResultsLog(results_path)
        return log.summary()

    elif action == "results":
        results_path = Path("data") / "autoresearch" / agent_name / "results.tsv"
        if not results_path.exists():
            return f"No autoresearch results found for '{agent_name}'."
        log = ResultsLog(results_path)
        records = log.records()
        if not records:
            return "No experiments recorded."
        lines = [f"{'commit':<10} {'score':>8} {'status':<9} description"]
        lines.append("-" * 60)
        for r in records[-20:]:
            score_str = f"{r.val_bpb:.3f}" if r.val_bpb > 0 else "  ---"
            lines.append(f"{r.commit:<10} {score_str:>8} {r.status.value:<9} {r.description}")
        return "\n".join(lines)

    elif action == "run":
        # Load eval tasks
        if not eval_file:
            # Try default locations
            for candidate in [
                Path.cwd() / "eval" / "smoke-test.json",
                Path.cwd() / "eval" / f"{agent_name}.json",
                Path.cwd() / "eval_tasks.json",
            ]:
                if candidate.exists():
                    eval_file = str(candidate)
                    break

        if not eval_file:
            return (
                "No eval_file provided and no default eval tasks found. "
                "Create an eval file (e.g., eval/smoke-test.json) with format: "
                '[{"name": "task1", "input": "question", "expected": "answer", "grader": "contains"}]'
            )

        eval_path = Path(eval_file)
        if not eval_path.exists():
            return f"Eval file not found: {eval_path}"

        eval_tasks = json.loads(eval_path.read_text())
        if not eval_tasks:
            return f"No eval tasks found in {eval_path}"

        # Build and run the autoresearch loop
        from agentos.autoresearch.agent_research import AgentResearchLoop

        config = load_agent_config(agent_path)
        agent = Agent(config)

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=eval_tasks,
            primary_metric=metric,
            max_iterations=max_iterations,
        )

        cost = loop.estimate_cost()
        summary = await loop.run()

        # Format results
        lines = [
            f"Autoresearch Report: {agent_name}",
            f"{'=' * 50}",
            f"  Est. cost:     ~${cost['estimated_total_usd']:.2f} ({cost['total_llm_calls']} LLM calls)",
            f"  Iterations:    {summary['iterations']}",
            f"  Baseline:      {summary['baseline_score']:.3f}",
            f"  Best {metric}: {summary['best_score']:.3f}",
            f"  Kept:          {summary['improvements_kept']}",
            f"  Discarded:     {summary['experiments_discarded']}",
        ]

        if summary.get("history"):
            lines.append(f"\nExperiment history:")
            for exp in summary["history"]:
                icon = "+" if exp["status"] == "keep" else "-"
                lines.append(
                    f"  [{icon}] #{exp['iteration']}: {exp['description']} "
                    f"({metric}={exp['score']:.3f}, delta={exp['improvement']:+.3f})"
                )

        if apply_best and summary["improvements_kept"] > 0:
            best_config = loop.apply_best()
            lines.append(f"\nApplied best config → agents/{best_config.name}.json v{best_config.version}")
        elif summary["improvements_kept"] > 0:
            lines.append(f"\nTip: Call with apply_best=true to save the best config.")

        return "\n".join(lines)

    else:
        return f"Unknown action: {action}. Use 'run', 'status', or 'results'."


async def dynamic_exec(code: str, language: str = "javascript", timeout_ms: int = 10000) -> str:
    """Execute JavaScript/TypeScript code in a secure Cloudflare Dynamic Worker sandbox.

    Runs in an isolated V8 isolate with sub-10ms cold start. Use console.log() for output.
    This is the preferred code execution tool — faster, cheaper, and more secure than
    bash or python-exec. Write JS/TS for computation, data transforms, API calls, and logic.

    Falls back to local Node.js subprocess if CloudflareClient is not configured.
    """
    # Auto-detect language if not specified
    if not language:
        py_signals = ["def ", "import ", "print(", "class ", "from ", "if __name__"]
        language = "python" if any(s in code for s in py_signals) else "javascript"

    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if cf:
        try:
            result = await cf.sandbox_exec(code, language=language, timeout_ms=timeout_ms)
            return json.dumps(result)
        except Exception as exc:
            return json.dumps({"error": f"CF sandbox exec failed: {exc}"})

    # Local fallback: run via subprocess
    import asyncio
    import tempfile

    runtime = "python3" if language == "python" else "node"
    suffix = ".py" if language == "python" else ".mjs"

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False) as f:
            f.write(code)
            f.flush()
            proc = await asyncio.create_subprocess_exec(
                runtime, f.name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_ms / 1000)
            except asyncio.TimeoutError:
                proc.kill()
                return json.dumps({"stdout": "", "stderr": "Timed out", "exit_code": -1})

            return json.dumps({
                "sandbox_type": f"local_{runtime}",
                "language": language,
                "stdout": stdout.decode(errors="replace"),
                "stderr": stderr.decode(errors="replace"),
                "exit_code": proc.returncode or 0,
            })
    except FileNotFoundError:
        return json.dumps({"error": f"{runtime} not found. Set AGENTOS_WORKER_URL for CF sandbox."})
    except Exception as exc:
        return json.dumps({"error": str(exc)})


async def web_crawl(url: str, max_pages: int = 5, max_depth: int = 1,
                     format: str = "markdown") -> str:
    """Crawl a website and return content as markdown (or HTML/JSON).

    Uses Cloudflare's Browser Rendering /crawl API — fast, respects robots.txt,
    returns clean markdown perfect for RAG ingestion. No browser needed.

    Falls back to basic HTTP fetch if CloudflareClient is not configured.
    """
    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if cf:
        try:
            result = await cf.browse_crawl(
                url, limit=max_pages, depth=max_depth,
                formats=["markdown"] if format == "markdown" else [format],
            )
            return json.dumps(result)
        except Exception as exc:
            return json.dumps({"error": f"Crawl request failed: {exc}"})

    # Fallback: basic HTTP fetch with HTML-to-text
    try:
        import httpx
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "AgentOS/0.1.0"})
            import re
            text = re.sub(r"<[^>]+>", "", resp.text)
            text = re.sub(r"\s+", " ", text).strip()
            return json.dumps({"pages": [{"url": url, "markdown": text[:10000]}]})
    except Exception as exc:
        return json.dumps({"error": str(exc)})


async def browser_render(url: str, action: str = "text", wait_for: str = "",
                          timeout: int = 30000) -> str:
    """Render a page with a full headless browser (Puppeteer on Cloudflare edge).

    Use when the /crawl API is blocked or the site requires JavaScript rendering,
    authentication, or anti-bot bypass. Supports: text extraction, screenshots,
    HTML capture, and link discovery.

    Falls back to basic HTTP fetch if CloudflareClient is not configured.
    """
    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if cf:
        try:
            result = await cf.browse_render(
                url, action=action,
                wait_for_selector=wait_for,
                timeout_ms=timeout,
            )
            return json.dumps(result)
        except Exception as exc:
            return json.dumps({"error": f"Browser render failed: {exc}"})

    # Fallback: basic HTTP fetch
    try:
        import httpx
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "AgentOS/0.1.0"})
            if action == "html":
                return json.dumps({"html": resp.text[:20000]})
            elif action == "links":
                import re
                links = re.findall(r'href="(https?://[^"]+)"', resp.text)
                return json.dumps({"links": [{"href": l} for l in links[:100]]})
            else:
                import re
                text = re.sub(r"<[^>]+>", "", resp.text)
                text = re.sub(r"\s+", " ", text).strip()
                return json.dumps({"text": text[:10000]})
    except Exception as exc:
        return json.dumps({"error": str(exc)})


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
    "bash": bash_exec,
    "read-file": read_file,
    "write-file": write_file,
    "edit-file": edit_file,
    "grep": grep_search,
    "glob": glob_find,
    "todo": todo,
    "python-exec": python_exec,
    "http-request": http_request,
    "run-agent": run_agent,
    "browse": browse_page,
    "a2a-send": a2a_send,
    "connector": connector_call,
    "sandbox_exec": sandbox_exec,
    "sandbox_file_write": sandbox_file_write,
    "sandbox_file_read": sandbox_file_read,
    "sandbox_kill": sandbox_kill,
    "image-generate": image_generate,
    "text-to-speech": text_to_speech,
    "speech-to-text": speech_to_text,
    "dynamic-exec": dynamic_exec,
    "web-crawl": web_crawl,
    "browser-render": browser_render,
    "autoresearch": autoresearch,
}

# ── Platform tools (security, observability, compliance, etc.) ───────────────
try:
    from agentos.tools.platform_tools import PLATFORM_HANDLERS, PLATFORM_SCHEMAS
    BUILTIN_HANDLERS.update(PLATFORM_HANDLERS)
except ImportError:
    PLATFORM_SCHEMAS = {}

# Schemas for built-in tools so the registry can expose them without JSON files
BUILTIN_SCHEMAS: dict[str, dict[str, Any]] = {
    "web-search": {
        "description": "Search the web for information",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "max_results": {"type": "integer", "description": "Maximum results to return", "default": 5},
            },
            "required": ["query"],
        },
    },
    "store-knowledge": {
        "description": "Store knowledge in the agent's semantic memory",
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Key to store the knowledge under"},
                "content": {"type": "string", "description": "Content to store"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags"},
            },
            "required": ["key", "content"],
        },
    },
    "knowledge-search": {
        "description": "Search the local knowledge store for relevant information",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "top_k": {"type": "integer", "description": "Number of results", "default": 5},
            },
            "required": ["query"],
        },
    },
    "create-agent": {
        "description": "Create a new agent from a description. Auto-assigns tools based on the task, or accepts explicit tool list.",
        "input_schema": {
            "type": "object",
            "properties": {
                "description": {"type": "string", "description": "Description of the agent to create"},
                "name": {"type": "string", "description": "Optional name for the agent"},
                "tools": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Optional list of tools to assign. Available: dynamic-exec, bash, python-exec, read-file, write-file, edit-file, grep, glob, web-search, web-crawl, browser-render, browse, http-request, store-knowledge, knowledge-search, image-generate, text-to-speech, speech-to-text, connector, todo, run-agent, a2a-send, create-agent, eval-agent, evolve-agent, autoresearch, list-agents, list-tools, sandbox_exec. If omitted, tools are auto-detected from description.",
                },
            },
            "required": ["description"],
        },
    },
    "eval-agent": {
        "description": "Run evaluation tasks against a named agent",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Name of the agent to evaluate"},
                "eval_file": {"type": "string", "description": "Path to eval tasks JSON file"},
                "trials": {"type": "integer", "description": "Number of trials per task", "default": 3},
            },
            "required": ["agent_name"],
        },
    },
    "evolve-agent": {
        "description": "Analyze, propose improvements, or show status for an agent",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Name of the agent to evolve"},
                "action": {"type": "string", "enum": ["analyze", "propose", "status"], "default": "analyze"},
            },
            "required": ["agent_name"],
        },
    },
    "list-agents": {
        "description": "List all agent definitions in the project",
        "input_schema": {"type": "object", "properties": {}},
    },
    "list-tools": {
        "description": "List all available tool plugins in the project",
        "input_schema": {"type": "object", "properties": {}},
    },
    "bash": {
        "description": "Execute a shell command and return stdout/stderr",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "timeout_seconds": {"type": "integer", "description": "Max execution time in seconds", "default": 30},
            },
            "required": ["command"],
        },
    },
    "read-file": {
        "description": "Read a file and return its contents with line numbers",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to read"},
                "offset": {"type": "integer", "description": "Starting line (0-based)", "default": 0},
                "limit": {"type": "integer", "description": "Max lines to read", "default": 200},
            },
            "required": ["path"],
        },
    },
    "write-file": {
        "description": "Write content to a file, creating parent directories if needed",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to write"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["path", "content"],
        },
    },
    "edit-file": {
        "description": "Replace a string in a file (must appear exactly once)",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to edit"},
                "old_string": {"type": "string", "description": "String to find and replace"},
                "new_string": {"type": "string", "description": "Replacement string"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    "grep": {
        "description": "Search file contents for a regex pattern",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for"},
                "path": {"type": "string", "description": "Directory or file to search", "default": "."},
                "file_glob": {"type": "string", "description": "File filter (e.g., '*.py')"},
                "max_results": {"type": "integer", "description": "Max matches to return", "default": 20},
            },
            "required": ["pattern"],
        },
    },
    "glob": {
        "description": "Find files matching a glob pattern",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern (e.g., '**/*.py')"},
                "path": {"type": "string", "description": "Base directory to search from", "default": "."},
            },
            "required": ["pattern"],
        },
    },
    "todo": {
        "description": "Manage a task list for planning and tracking work",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["add", "list", "update", "complete", "clear"], "description": "Action to perform"},
                "text": {"type": "string", "description": "Task description (for add/update)"},
                "item_id": {"type": "integer", "description": "Task ID (for update/complete)"},
                "status": {"type": "string", "enum": ["pending", "in_progress", "done"], "description": "New status (for update)"},
            },
            "required": ["action"],
        },
    },
    "python-exec": {
        "description": "Execute Python code and return the output. Use print() to produce output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python code to execute"},
                "timeout_seconds": {"type": "integer", "description": "Max execution time", "default": 30},
            },
            "required": ["code"],
        },
    },
    "http-request": {
        "description": "Make an HTTP request and return the response",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to request"},
                "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"], "default": "GET"},
                "headers": {"type": "object", "description": "Request headers"},
                "body": {"type": "string", "description": "Request body (for POST/PUT/PATCH)"},
                "timeout_seconds": {"type": "integer", "description": "Request timeout", "default": 30},
            },
            "required": ["url"],
        },
    },
    "run-agent": {
        "description": "Run another agent as a sub-agent and return its output. Enables hierarchical delegation.",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Name of the agent to invoke"},
                "task": {"type": "string", "description": "Task to give the sub-agent"},
                "max_turns": {"type": "integer", "description": "Max turns for sub-agent", "default": 10},
            },
            "required": ["agent_name", "task"],
        },
    },
    "browse": {
        "description": "Fetch a web page and extract readable text, HTML, or links",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch"},
                "extract": {"type": "string", "enum": ["text", "html", "links"], "description": "What to extract", "default": "text"},
                "selector": {"type": "string", "description": "Optional tag filter (e.g., 'h1', 'p', 'title')"},
            },
            "required": ["url"],
        },
    },
    "a2a-send": {
        "description": "Send a message to an external A2A-compatible agent (LangChain, CrewAI, AWS Bedrock, etc.)",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Base URL of the A2A agent"},
                "message": {"type": "string", "description": "Message to send"},
                "agent_name": {"type": "string", "description": "Optional agent name on multi-agent servers"},
            },
            "required": ["url", "message"],
        },
    },
    "connector": {
        "description": "Call external apps (Slack, GitHub, Notion, Google, etc.) via connector hub (3,000+ integrations)",
        "input_schema": {
            "type": "object",
            "properties": {
                "tool_name": {"type": "string", "description": "Tool to call (e.g., 'slack_send_message', 'github_create_issue')"},
                "app": {"type": "string", "description": "App filter (e.g., 'slack', 'github')"},
                "arguments": {"type": "object", "description": "Arguments for the tool"},
            },
            "required": ["tool_name"],
        },
    },
    "sandbox_exec": {
        "description": "Execute a shell command in a secure E2B sandbox",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "sandbox_id": {"type": "string", "description": "Existing sandbox ID (optional)"},
                "timeout_ms": {"type": "integer", "description": "Timeout in milliseconds", "default": 30000},
            },
            "required": ["command"],
        },
    },
    "sandbox_file_write": {
        "description": "Write a file inside the sandbox filesystem",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path inside sandbox"},
                "content": {"type": "string", "description": "File contents"},
                "sandbox_id": {"type": "string", "description": "Existing sandbox ID (optional)"},
            },
            "required": ["path", "content"],
        },
    },
    "sandbox_file_read": {
        "description": "Read a file from the sandbox filesystem",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path inside sandbox"},
                "sandbox_id": {"type": "string", "description": "Existing sandbox ID (optional)"},
            },
            "required": ["path"],
        },
    },
    "sandbox_kill": {
        "description": "Terminate a sandbox session to free resources",
        "input_schema": {
            "type": "object",
            "properties": {
                "sandbox_id": {"type": "string", "description": "Sandbox ID to terminate"},
            },
            "required": ["sandbox_id"],
        },
    },
    "image-generate": {
        "description": "Generate images from a text prompt via GMI Cloud (Nano Banana 2, Seedream, GLM-Image, FLUX)",
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Text description of the image to generate"},
                "model": {"type": "string", "description": "Model ID (e.g., 'Seedream-5.0-lite', 'gemini-3-pro-image-preview', 'GLM-Image'). Defaults to plan's image_gen model."},
                "size": {"type": "string", "description": "Image size (e.g., '1024x1024', '512x512')", "default": "1024x1024"},
                "num_images": {"type": "integer", "description": "Number of images to generate (1-4)", "default": 1},
            },
            "required": ["prompt"],
        },
    },
    "text-to-speech": {
        "description": "Convert text to speech via GMI Cloud (ElevenLabs, MiniMax TTS, Inworld). Returns audio file path.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to convert to speech"},
                "model": {"type": "string", "description": "TTS model (e.g., 'elevenlabs-tts-v3', 'minimax-tts-speech-2.6-turbo'). Defaults to plan's TTS model."},
                "voice": {"type": "string", "description": "Voice ID or name", "default": "default"},
            },
            "required": ["text"],
        },
    },
    "speech-to-text": {
        "description": "Transcribe audio to text via GMI Cloud (Whisper). Accepts mp3, wav, m4a, webm files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "audio_path": {"type": "string", "description": "Path to the audio file to transcribe"},
                "model": {"type": "string", "description": "STT model (e.g., 'whisper-large-v3'). Defaults to plan's STT model."},
                "language": {"type": "string", "description": "Language code (e.g., 'en', 'es'). Auto-detected if omitted."},
            },
            "required": ["audio_path"],
        },
    },
    "autoresearch": {
        "description": "Autonomous agent self-improvement via the autoresearch loop. Proposes config modifications (system prompt, temperature, tools, model), evaluates them on tasks, and keeps improvements. Can improve this agent or any named agent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Name of the agent to improve"},
                "action": {
                    "type": "string",
                    "enum": ["run", "status", "results"],
                    "default": "run",
                    "description": "Action: 'run' starts the loop, 'status' shows summary, 'results' shows experiment history",
                },
                "eval_file": {
                    "type": "string",
                    "description": "Path to eval tasks JSON file (required for 'run'). Format: [{name, input, expected, grader}]",
                },
                "max_iterations": {
                    "type": "integer",
                    "description": "Maximum number of experiments to run",
                    "default": 10,
                },
                "metric": {
                    "type": "string",
                    "description": "Primary metric to optimize (pass_rate, avg_score, etc.)",
                    "default": "pass_rate",
                },
                "apply_best": {
                    "type": "boolean",
                    "description": "If true, persist the best-found config to disk after the loop",
                    "default": False,
                },
            },
            "required": ["agent_name"],
        },
    },
    "web-crawl": {
        "description": "Crawl a website and return content as clean markdown. Uses Cloudflare's /crawl API — fast, respects robots.txt, perfect for RAG ingestion. No browser needed.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to crawl"},
                "max_pages": {"type": "integer", "description": "Maximum pages to crawl", "default": 5},
                "max_depth": {"type": "integer", "description": "Maximum crawl depth from start URL", "default": 1},
                "format": {"type": "string", "enum": ["markdown", "html", "json"], "description": "Output format", "default": "markdown"},
            },
            "required": ["url"],
        },
    },
    "browser-render": {
        "description": "Render a page with a full headless browser (Puppeteer). Use when web-crawl is blocked or site requires JS rendering/auth/anti-bot. Supports: text, screenshot, html, links.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to render"},
                "action": {"type": "string", "enum": ["text", "screenshot", "html", "links"], "description": "What to extract", "default": "text"},
                "wait_for": {"type": "string", "description": "CSS selector to wait for before extracting"},
                "timeout": {"type": "integer", "description": "Timeout in ms", "default": 30000},
            },
            "required": ["url"],
        },
    },
    "dynamic-exec": {
        "description": "Execute JavaScript/TypeScript in a secure Cloudflare Dynamic Worker (V8 isolate, <10ms). "
                       "PREFERRED over bash/python-exec for computation, data transforms, API calls, JSON parsing, and logic. "
                       "Use console.log() for output. Write JS — it is faster, cheaper, and more secure.",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "JavaScript or TypeScript code to execute. Use console.log() for output."},
                "timeout_ms": {"type": "integer", "description": "Execution timeout in milliseconds", "default": 10000},
            },
            "required": ["code"],
        },
    },
}

# Merge platform tool schemas
BUILTIN_SCHEMAS.update(PLATFORM_SCHEMAS)
