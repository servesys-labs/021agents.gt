"""AgentOS CLI — the user-facing command line interface.

Usage:
    agentos init [dir] [--name N]   — Scaffold a new agent project (with git + CI)
    agentos init --remote <url>     — ...and connect to a git remote
    agentos create                  — Conversationally build an agent with an LLM
    agentos create --one-shot DESC  — Build an agent from a one-line description
    agentos run <name> "task"       — Run a named agent on a task
    agentos list                    — List all available agents
    agentos tools                   — List available tool plugins
    agentos deploy <name>           — Deploy an agent (Cloudflare Workers)
    agentos chat <name>             — Interactive chat session with an agent
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="agentos",
        description="AgentOS — Build, run, and deploy autonomous agents",
    )
    sub = parser.add_subparsers(dest="command")

    # --- init ---
    init_p = sub.add_parser("init", help="Scaffold a new agent project")
    init_p.add_argument("directory", nargs="?", default=".", help="Project directory")
    init_p.add_argument("--name", "-n", type=str, default=None, help="Agent name (default: directory name)")
    init_p.add_argument("--remote", "-r", type=str, default=None, help="Git remote URL to connect")
    init_p.add_argument("--no-git", action="store_true", help="Skip git repository initialization")
    init_p.add_argument("--no-signing", action="store_true", help="Skip signing keypair generation")

    # --- create ---
    create_p = sub.add_parser("create", help="Create a new agent (conversational)")
    create_p.add_argument(
        "--one-shot", "-o", type=str, default=None,
        help="Create from a one-line description (skip conversation)",
    )
    create_p.add_argument(
        "--model", "-m", type=str, default=None,
        help="LLM model for the builder agent",
    )
    create_p.add_argument(
        "--provider", type=str, default=None,
        choices=["anthropic", "openai", "stub"],
        help="LLM provider for the builder agent",
    )

    # --- run ---
    run_p = sub.add_parser("run", help="Run an agent")
    run_p.add_argument("name", help="Agent name or path to definition file")
    run_p.add_argument("task", nargs="?", help="Task to execute")
    run_p.add_argument("--turns", type=int, default=None, help="Max turns override")

    # --- list ---
    sub.add_parser("list", help="List available agents")

    # --- tools ---
    sub.add_parser("tools", help="List available tool plugins")

    # --- chat ---
    chat_p = sub.add_parser("chat", help="Interactive chat with an agent")
    chat_p.add_argument("name", help="Agent name or path")

    # --- ingest ---
    ingest_p = sub.add_parser("ingest", help="Ingest documents into RAG knowledge base")
    ingest_p.add_argument("files", nargs="+", help="Files or directories to ingest")
    ingest_p.add_argument("--chunk-size", type=int, default=512, help="Chunk size (default: 512)")

    # --- eval ---
    eval_p = sub.add_parser("eval", help="Evaluate an agent with test cases")
    eval_p.add_argument("name", help="Agent name or path")
    eval_p.add_argument("tasks_file", help="JSON file with eval tasks")
    eval_p.add_argument("--trials", type=int, default=3, help="Trials per task (default: 3)")

    # --- evolve ---
    evolve_p = sub.add_parser("evolve", help="Continuous improvement loop for an agent")
    evolve_p.add_argument("name", help="Agent name or path")
    evolve_p.add_argument("tasks_file", help="JSON file with eval tasks (for baseline)")
    evolve_p.add_argument("--trials", type=int, default=3, help="Trials per task (default: 3)")
    evolve_p.add_argument("--min-sessions", type=int, default=5, help="Min sessions before analysis")
    evolve_p.add_argument("--surface-ratio", type=float, default=0.1, help="Fraction of proposals to surface (default: 0.1)")
    evolve_p.add_argument("--export", type=str, default=None, help="Export evolution state to JSON")

    # --- deploy ---
    deploy_p = sub.add_parser("deploy", help="Deploy an agent")
    deploy_p.add_argument("name", help="Agent name or path")

    parser.add_argument("--version", "-V", action="store_true", help="Show version")

    args = parser.parse_args()

    if getattr(args, "version", False):
        from agentos import __version__
        print(f"agentos {__version__}")
        sys.exit(0)

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    try:
        if args.command == "init":
            cmd_init(args)
        elif args.command == "create":
            asyncio.run(cmd_create(args))
        elif args.command == "run":
            asyncio.run(cmd_run(args))
        elif args.command == "list":
            cmd_list(args)
        elif args.command == "tools":
            cmd_tools(args)
        elif args.command == "chat":
            asyncio.run(cmd_chat(args))
        elif args.command == "ingest":
            cmd_ingest(args)
        elif args.command == "eval":
            asyncio.run(cmd_eval(args))
        elif args.command == "evolve":
            asyncio.run(cmd_evolve(args))
        elif args.command == "deploy":
            cmd_deploy(args)
    except FileNotFoundError as exc:
        print(f"Error: {exc}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(1)
    except Exception as exc:
        print(f"Error: {exc}")
        sys.exit(1)


# ── Commands ──────────────────────────────────────────────────────────────────


def cmd_init(args: argparse.Namespace) -> None:
    """Scaffold a new agent project — identity, security, sessions, CI/CD."""
    import subprocess
    from datetime import datetime, timezone

    from agentos.core.identity import AgentIdentity, write_keypair

    directory = Path(args.directory).resolve()
    agent_name = args.name or _slugify(directory.name)
    created: list[str] = []
    skipped: list[str] = []

    print(f"Initializing AgentOS project in {directory}")
    print()

    # ── Directory structure ──────────────────────────────────────────────
    for d in ("agents", "tools", "data", "eval", "sessions"):
        dir_path = directory / d
        if dir_path.exists():
            skipped.append(f"{d}/")
        else:
            dir_path.mkdir(parents=True, exist_ok=True)
            created.append(f"{d}/")

    # ── SQLite database (the agent's persistent brain) ────────────────────
    db_path = directory / "data" / "agent.db"
    if not db_path.exists():
        from agentos.core.database import create_database
        db = create_database(db_path)
        db.close()
        created.append("data/agent.db (SQLite — WAL mode)")
    else:
        skipped.append("data/agent.db")

    # ── Agent identity (generated once, immutable) ───────────────────────
    identity_path = directory / "agents" / ".identity.json"
    if not identity_path.exists():
        identity, secret_key = AgentIdentity.generate(
            with_signing=not args.no_signing,
        )
        identity_path.write_text(json.dumps(identity.to_dict(), indent=2) + "\n")
        created.append("agents/.identity.json")
        agent_id = identity.agent_id
    else:
        # Preserve existing identity on re-init
        existing = json.loads(identity_path.read_text())
        agent_id = existing.get("agent_id", "")
        secret_key = ""  # Already written to .keys/
        skipped.append("agents/.identity.json")

    # ── Signing keypair ──────────────────────────────────────────────────
    keys_dir = directory / ".keys"
    if not args.no_signing and secret_key:
        from agentos.core.identity import AgentIdentity as _id
        identity_data = json.loads(identity_path.read_text())
        fingerprint = identity_data.get("fingerprint", "")
        if fingerprint and not (keys_dir / "agent.key").exists():
            write_keypair(keys_dir, secret_key, fingerprint)
            created.append(".keys/agent.pub (public — safe to commit)")
            created.append(".keys/agent.key (SECRET — gitignored)")
        elif (keys_dir / "agent.key").exists():
            skipped.append(".keys/ (keypair exists)")
    elif (keys_dir / "agent.key").exists():
        skipped.append(".keys/ (keypair exists)")

    # ── Project config (agentos.yaml) ────────────────────────────────────
    project_config_path = directory / "agentos.yaml"
    if not project_config_path.exists():
        init_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        project_config_path.write_text(
            f"# AgentOS project configuration\n"
            f"# Generated: {init_date}\n"
            f"\n"
            f"project: {agent_name}\n"
            f"agent_id: {agent_id}\n"
            f"version: 0.1.0\n"
            f"\n"
            f"# ── LLM defaults ─────────────────────────────────────────\n"
            f"defaults:\n"
            f"  model: claude-sonnet-4-20250514\n"
            f"  provider: anthropic\n"
            f"  max_turns: 50\n"
            f"  budget_limit_usd: 10.0\n"
            f"\n"
            f"# ── Security & access control ──────────────────────────────\n"
            f"security:\n"
            f"  # Who can invoke this agent (RBAC)\n"
            f"  allowed_callers: ['*']          # '*' = anyone, or list of caller IDs\n"
            f"  rate_limit_rpm: 60               # Max requests per minute\n"
            f"  # Network boundaries\n"
            f"  allowed_domains: []              # Empty = unrestricted\n"
            f"  blocked_domains: []              # Explicit blocklist\n"
            f"  # File system scope\n"
            f"  allowed_paths:\n"
            f"    - agents/\n"
            f"    - tools/\n"
            f"    - data/\n"
            f"  # Signing\n"
            f"  sign_outputs: false              # Enable output signing for audit\n"
            f"  signing_key: .keys/agent.key\n"
            f"\n"
            f"# ── Database ───────────────────────────────────────────────\n"
            f"database:\n"
            f"  path: data/agent.db               # SQLite — single file, zero dependencies\n"
            f"  wal_mode: true                    # WAL = concurrent readers + atomic writes\n"
            f"  # Cloudflare D1 compatible — same schema works at the edge\n"
            f"\n"
            f"# ── Session tracking ─────────────────────────────────────\n"
            f"sessions:\n"
            f"  storage: database                 # 'database' (SQLite) or 'jsonl' (flat file)\n"
            f"  retention_days: 90                # Auto-cleanup after N days (0 = forever)\n"
            f"  include_llm_content: true         # Store full LLM responses\n"
            f"  include_tool_results: true        # Store full tool outputs\n"
            f"\n"
            f"# ── Observability ──────────────────────────────────────────\n"
            f"observability:\n"
            f"  log_level: INFO                   # DEBUG | INFO | WARNING | ERROR\n"
            f"  log_format: structured            # structured (JSON) | text\n"
            f"  # Event sinks — where events are sent\n"
            f"  event_sinks:\n"
            f"    - type: file\n"
            f"      path: sessions/events.jsonl\n"
            f"    # - type: webhook\n"
            f"    #   url: https://your-observability.example.com/events\n"
            f"    #   headers:\n"
            f"    #     Authorization: Bearer ${{OBSERVABILITY_TOKEN}}\n"
            f"  # Cost tracking\n"
            f"  cost_ledger: sessions/costs.jsonl  # Persistent cost log\n"
            f"  cost_alert_usd: 50.0               # Alert when cumulative cost exceeds\n"
            f"\n"
            f"# ── Paths ────────────────────────────────────────────────\n"
            f"paths:\n"
            f"  agents: agents/\n"
            f"  tools: tools/\n"
            f"  data: data/\n"
            f"  eval: eval/\n"
            f"  database: data/agent.db\n"
        )
        created.append("agentos.yaml")
    else:
        skipped.append("agentos.yaml")

    # ── Starter agent definition ─────────────────────────────────────────
    agent_path = directory / "agents" / f"{agent_name}.json"
    if not agent_path.exists():
        starter = {
            "name": agent_name,
            "agent_id": agent_id,
            "description": f"{agent_name} — customize me!",
            "version": "0.1.0",
            "system_prompt": "You are a helpful AI assistant. Be concise and accurate.",
            "model": "claude-sonnet-4-20250514",
            "tools": [],
            "governance": {
                "budget_limit_usd": 10.0,
                "require_confirmation_for_destructive": True,
                "blocked_tools": [],
                "allowed_domains": [],
            },
            "memory": {
                "working": {"max_items": 100},
                "episodic": {"max_episodes": 10000, "ttl_days": 90},
                "procedural": {"max_procedures": 500},
            },
            "tags": ["starter"],
        }
        agent_path.write_text(json.dumps(starter, indent=2) + "\n")
        created.append(f"agents/{agent_name}.json")
    else:
        skipped.append(f"agents/{agent_name}.json")

    # ── Starter tool plugin ──────────────────────────────────────────────
    tool_path = directory / "tools" / "example-search.json"
    if not tool_path.exists():
        tool_example = {
            "name": "example-search",
            "description": "Example search tool — replace with your own implementation",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                },
                "required": ["query"],
            },
        }
        tool_path.write_text(json.dumps(tool_example, indent=2) + "\n")
        created.append("tools/example-search.json")
    else:
        skipped.append("tools/example-search.json")

    # ── Starter eval task ────────────────────────────────────────────────
    eval_path = directory / "eval" / "smoke-test.json"
    if not eval_path.exists():
        eval_task = [
            {
                "name": "greeting",
                "input": "Say hello",
                "expected": "hello",
                "grader": "contains",
            }
        ]
        eval_path.write_text(json.dumps(eval_task, indent=2) + "\n")
        created.append("eval/smoke-test.json")
    else:
        skipped.append("eval/smoke-test.json")

    # ── .env.example (declares required secrets without values) ──────────
    env_example_path = directory / ".env.example"
    if not env_example_path.exists():
        env_example_path.write_text(
            "# AgentOS environment variables\n"
            "# Copy to .env and fill in your values:\n"
            "#   cp .env.example .env\n"
            "\n"
            "# LLM provider API keys (at least one required)\n"
            "ANTHROPIC_API_KEY=\n"
            "OPENAI_API_KEY=\n"
            "\n"
            "# Observability (optional)\n"
            "OBSERVABILITY_TOKEN=\n"
            "\n"
            "# Deployment (optional)\n"
            "CLOUDFLARE_API_TOKEN=\n"
            "CLOUDFLARE_ACCOUNT_ID=\n"
        )
        created.append(".env.example")
    else:
        skipped.append(".env.example")

    # ── .gitignore ───────────────────────────────────────────────────────
    gitignore_path = directory / ".gitignore"
    if not gitignore_path.exists():
        gitignore_path.write_text(
            "# AgentOS\n"
            "data/agent.db\n"
            "data/agent.db-wal\n"
            "data/agent.db-shm\n"
            "data/rag_index.json\n"
            "data/embeddings/\n"
            "data/cache/\n"
            "evolution_state*.json\n"
            "\n"
            "# Sessions (can be large)\n"
            "sessions/*.jsonl\n"
            "sessions/*.json\n"
            "\n"
            "# Secrets — NEVER commit these\n"
            ".env\n"
            ".env.*\n"
            "!.env.example\n"
            ".keys/agent.key\n"
            "\n"
            "# Python\n"
            "__pycache__/\n"
            "*.pyc\n"
            ".venv/\n"
            "venv/\n"
            "dist/\n"
            "*.egg-info/\n"
            "\n"
            "# Node (deploy)\n"
            "node_modules/\n"
            "\n"
            "# OS\n"
            ".DS_Store\n"
            "Thumbs.db\n"
        )
        created.append(".gitignore")
    else:
        skipped.append(".gitignore")

    # ── GitHub Actions CI ────────────────────────────────────────────────
    ci_dir = directory / ".github" / "workflows"
    ci_path = ci_dir / "eval.yml"
    if not ci_path.exists():
        ci_dir.mkdir(parents=True, exist_ok=True)
        ci_path.write_text(
            "name: Agent Eval\n"
            "on:\n"
            "  push:\n"
            "    branches: [main]\n"
            "    paths:\n"
            "      - 'agents/**'\n"
            "      - 'tools/**'\n"
            "      - 'eval/**'\n"
            "  pull_request:\n"
            "    branches: [main]\n"
            "\n"
            "jobs:\n"
            "  eval:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - uses: actions/checkout@v4\n"
            "      - uses: actions/setup-python@v5\n"
            "        with:\n"
            "          python-version: '3.11'\n"
            "      - run: pip install agentos\n"
            "      - name: Run smoke test\n"
            "        env:\n"
            "          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n"
            f"        run: agentos eval {agent_name} eval/smoke-test.json --trials 1\n"
        )
        created.append(".github/workflows/eval.yml")
    else:
        skipped.append(".github/workflows/eval.yml")

    # ── Sessions keepfile (so git tracks the empty dir) ──────────────────
    sessions_keep = directory / "sessions" / ".gitkeep"
    if not sessions_keep.exists():
        sessions_keep.write_text("")

    # ── Git initialization ───────────────────────────────────────────────
    git_initialized = False
    git_remote_added = False

    if not args.no_git:
        git_dir = directory / ".git"
        if not git_dir.exists():
            result = subprocess.run(
                ["git", "init"], cwd=directory,
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                git_initialized = True
                subprocess.run(
                    ["git", "add", "."], cwd=directory,
                    capture_output=True, text=True,
                )
                subprocess.run(
                    ["git", "commit", "-m", f"Initialize {agent_name} agent project\n\nagent_id: {agent_id}"],
                    cwd=directory, capture_output=True, text=True,
                )
            else:
                print(f"  Warning: git init failed: {result.stderr.strip()}")
        else:
            skipped.append(".git/ (already a repo)")

        # Connect remote if provided
        if args.remote:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"], cwd=directory,
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                result = subprocess.run(
                    ["git", "remote", "add", "origin", args.remote],
                    cwd=directory, capture_output=True, text=True,
                )
                if result.returncode == 0:
                    git_remote_added = True
                else:
                    print(f"  Warning: Could not add remote: {result.stderr.strip()}")
            else:
                existing = result.stdout.strip()
                print(f"  Remote 'origin' already set to: {existing}")

    # ── Summary ──────────────────────────────────────────────────────────
    if created:
        print("Created:")
        for c in created:
            print(f"  + {c}")
    if skipped:
        print("Already exists (skipped):")
        for s in skipped:
            print(f"  - {s}")

    print(f"\nAgent ID: {agent_id}")
    if git_initialized:
        print(f"Git repo initialized with initial commit.")
    if git_remote_added:
        print(f"Remote 'origin' set to: {args.remote}")
        print(f"  Push with: git push -u origin main")

    print()
    print("Next steps:")
    print(f"  1. cp .env.example .env && edit .env   (add your API keys)")
    print(f"  2. Edit agents/{agent_name}.json       (customize your agent)")
    print(f"  3. agentos run {agent_name} \"your task\"")
    print(f"  4. agentos eval {agent_name} eval/smoke-test.json")
    if not args.no_git and not git_remote_added and not args.remote:
        print(f"  5. git remote add origin <url> && git push -u origin main")


async def cmd_create(args: argparse.Namespace) -> None:
    """Create an agent — either conversationally or from a one-shot description."""
    from agentos.builder import AgentBuilder

    provider = _get_builder_provider(args)
    builder = AgentBuilder(provider=provider)

    if args.one_shot:
        # One-shot mode: generate from description
        print(f"Building agent from: {args.one_shot}")
        config = await builder.build_from_description(args.one_shot)
        path = builder.save()
        print(f"\nAgent created: {config.name}")
        print(f"  Saved to: {path}")
        print(f"  Description: {config.description}")
        print(f"\nRun it: agentos run {config.name} \"your task\"")
        return

    # Conversational mode
    print("=" * 60)
    print("  AgentOS Agent Builder")
    print("  Describe what you want your agent to do.")
    print("  Type 'quit' to cancel.")
    print("=" * 60)
    print()

    # Get initial description
    try:
        user_input = input("What kind of agent do you want to build?\n> ").strip()
    except EOFError:
        print("\nAborted.")
        return

    if not user_input or user_input.lower() in ("quit", "exit", "q"):
        return

    response = await builder.start(user_input)
    print(f"\n{response}\n")

    # Continue conversation until complete
    while not builder.is_complete:
        try:
            user_input = input("> ").strip()
        except EOFError:
            break
        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q"):
            print("Cancelled.")
            return

        response = await builder.step(user_input)
        print(f"\n{response}\n")

    if builder.result:
        path = builder.save()
        print(f"\nAgent created: {builder.result.name}")
        print(f"  Saved to: {path}")
        print(f"\nRun it: agentos run {builder.result.name} \"your task\"")
    else:
        print("No agent was created.")


async def cmd_run(args: argparse.Namespace) -> None:
    """Run an agent on a task."""
    from agentos.agent import Agent

    agent = _load_agent(args.name)
    if args.turns:
        agent.config.max_turns = args.turns

    task = args.task
    if not task:
        # Read from stdin/pipe if no task provided
        if not sys.stdin.isatty():
            task = sys.stdin.read().strip()
        else:
            try:
                task = input("Task: ").strip()
            except EOFError:
                pass
        if not task:
            print("Error: No task provided.")
            print("Usage: agentos run <name> \"your task here\"")
            print("   or: echo \"your task\" | agentos run <name>")
            return

    # Warn if using stub provider
    from agentos.llm.provider import StubProvider
    _any_stub = any(
        isinstance(route.provider, StubProvider)
        for route in agent._harness.llm_router._routes.values()
    )
    if _any_stub:
        print("Note: No LLM API key found — using stub provider (responses will be placeholders).")
        print("  Set ANTHROPIC_API_KEY or OPENAI_API_KEY for real responses.")
        print()

    print(f"Running agent '{agent.config.name}' on: {task}")
    print("-" * 40)

    results = await agent.run(task)

    for result in results:
        if result.llm_response:
            print(f"\n[Turn {result.turn_number}] {result.llm_response.content}")
        if result.tool_results:
            for tr in result.tool_results:
                if "error" in tr:
                    print(f"  Tool error: {tr.get('tool', '?')}: {tr['error']}")
                else:
                    print(f"  Tool result: {tr.get('tool', '?')}: {tr.get('result', '')}")
        if result.error:
            print(f"  Error: {result.error}")

    # Print final output
    if results and results[-1].llm_response:
        print("\n" + "=" * 40)
        print("Final output:")
        print(results[-1].llm_response.content)


def cmd_list(args: argparse.Namespace) -> None:
    """List all available agents."""
    from agentos.agent import list_agents

    agents = list_agents()
    if not agents:
        print("No agents found. Create one with: agentos create")
        print("  Or initialize a project with: agentos init")
        return

    print(f"{'Name':<30} {'Description':<40} {'Model':<25}")
    print("-" * 95)
    for a in agents:
        name = (a.name[:27] + "...") if len(a.name) > 30 else a.name
        desc = (a.description[:37] + "...") if len(a.description) > 40 else a.description
        print(f"{name:<30} {desc:<40} {a.model:<25}")


def cmd_tools(args: argparse.Namespace) -> None:
    """List available tool plugins."""
    from agentos.tools.registry import ToolRegistry

    registry = ToolRegistry()
    tools = registry.list_all()
    if not tools:
        print("No tool plugins found.")
        print("  Add JSON or Python files to the tools/ directory.")
        print("  Or initialize a project with: agentos init")
        return

    print(f"{'Name':<25} {'Description':<50} {'Source':<20}")
    print("-" * 95)
    for t in tools:
        desc = (t.description[:47] + "...") if len(t.description) > 50 else t.description
        source = t.source_path.name if t.source_path else "programmatic"
        print(f"{t.name:<25} {desc:<50} {source:<20}")


async def cmd_chat(args: argparse.Namespace) -> None:
    """Interactive chat session with an agent."""
    from agentos.agent import Agent

    agent = _load_agent(args.name)
    print(f"Chatting with '{agent.config.name}' — type 'quit' to exit")
    print(f"  {agent.config.description}")
    print("-" * 40)

    while True:
        try:
            user_input = input("\nyou> ").strip()
        except EOFError:
            break
        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q"):
            break

        results = await agent.run(user_input)
        if results and results[-1].llm_response:
            print(f"\nagent> {results[-1].llm_response.content}")
        elif results and results[-1].error:
            print(f"\n[error] {results[-1].error}")

    print("Goodbye.")


def cmd_ingest(args: argparse.Namespace) -> None:
    """Ingest documents into the RAG knowledge base."""
    from pathlib import Path
    from agentos.rag.pipeline import RAGPipeline

    pipeline = RAGPipeline(chunk_size=args.chunk_size)

    documents: list[str] = []
    metadatas: list[dict] = []

    for file_arg in args.files:
        p = Path(file_arg)
        if p.is_dir():
            files = sorted(
                f for f in p.rglob("*")
                if f.is_file() and f.suffix in (".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".html")
            )
        elif p.is_file():
            files = [p]
        else:
            print(f"Warning: {file_arg} not found, skipping")
            continue

        for f in files:
            try:
                text = f.read_text(errors="replace")
                if text.strip():
                    documents.append(text)
                    metadatas.append({"source": str(f), "filename": f.name})
            except Exception as exc:
                print(f"Warning: Could not read {f}: {exc}")

    if not documents:
        print("No documents found to ingest.")
        return

    pipeline.ingest(documents, metadatas)

    # Save the indexed data for later retrieval
    import json
    data_dir = Path.cwd() / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    index_path = data_dir / "rag_index.json"
    index_data = {
        "chunk_size": args.chunk_size,
        "documents": [
            {"text": doc[:500], "metadata": meta}
            for doc, meta in zip(documents, metadatas)
        ],
        "total_chunks": len(pipeline.retriever._chunks) if hasattr(pipeline.retriever, '_chunks') else 0,
    }
    index_path.write_text(json.dumps(index_data, indent=2) + "\n")

    total_chunks = sum(len(pipeline.chunker.chunk(d)) for d in documents)
    print(f"Ingested {len(documents)} documents ({total_chunks} chunks)")
    print(f"  Sources: {', '.join(m['filename'] for m in metadatas[:5])}")
    if len(metadatas) > 5:
        print(f"  ... and {len(metadatas) - 5} more")
    print(f"  Index saved to: {index_path}")


async def cmd_eval(args: argparse.Namespace) -> None:
    """Evaluate an agent with test cases."""
    import json as _json
    from pathlib import Path
    from agentos.eval.gym import EvalGym, EvalTask
    from agentos.eval.grader import ContainsGrader, ExactMatchGrader

    agent = _load_agent(args.name)

    # Load tasks from JSON file
    tasks_path = Path(args.tasks_file)
    if not tasks_path.exists():
        print(f"Error: Tasks file not found: {tasks_path}")
        return

    tasks_data = _json.loads(tasks_path.read_text())
    if not isinstance(tasks_data, list):
        tasks_data = [tasks_data]

    gym = EvalGym(trials_per_task=args.trials)
    for t in tasks_data:
        grader_type = t.get("grader", "contains")
        if grader_type == "exact":
            grader = ExactMatchGrader()
        else:
            grader = ContainsGrader()
        gym.add_task(EvalTask(
            name=t.get("name", t.get("input", "")[:30]),
            input=t["input"],
            expected=t["expected"],
            grader=grader,
        ))

    print(f"Evaluating agent '{agent.config.name}' with {len(tasks_data)} tasks ({args.trials} trials each)")
    print("-" * 50)

    async def agent_fn(task_input: str) -> str:
        results = await agent.run(task_input)
        if results and results[-1].llm_response:
            return results[-1].llm_response.content
        return ""

    report = await gym.run(agent_fn)

    print(f"\nResults:")
    print(f"  Pass rate:    {report.pass_rate:.1%} ({report.pass_count}/{report.total_trials})")
    print(f"  Avg score:    {report.avg_score:.3f}")
    print(f"  Avg latency:  {report.avg_latency_ms:.0f}ms")
    print(f"  Total cost:   ${report.total_cost_usd:.4f}")
    if report.total_trials > 1:
        print(f"  Pass@1:       {report.pass_at_k(1):.1%}")
        if args.trials >= 3:
            print(f"  Pass@3:       {report.pass_at_k(3):.1%}")

    # Show per-task results
    print(f"\nPer-task breakdown:")
    task_results: dict[str, list] = {}
    for tr in report.trial_results:
        task_results.setdefault(tr.task_name, []).append(tr)

    for task_name, trials in task_results.items():
        passed = sum(1 for t in trials if t.grade.passed)
        print(f"  {task_name}: {passed}/{len(trials)} passed")


async def cmd_evolve(args: argparse.Namespace) -> None:
    """Run the continuous evolution loop — observe, analyze, propose, review, apply."""
    import json as _json
    from pathlib import Path
    from agentos.agent import Agent
    from agentos.eval.gym import EvalGym, EvalTask
    from agentos.eval.grader import ContainsGrader, ExactMatchGrader
    from agentos.evolution.loop import EvolutionLoop

    agent = _load_agent(args.name)

    # Load eval tasks
    tasks_path = Path(args.tasks_file)
    if not tasks_path.exists():
        print(f"Error: Tasks file not found: {tasks_path}")
        return

    tasks_data = _json.loads(tasks_path.read_text())
    if not isinstance(tasks_data, list):
        tasks_data = [tasks_data]

    # Set up the evolution loop
    loop = EvolutionLoop.for_agent(
        agent,
        min_sessions_for_analysis=args.min_sessions,
        surface_ratio=args.surface_ratio,
    )

    print(f"Evolution loop for '{agent.config.name}' v{agent.config.version}")
    print(f"  Tasks: {len(tasks_data)} | Trials: {args.trials} | Surface ratio: {args.surface_ratio:.0%}")
    print("=" * 60)

    # Step 1: Run baseline eval (this populates the observer with session records)
    print("\n[1/4] Running baseline evaluation...")

    gym = EvalGym(trials_per_task=args.trials)
    for t in tasks_data:
        grader_type = t.get("grader", "contains")
        grader = ExactMatchGrader() if grader_type == "exact" else ContainsGrader()
        gym.add_task(EvalTask(
            name=t.get("name", t.get("input", "")[:30]),
            input=t["input"],
            expected=t["expected"],
            grader=grader,
        ))

    async def agent_fn(task_input: str) -> str:
        results = await agent.run(task_input)
        if results and results[-1].llm_response:
            return results[-1].llm_response.content
        return ""

    baseline_report = await gym.run(agent_fn)
    baseline_report.agent_name = agent.config.name
    baseline_report.agent_version = agent.config.version
    baseline_report.model = agent.config.model

    print(f"  Baseline: pass_rate={baseline_report.pass_rate:.1%}, "
          f"avg_latency={baseline_report.avg_latency_ms:.0f}ms, "
          f"cost=${baseline_report.total_cost_usd:.4f}")

    # Step 2: Analyze patterns
    print("\n[2/4] Analyzing session patterns...")
    report = loop.analyze()

    if report.recommendations:
        print(f"  Found {len(report.recommendations)} recommendations:")
        for rec in report.recommendations[:5]:
            print(f"    - {rec}")
    else:
        print("  No significant patterns found (may need more sessions).")

    # Step 3: Generate proposals
    print("\n[3/4] Generating improvement proposals...")
    proposals = loop.propose(report)

    if not proposals:
        print("  No proposals generated. Agent may be performing well enough,")
        print("  or more sessions are needed for meaningful analysis.")
        if args.export:
            path = loop.export(args.export)
            print(f"\n  Evolution state exported to: {path}")
        return

    # Step 4: Human review
    print(f"\n[4/4] Review proposals ({len(proposals)} surfaced for review):")
    print(loop.show_proposals())
    print()

    # Interactive review loop
    pending = loop.review_queue.pending
    for proposal in pending:
        print(f"\n--- Proposal: {proposal.title} ---")
        print(f"    Priority: {proposal.priority:.0%}")
        print(f"    {proposal.rationale}")
        if proposal.modification:
            mod_str = _json.dumps(proposal.modification, indent=2)
            if len(mod_str) > 300:
                mod_str = mod_str[:300] + "\n..."
            print(f"    Change:\n{_indent(mod_str, 6)}")

        try:
            choice = input("\n    [a]pprove / [r]eject / [s]kip? ").strip().lower()
        except EOFError:
            break

        if choice in ("a", "approve", "y", "yes"):
            note = ""
            try:
                note = input("    Note (optional): ").strip()
            except EOFError:
                pass
            loop.approve(proposal.id, note=note)
            print(f"    Approved.")
        elif choice in ("r", "reject", "n", "no"):
            note = ""
            try:
                note = input("    Reason (optional): ").strip()
            except EOFError:
                pass
            loop.reject(proposal.id, note=note)
            print(f"    Rejected.")
        else:
            print(f"    Skipped.")

    # Apply approved proposals
    approved = loop.review_queue.approved
    if approved:
        metrics_before = {
            "pass_rate": baseline_report.pass_rate,
            "avg_score": baseline_report.avg_score,
            "avg_latency_ms": baseline_report.avg_latency_ms,
            "total_cost_usd": baseline_report.total_cost_usd,
        }

        new_config = loop.apply_approved(metrics_before=metrics_before)
        if new_config:
            print(f"\nApplied {len(approved)} change(s) → v{new_config.version}")
            print(f"  Saved to: agents/{new_config.name}.json")
            print(f"\n  Run 'agentos eval {new_config.name} {args.tasks_file}' to measure impact.")
            print(f"  Run 'agentos evolve {new_config.name} {args.tasks_file}' again to continue evolving.")
    else:
        print("\nNo proposals approved. Agent config unchanged.")

    # Export
    if args.export:
        path = loop.export(args.export)
        print(f"\nEvolution state exported to: {path}")
    else:
        path = loop.export()
        print(f"\nEvolution state saved to: {path}")

    # Show timeline
    timeline = loop.ledger.timeline()
    if timeline:
        print(f"\nEvolution timeline:")
        for entry in timeline:
            print(f"  v{entry['version']} ({entry['date']}): {entry['change']}")


def _indent(text: str, spaces: int) -> str:
    prefix = " " * spaces
    return "\n".join(prefix + line for line in text.split("\n"))


def _slugify(name: str) -> str:
    """Turn a directory/project name into a valid agent slug."""
    import re
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", name.lower()).strip("-")
    return slug or "my-agent"


def cmd_deploy(args: argparse.Namespace) -> None:
    """Deploy an agent to Cloudflare Workers."""
    config = _load_agent_config(args.name)

    # Look for deploy/ in cwd first, then fall back to package
    deploy_dir = Path.cwd() / "deploy"
    if not deploy_dir.exists():
        deploy_dir = Path(__file__).resolve().parent.parent / "deploy"
    if not deploy_dir.exists():
        print("Error: No deploy/ directory found.")
        print("  Option 1: Run from the AgentOS source root")
        print("  Option 2: Copy the deploy/ directory to your project")
        sys.exit(1)

    # Convert Python agent config → CF worker config format
    gov = config.governance
    cf_config = {
        "agentName": config.name,
        "agentDescription": config.description,
        "systemPrompt": config.system_prompt,
        "maxTurns": config.max_turns,
        "budgetLimitUsd": gov.get("budget_limit_usd", 10.0),
        "blockedTools": gov.get("blocked_tools", []),
        "requireConfirmationForDestructive": gov.get(
            "require_confirmation_for_destructive", True
        ),
        # These are set during `npm run setup`
        "provider": "",
        "model": config.model,
        "spentUsd": 0,
    }

    deploy_config_path = deploy_dir / "agent-config.json"
    deploy_config_path.write_text(json.dumps(cf_config, indent=2) + "\n")

    print(f"Deploying agent '{config.name}' to Cloudflare Workers...")
    print(f"  Model: {config.model}")
    print(f"  Tools: {', '.join(str(t) for t in config.tools) or 'none'}")
    print(f"  Budget: ${gov.get('budget_limit_usd', 10.0)}")
    print(f"  System prompt: {config.system_prompt[:60]}...")
    print()
    print(f"Agent config written to: {deploy_config_path}")
    print()
    print("Next steps:")
    print(f"  cd {deploy_dir} && npm run setup")
    print()
    print("After deployment, configure via:")
    print(f"  curl -X PUT https://YOUR_WORKER.workers.dev/agents/agentos/{config.name}/config \\")
    print(f"    -H 'Content-Type: application/json' \\")
    print(f"    -d @{deploy_config_path}")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _load_agent(name: str):
    """Load an agent from a name or file path."""
    from agentos.agent import Agent

    path = Path(name)
    if path.exists() and path.is_file():
        return Agent.from_file(path)
    return Agent.from_name(name)


def _load_agent_config(name: str):
    """Load an agent config from a name or file path."""
    from agentos.agent import load_agent_config, AgentConfig

    path = Path(name)
    if path.exists() and path.is_file():
        return load_agent_config(path)

    # Search in agents/ directory
    from agentos.agent import AGENTS_DIR
    for ext in (".yaml", ".yml", ".json"):
        p = AGENTS_DIR / f"{name}{ext}"
        if p.exists():
            return load_agent_config(p)

    raise FileNotFoundError(f"Agent '{name}' not found")


def _get_builder_provider(args: argparse.Namespace):
    """Get an LLM provider for the agent builder based on CLI args and env vars."""
    from agentos.llm.provider import HttpProvider, StubProvider

    provider_name = getattr(args, "provider", None)
    model = getattr(args, "model", None)

    # Check for API keys in environment
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")

    if provider_name == "stub":
        return StubProvider()

    if provider_name == "anthropic" or (not provider_name and anthropic_key):
        if not anthropic_key:
            print("Error: ANTHROPIC_API_KEY not set")
            sys.exit(1)
        return HttpProvider(
            model_id=model or "claude-sonnet-4-20250514",
            api_base="https://api.anthropic.com",
            api_key=anthropic_key,
            headers={"anthropic-version": "2023-06-01"},
        )

    if provider_name == "openai" or (not provider_name and openai_key):
        if not openai_key:
            print("Error: OPENAI_API_KEY not set")
            sys.exit(1)
        return HttpProvider(
            model_id=model or "gpt-4o",
            api_base="https://api.openai.com",
            api_key=openai_key,
        )

    # Fallback to stub with a helpful message
    print("Note: No LLM API key found. Using stub provider.")
    print("  Set ANTHROPIC_API_KEY or OPENAI_API_KEY for real LLM-powered creation.")
    print()
    return StubProvider()


if __name__ == "__main__":
    main()
