"""AgentOS CLI — the user-facing command line interface.

Usage:
    agentos init [dir] [--name N]   — Scaffold a new agent project (with git + CI)
    agentos init --template research — ...from a preset template
    agentos init --remote <url>     — ...and connect to a git remote
    agentos init --dry-run          — Preview what would be created
    agentos init --force            — Overwrite existing files on re-init
    agentos create                  — Conversationally build an agent with an LLM
    agentos create -1 DESC          — Build an agent from a one-line description
    agentos create --name N         — Override the generated agent name
    agentos create --output PATH    — Save agent definition to a custom path
    agentos create --force          — Overwrite an existing agent file
    agentos run <name> "task"       — Run a named agent on a task
    agentos list                    — List all available agents
    agentos tools                   — List available tool plugins
    agentos login                   — Authenticate via OAuth (GitHub/Google)
    agentos logout                  — Remove stored credentials
    agentos whoami                  — Show current authenticated user
    agentos sandbox create          — Create an E2B sandbox
    agentos sandbox exec <cmd>      — Execute command in sandbox
    agentos sandbox list            — List active sandboxes
    agentos sandbox kill <id>       — Kill a sandbox
    agentos serve                   — Start local API server with dashboard
    agentos deploy <name>           — Deploy an agent (Cloudflare Workers)
    agentos chat <name>             — Interactive chat session with an agent
    agentos codemap                 — Generate visual + JSON code graph maps
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

from agentos.defaults import DEFAULT_MODEL, DEFAULT_PROVIDER, AGENT_TEMPLATES, slugify as _slugify
from agentos.env import load_dotenv_if_present


def main() -> None:
    # Honor project-local .env for CLI commands.
    load_dotenv_if_present()

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
    init_p.add_argument(
        "--template", "-t", type=str, default=None,
        choices=["orchestrator", "blank", "research", "support", "code-review",
                 "data-analyst", "devops", "content-writer", "project-manager"],
        help="Start from a preset agent template (default: orchestrator)",
    )
    init_p.add_argument(
        "--plan", type=str, default=None,
        help="LLM plan: basic, standard, premium, code, private, or a custom plan name",
    )
    init_p.add_argument("--dry-run", action="store_true", help="Preview what would be created without writing anything")
    init_p.add_argument("--force", action="store_true", help="Overwrite existing files during re-initialization")

    # --- create ---
    create_p = sub.add_parser("create", help="Create a new agent (conversational)")
    create_p.add_argument(
        "--one-shot", "-1", type=str, default=None,
        help="Create from a one-line description (skip conversation)",
    )
    create_p.add_argument(
        "--name", "-n", type=str, default=None,
        help="Override the generated agent name",
    )
    create_p.add_argument(
        "--output", "-O", type=str, default=None,
        help="Save agent definition to a custom path (default: agents/<name>.json)",
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
    create_p.add_argument(
        "--tools-dir", type=str, default=None,
        help="Directory of tool plugins to show the builder (default: tools/)",
    )
    create_p.add_argument(
        "--force", action="store_true",
        help="Overwrite an existing agent with the same name",
    )
    create_p.add_argument(
        "--max-turns", type=int, default=20,
        help="Max conversation turns in interactive mode (default: 20)",
    )
    create_p.add_argument(
        "--tools", type=str, default=None,
        help="Comma-separated list of tools to assign (e.g., 'bash,read-file,python-exec'). "
        "Use 'auto' to auto-detect from description. Use 'none' for no tools.",
    )

    # --- run ---
    run_p = sub.add_parser("run", help="Run an agent on a task")
    run_p.add_argument("name", help="Agent name or path to definition file")
    run_p.add_argument("task", nargs="?", help="Task to execute")
    run_p.add_argument("--turns", type=int, default=None, help="Max turns override")
    run_p.add_argument("--timeout", type=float, default=None, help="Timeout in seconds")
    run_p.add_argument("--budget", type=float, default=None, help="Budget limit in USD")
    run_p.add_argument("--model", "-m", type=str, default=None, help="Override the LLM model")
    run_p.add_argument("--input-file", "-i", type=str, default=None, help="Read task from file")
    run_p.add_argument("--output", "-o", type=str, default=None, help="Write final output to file")
    run_p.add_argument("--json", dest="json_output", action="store_true", help="Output results as JSON")
    run_p.add_argument("--quiet", "-q", action="store_true", help="Only print final output")
    run_p.add_argument("--verbose", "-v", action="store_true", help="Show all turns with tool details")
    run_p.add_argument("--plan", type=str, default=None,
        help="LLM plan override: basic, standard, premium, code, private, or custom plan name")
    run_p.add_argument("--stream", action="store_true",
        help="Stream output in real-time as each turn completes")

    # --- list ---
    sub.add_parser("list", help="List available agents")

    # --- tools ---
    sub.add_parser("tools", help="List available tool plugins")

    # --- chat ---
    chat_p = sub.add_parser("chat", help="Interactive chat with an agent")
    chat_p.add_argument("name", help="Agent name or path")

    # --- ingest ---
    ingest_p = sub.add_parser("ingest", help="Ingest documents into RAG knowledge base")
    ingest_p.add_argument("name", help="Agent name to associate documents with")
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
    evolve_p.add_argument("--max-cycles", type=int, default=1, help="Max evolution cycles (default: 1)")
    evolve_p.add_argument("--auto-approve", action="store_true", help="Auto-approve all proposals (skip interactive review)")
    evolve_p.add_argument("--export", type=str, default=None, help="Export evolution state to JSON")

    # --- login ---
    login_p = sub.add_parser("login", help="Authenticate with AgentOS (OAuth device flow)")
    login_p.add_argument(
        "--provider", type=str, default="github",
        choices=["github", "google"],
        help="OAuth provider (default: github)",
    )
    login_p.add_argument("--server", type=str, default="", help="AgentOS server URL")

    # --- logout ---
    logout_p = sub.add_parser("logout", help="Remove stored credentials")
    logout_p.add_argument("--server", type=str, default="", help="Server to logout from")

    # --- whoami ---
    sub.add_parser("whoami", help="Show current authenticated user")

    # --- serve ---
    serve_p = sub.add_parser("serve", help="Start local API server with dashboard")
    serve_p.add_argument("--port", type=int, default=8340, help="Port (default: 8340)")
    serve_p.add_argument("--host", type=str, default="127.0.0.1", help="Host (default: 127.0.0.1)")

    # --- sandbox ---
    sandbox_p = sub.add_parser("sandbox", help="E2B sandbox operations")
    sandbox_sub = sandbox_p.add_subparsers(dest="sandbox_command")
    sandbox_sub.add_parser("create", help="Create a new sandbox")
    sb_exec = sandbox_sub.add_parser("exec", help="Execute a command in a sandbox")
    sb_exec.add_argument("shell_command", nargs="+", help="Command to execute")
    sb_exec.add_argument("--id", type=str, default=None, help="Sandbox ID")
    sb_ls = sandbox_sub.add_parser("list", help="List active sandboxes")
    sb_kill = sandbox_sub.add_parser("kill", help="Kill a sandbox")
    sb_kill.add_argument("sandbox_id", help="Sandbox ID to kill")

    # --- plans ---
    plans_p = sub.add_parser("plans", help="List or create LLM plans")
    plans_sub = plans_p.add_subparsers(dest="plans_command")
    plans_sub.add_parser("list", help="List all available plans")
    plans_create = plans_sub.add_parser("create", help="Create a custom plan")
    plans_create.add_argument("name", help="Plan name")
    plans_create.add_argument("--simple", type=str, required=True, help="Model for simple tasks (e.g., deepseek-ai/DeepSeek-V3.2)")
    plans_create.add_argument("--moderate", type=str, required=True, help="Model for moderate tasks")
    plans_create.add_argument("--complex", type=str, required=True, help="Model for complex tasks")
    plans_create.add_argument("--tool-call", type=str, default=None, help="Model for tool-calling turns (defaults to moderate model)")
    plans_create.add_argument("--provider", type=str, default="gmi", help="Provider for all tiers (default: gmi)")

    # --- deploy ---
    deploy_p = sub.add_parser("deploy", help="Deploy an agent")
    deploy_p.add_argument("name", help="Agent name or path")

    # --- schedule ---
    sched_p = sub.add_parser("schedule", help="Schedule agent runs on a cron")
    sched_sub = sched_p.add_subparsers(dest="schedule_command")
    sched_create = sched_sub.add_parser("create", help="Create a scheduled run")
    sched_create.add_argument("name", help="Agent name")
    sched_create.add_argument("cron", help="Cron expression (e.g., '0 9 * * *') or @hourly, @daily, @weekly")
    sched_create.add_argument("--task", type=str, required=True, help="Task to run")
    sched_sub.add_parser("list", help="List all schedules")
    sched_del = sched_sub.add_parser("delete", help="Delete a schedule")
    sched_del.add_argument("schedule_id", help="Schedule ID to delete")
    sched_sub.add_parser("run", help="Start the scheduler daemon")

    # --- compare ---
    compare_p = sub.add_parser("compare", help="A/B test two agent versions")
    compare_p.add_argument("name", help="Agent name")
    compare_p.add_argument("version_a", help="First version (e.g., v0.1.1)")
    compare_p.add_argument("version_b", help="Second version (e.g., v0.1.2)")
    compare_p.add_argument("--eval", dest="eval_file", type=str, required=True, help="Eval tasks file")
    compare_p.add_argument("--trials", type=int, default=3, help="Trials per task")

    # --- mcp-serve ---
    mcp_p = sub.add_parser("mcp-serve", help="Expose agents as MCP tool servers")
    mcp_p.add_argument("--agent", type=str, default=None, help="Specific agent to expose (default: all)")

    # --- codemap ---
    codemap_p = sub.add_parser("codemap", help="Generate code dependency and feature maps")
    codemap_p.add_argument("--root", type=str, default=".", help="Repository root (default: current directory)")
    codemap_p.add_argument("--json-out", type=str, default="data/codemap.json", help="JSON output path")
    codemap_p.add_argument("--dot-out", type=str, default="docs/codemap.dot", help="DOT output path")
    codemap_p.add_argument("--svg-out", type=str, default="docs/codemap.svg", help="SVG output path")
    codemap_p.add_argument("--no-portal", action="store_true", help="Skip portal TypeScript route/dependency analysis")

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
        elif args.command == "login":
            cmd_login(args)
        elif args.command == "logout":
            cmd_logout(args)
        elif args.command == "whoami":
            cmd_whoami(args)
        elif args.command == "serve":
            cmd_serve(args)
        elif args.command == "sandbox":
            asyncio.run(cmd_sandbox(args))
        elif args.command == "deploy":
            cmd_deploy(args)
        elif args.command == "plans":
            cmd_plans(args)
        elif args.command == "schedule":
            asyncio.run(cmd_schedule(args))
        elif args.command == "compare":
            asyncio.run(cmd_compare(args))
        elif args.command == "mcp-serve":
            cmd_mcp_serve(args)
        elif args.command == "codemap":
            cmd_codemap(args)
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


# ── Commands ──────────────────────────────────────────────────────────────────


def _should_write(path: Path, *, force: bool) -> bool:
    """Return True if the path doesn't exist yet, or --force is set."""
    return force or not path.exists()


def cmd_init(args: argparse.Namespace) -> None:
    """Scaffold a new agent project — identity, security, sessions, CI/CD."""
    import subprocess
    from datetime import datetime, timezone

    from agentos.core.identity import AgentIdentity, write_keypair

    directory = Path(args.directory).resolve()
    force = args.force
    dry_run = args.dry_run
    template_name = args.template or "orchestrator"

    # ── Input validation ─────────────────────────────────────────────────
    if directory.exists() and directory.is_file():
        print(f"Error: '{directory}' is a file, not a directory.", file=sys.stderr)
        sys.exit(1)

    agent_name = args.name or _slugify(directory.name)
    template = AGENT_TEMPLATES[template_name]
    created: list[str] = []
    skipped: list[str] = []
    overwritten: list[str] = []

    if dry_run:
        print(f"[dry-run] Would initialize AgentOS project in {directory}")
        print(f"[dry-run] Agent name: {agent_name}")
        print(f"[dry-run] Template: {template_name}")
        print()
    else:
        print(f"Initializing AgentOS project in {directory}")
        if template_name != "blank":
            print(f"  Template: {template_name}")
        print()

    def _track(label: str, path: Path) -> bool:
        """Track file creation. Returns True if we should write."""
        existed = path.exists()
        if dry_run:
            if existed and not force:
                skipped.append(label)
            elif existed and force:
                overwritten.append(label)
            else:
                created.append(label)
            return False  # never write in dry-run
        if existed and not force:
            skipped.append(label)
            return False
        if existed and force:
            overwritten.append(label)
            return True
        created.append(label)
        return True

    # ── Directory structure ──────────────────────────────────────────────
    for d in ("agents", "tools", "data", "eval", "sessions"):
        dir_path = directory / d
        if dir_path.exists():
            skipped.append(f"{d}/")
        else:
            if not dry_run:
                dir_path.mkdir(parents=True, exist_ok=True)
            created.append(f"{d}/")

    # ── SQLite database (the agent's persistent brain) ────────────────────
    db_path = directory / "data" / "agent.db"
    if _track("data/agent.db (SQLite — WAL mode)", db_path):
        from agentos.core.database import create_database
        db = create_database(db_path)
        db.close()

    # ── Agent identity (generated once, immutable) ───────────────────────
    # Identity is special: --force does NOT regenerate it (it's immutable).
    identity_path = directory / "agents" / ".identity.json"
    if not identity_path.exists():
        identity, secret_key = AgentIdentity.generate(
            with_signing=not args.no_signing,
        )
        if not dry_run:
            identity_path.write_text(json.dumps(identity.to_dict(), indent=2) + "\n")
        created.append("agents/.identity.json")
        agent_id = identity.agent_id
    else:
        existing = json.loads(identity_path.read_text())
        agent_id = existing.get("agent_id", "")
        secret_key = ""  # Already written to .keys/
        skipped.append("agents/.identity.json (immutable)")

    # ── Signing keypair ──────────────────────────────────────────────────
    keys_dir = directory / ".keys"
    if not args.no_signing and secret_key:
        identity_data = json.loads(identity_path.read_text()) if identity_path.exists() else {}
        fingerprint = identity_data.get("fingerprint", "")
        if fingerprint and not (keys_dir / "agent.key").exists():
            if not dry_run:
                write_keypair(keys_dir, secret_key, fingerprint)
            created.append(".keys/agent.pub (public — safe to commit)")
            created.append(".keys/agent.key (SECRET — gitignored)")
        elif (keys_dir / "agent.key").exists():
            skipped.append(".keys/ (keypair exists)")
    elif (keys_dir / "agent.key").exists():
        skipped.append(".keys/ (keypair exists)")

    # ── Project config (agentos.yaml) ────────────────────────────────────
    project_config_path = directory / "agentos.yaml"
    if _track("agentos.yaml", project_config_path):
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
            f"  model: {DEFAULT_MODEL}\n"
            f"  provider: {DEFAULT_PROVIDER}\n"
            f"  plan: {getattr(args, 'plan', None) or 'standard'}     # basic | standard | premium | code | private\n"
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
            f"# ── Vector store (semantic memory + RAG) ────────────────────\n"
            f"vector:\n"
            f"  backend: local                    # local | vectorize\n"
            f"  # local: brute-force cosine, backed by SQLite facts table\n"
            f"  # vectorize: Cloudflare Vectorize (set by 'agentos deploy')\n"
            f"  index_name: agentos-knowledge     # Vectorize index name\n"
            f"  embedding_model: '@cf/baai/bge-base-en-v1.5'  # 768 dimensions\n"
            f"  dimensions: 768\n"
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

    # ── Agent definition (from template) ──────────────────────────────────
    agent_path = directory / "agents" / f"{agent_name}.json"
    if _track(f"agents/{agent_name}.json", agent_path):
        description = template["description"].format(name=agent_name)
        starter = {
            "name": agent_name,
            "agent_id": agent_id,
            "description": description,
            "version": "0.1.0",
            "system_prompt": template["system_prompt"],
            "model": DEFAULT_MODEL,
            "tools": template["tools"],
            "governance": template["governance"],
            "memory": template["memory"],
            "max_turns": template.get("max_turns", 50),
            "tags": template["tags"],
        }
        agent_path.write_text(json.dumps(starter, indent=2) + "\n")

    # ── Starter tool plugin ──────────────────────────────────────────────
    tool_path = directory / "tools" / "example-search.json"
    if _track("tools/example-search.json", tool_path):
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

    # ── Starter eval task ────────────────────────────────────────────────
    eval_path = directory / "eval" / "smoke-test.json"
    if _track("eval/smoke-test.json", eval_path):
        eval_task = [
            {
                "name": "greeting",
                "input": "Say hello",
                "expected": "A friendly greeting response",
                "grader": "llm",
                "criteria": "Does the response contain a greeting (hello, hi, hey, etc.)? Score 1.0 if yes, 0.0 if no.",
                "pass_threshold": 0.5,
            },
            {
                "name": "helpfulness",
                "input": "What can you help me with?",
                "expected": "A helpful response explaining capabilities",
                "grader": "llm",
                "criteria": "Does the response explain what the agent can do? Is it helpful and specific? Score 0.0-1.0.",
                "pass_threshold": 0.5,
            },
        ]
        eval_path.write_text(json.dumps(eval_task, indent=2) + "\n")

    # ── .env.example (declares required secrets without values) ──────────
    env_example_path = directory / ".env.example"
    if _track(".env.example", env_example_path):
        env_example_path.write_text(
            "# AgentOS environment variables\n"
            "# Copy to .env and fill in your values:\n"
            "#   cp .env.example .env\n"
            "\n"
            "# LLM provider API keys (at least one required)\n"
            "ANTHROPIC_API_KEY=\n"
            "OPENAI_API_KEY=\n"
            "\n"
            "# GMI Cloud — private GPU inference (data stays on GMI's US GPUs)\n"
            "# GMI_API_KEY=                    # Model inference (serverless)\n"
            "# GMI_INFRA_API_KEY=              # Infrastructure (dedicated GPU provisioning)\n"
            "# GMI_API_BASE=https://api.gmi-serving.com/v1\n"
            "\n"
            "# Local models — any OpenAI-compatible endpoint (Ollama, vLLM, etc.)\n"
            "# LOCAL_LLM_BASE=http://localhost:11434/v1\n"
            "\n"
            "# Sandbox (optional — enables agentos sandbox)\n"
            "E2B_API_KEY=\n"
            "\n"
            "# Observability (optional)\n"
            "OBSERVABILITY_TOKEN=\n"
            "\n"
            "# Deployment (optional)\n"
            "CLOUDFLARE_API_TOKEN=\n"
            "CLOUDFLARE_ACCOUNT_ID=\n"
        )

    # ── .gitignore ───────────────────────────────────────────────────────
    gitignore_path = directory / ".gitignore"
    if _track(".gitignore", gitignore_path):
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

    # ── GitHub Actions CI ────────────────────────────────────────────────
    ci_dir = directory / ".github" / "workflows"
    ci_path = ci_dir / "eval.yml"
    if _track(".github/workflows/eval.yml", ci_path):
        if not dry_run:
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

    # ── Sessions keepfile (so git tracks the empty dir) ──────────────────
    sessions_keep = directory / "sessions" / ".gitkeep"
    if not dry_run and not sessions_keep.exists():
        sessions_keep.write_text("")

    # ── Git initialization ───────────────────────────────────────────────
    git_initialized = False
    git_remote_added = False

    # Files that init creates — only stage these, not the whole directory.
    _init_files = [
        "agents/", "tools/", "data/", "eval/", "sessions/",
        "agentos.yaml", ".env.example", ".gitignore",
        ".github/", ".keys/agent.pub",
    ]

    if not args.no_git and not dry_run:
        git_dir = directory / ".git"
        if not git_dir.exists():
            result = subprocess.run(
                ["git", "init"], cwd=directory,
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                git_initialized = True
                # Only stage AgentOS files, not unrelated files in the directory.
                existing = [f for f in _init_files if (directory / f.rstrip("/")).exists()]
                subprocess.run(
                    ["git", "add", "--"] + existing, cwd=directory,
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
                existing_remote = result.stdout.strip()
                print(f"  Remote 'origin' already set to: {existing_remote}")

    # ── Summary ──────────────────────────────────────────────────────────
    prefix = "[dry-run] " if dry_run else ""
    if created:
        print(f"{prefix}Created:")
        for c in created:
            print(f"  + {c}")
    if overwritten:
        print(f"{prefix}Overwritten (--force):")
        for o in overwritten:
            print(f"  ~ {o}")
    if skipped:
        print(f"{prefix}Already exists (skipped):")
        for s in skipped:
            print(f"  - {s}")

    print(f"\nAgent ID: {agent_id}")
    if template_name == "orchestrator":
        print("Orchestrator agent created — it can build, test, and evolve other agents.")
    elif template_name != "blank":
        print(f"Template: {template_name}")
    if git_initialized:
        print("Git repo initialized with initial commit.")
    if git_remote_added:
        print(f"Remote 'origin' set to: {args.remote}")
        print("  Push with: git push -u origin main")

    if not dry_run:
        print()
        print("Next steps:")
        print(f"  1. cp .env.example .env && edit .env   (add your API keys)")
        if template_name == "orchestrator":
            print(f"  2. agentos chat {agent_name}             (interactive — talk to the orchestrator)")
            print(f"     Ask it to: create agents, run evals, analyze failures, evolve agents")
            print(f"  3. agentos run {agent_name} \"create a support agent\"  (one-shot task)")
            print(f"     Or: agentos run {agent_name} --json -o result.json  (scripted)")
            print(f"  4. agentos eval {agent_name} eval/smoke-test.json")
        else:
            print(f"  2. Edit agents/{agent_name}.json       (customize your agent)")
            print(f"     Or: agentos create --one-shot \"description\"  (LLM-powered)")
            print(f"  3. agentos run {agent_name} \"your task\"")
            print(f"  4. agentos eval {agent_name} eval/smoke-test.json")
        if not args.no_git and not git_remote_added and not args.remote:
            print(f"  5. git remote add origin <url> && git push -u origin main")


async def cmd_create(args: argparse.Namespace) -> None:
    """Create an agent — either conversationally or from a one-shot description."""
    from agentos.agent import AGENTS_DIR, AgentConfig, save_agent_config
    from agentos.builder import AgentBuilder

    # ── Warn if project hasn't been initialized ──────────────────────────
    agents_dir = Path.cwd() / "agents"
    project_config_path = Path.cwd() / "agentos.yaml"
    if not agents_dir.is_dir() and not project_config_path.exists():
        print("Warning: No AgentOS project detected in the current directory.")
        print("  Run 'agentos init' first to set up the project structure.")
        print("  Continuing anyway — the agent file will be created in agents/.\n")

    # ── Read project defaults from agentos.yaml (if present) ─────────────
    project_defaults = _load_project_defaults(project_config_path)

    provider = _get_builder_provider(args)
    tools_dir = args.tools_dir
    builder = AgentBuilder(provider=provider, tools_dir=tools_dir)

    max_turns = args.max_turns

    if args.one_shot:
        # One-shot mode: generate from description
        print(f"Building agent from: {args.one_shot}")
        config = await builder.build_from_description(args.one_shot)
    else:
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

        # Continue conversation until complete or turn limit reached
        turn = 1
        while not builder.is_complete:
            if turn >= max_turns:
                print(f"\nReached max conversation turns ({max_turns}).")
                print("Tip: try 'agentos create --one-shot \"description\"' for quicker creation,")
                print("     or increase with --max-turns.\n")
                break
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
            turn += 1

        if not builder.result:
            print("No agent was created.", file=sys.stderr)
            sys.exit(1)

        config = builder.result

    # ── Apply --tools override ────────────────────────────────────────────
    tools_arg = getattr(args, "tools", None)
    if tools_arg:
        if tools_arg.lower() == "none":
            config.tools = []
        elif tools_arg.lower() == "auto":
            from agentos.builder import recommend_tools
            config.tools = recommend_tools(config.description)
            if config.tools:
                print(f"  Auto-assigned tools: {', '.join(config.tools)}")
        else:
            config.tools = [t.strip() for t in tools_arg.split(",") if t.strip()]
            print(f"  Tools: {', '.join(config.tools)}")

    # ── Apply --name override ────────────────────────────────────────────
    if args.name:
        config = _rename_agent_config(config, args.name)

    # ── Apply project defaults ───────────────────────────────────────────
    config = _apply_project_defaults(config, project_defaults)

    # ── Stamp agent_id from project identity ─────────────────────────────
    config = _stamp_project_identity(config, agents_dir)

    # ── Stamp built_with so run can warn about stub-created agents ───────
    from agentos.llm.provider import StubProvider
    if isinstance(provider, StubProvider):
        config.built_with = "stub"
    else:
        config.built_with = getattr(args, "provider", "") or "anthropic"

    # ── Collision check ──────────────────────────────────────────────────
    from agentos.agent import _resolve_agents_dir
    save_path = Path(args.output) if args.output else (_resolve_agents_dir() / f"{config.name}.json")
    if save_path.exists() and not args.force:
        print(f"Error: Agent file already exists: {save_path}", file=sys.stderr)
        print("  Use --force to overwrite, or --name to pick a different name.", file=sys.stderr)
        sys.exit(1)

    # ── Save (directly via save_agent_config, not builder.save()) ────────
    save_path.parent.mkdir(parents=True, exist_ok=True)
    path = save_agent_config(config, save_path)
    print(f"\nAgent created: {config.name}")
    print(f"  Saved to: {path}")
    if config.description:
        print(f"  Description: {config.description}")
    print(f"\nNext steps:")
    print(f"  1. agentos run {config.name} \"your task\"")
    print(f"  2. agentos eval {config.name} eval/smoke-test.json")


async def cmd_run(args: argparse.Namespace) -> None:
    """Run an agent on a task."""
    import time as _time

    from agentos.agent import Agent

    # ── Validate numeric arguments ─────────────────────────────────────
    _validate_positive(args.turns, "turns")
    _validate_positive(args.timeout, "timeout")
    _validate_positive(args.budget, "budget", allow_zero=True)

    agent = _load_agent(args.name)
    quiet = args.quiet or args.json_output

    # Project defaults from agentos.yaml are applied automatically in
    # Agent.__init__ — no need to call _load/_apply_project_defaults here.

    # ── Apply CLI runtime overrides (rebuild harness once) ────────────────
    agent.apply_overrides(
        turns=args.turns,
        timeout=args.timeout,
        budget=args.budget,
        model=args.model,
    )

    # ── Apply --plan override ─────────────────────────────────────────────
    plan = getattr(args, "plan", None)
    if plan:
        _apply_plan_to_agent(agent, plan)
        if not quiet:
            print(f"  Plan: {plan}")

    # ── Validate agent_id against project identity ───────────────────────
    if not quiet:
        _warn_identity_mismatch(agent)

    # ── Resolve task: --input-file > positional arg > stdin > prompt ──────
    task = None
    if args.input_file:
        p = Path(args.input_file)
        if not p.exists():
            print(f"Error: Input file not found: {args.input_file}", file=sys.stderr)
            sys.exit(1)
        task = p.read_text().strip()
    elif args.task:
        task = args.task
    elif not sys.stdin.isatty():
        task = sys.stdin.read().strip()
    else:
        try:
            task = input("Task: ").strip()
        except EOFError:
            pass

    if not task:
        print("Error: No task provided.", file=sys.stderr)
        print("Usage: agentos run <name> \"your task here\"", file=sys.stderr)
        print("   or: echo \"your task\" | agentos run <name>", file=sys.stderr)
        print("   or: agentos run <name> --input-file task.txt", file=sys.stderr)
        sys.exit(1)

    # ── Warn about stub provider (unless --quiet or --json) ──────────────
    if not quiet:
        _warn_stub_provider(agent, show_recreate_hint=True)

    if not quiet:
        print(f"Running agent '{agent.config.name}' on: {task}")
        print("-" * 40)

    # Set up streaming callback if requested
    stream = getattr(args, "stream", False)
    if stream and not quiet:
        def _stream_turn(result):
            if result.llm_response and result.llm_response.content:
                content = result.llm_response.content
                print(f"\n[Turn {result.turn_number}] {content}")
            for tr in result.tool_results:
                if "error" in tr:
                    print(f"  Tool error: {tr.get('tool', '?')}: {tr['error']}")
                else:
                    preview = str(tr.get("result", ""))[:200]
                    if len(str(tr.get("result", ""))) > 200:
                        preview += "..."
                    print(f"  Tool: {tr.get('tool', '?')}: {preview}")
            if result.error:
                print(f"  Error: {result.error}")
            sys.stdout.flush()
        agent._harness.on_turn_complete = _stream_turn

    start = _time.monotonic()
    results = await agent.run(task)
    elapsed_ms = (_time.monotonic() - start) * 1000

    # Compute summary metrics
    total_cost = sum(
        r.llm_response.cost_usd for r in results if r.llm_response
    )
    total_turns = len(results)
    total_tool_calls = sum(len(r.tool_results) for r in results)
    tool_errors = sum(
        1 for r in results for tr in r.tool_results if "error" in tr
    )
    final_output = ""
    if results and results[-1].llm_response:
        final_output = results[-1].llm_response.content

    # Determine if the run failed
    failed = False
    failure_reason = ""
    if results and results[-1].error:
        failed = True
        failure_reason = results[-1].error
    elif results and results[-1].stop_reason not in ("completed", ""):
        failed = True
        failure_reason = f"Stopped: {results[-1].stop_reason}"

    # --- JSON output mode ---
    if args.json_output:
        import json as _json
        output = {
            "agent": agent.config.name,
            "task": task,
            "success": not failed,
            "output": final_output,
            "turns": total_turns,
            "tool_calls": total_tool_calls,
            "tool_errors": tool_errors,
            "cost_usd": round(total_cost, 6),
            "latency_ms": round(elapsed_ms, 1),
        }
        if failed:
            output["error"] = failure_reason
        if args.verbose:
            output["results"] = [
                {
                    "turn": r.turn_number,
                    "content": r.llm_response.content if r.llm_response else None,
                    "tool_results": r.tool_results,
                    "error": r.error,
                    "stop_reason": r.stop_reason,
                }
                for r in results
            ]
        text = _json.dumps(output, indent=2)
        if args.output:
            Path(args.output).write_text(text + "\n")
        else:
            print(text)
        if failed:
            sys.exit(1)
        return

    # --- Verbose mode: show every turn ---
    if args.verbose:
        for result in results:
            if result.llm_response:
                print(f"\n[Turn {result.turn_number}] {result.llm_response.content}")
            if result.tool_results:
                for tr in result.tool_results:
                    if "error" in tr:
                        print(f"  Tool error: {tr.get('tool', '?')}: {tr['error']}")
                    else:
                        preview = str(tr.get("result", ""))
                        if len(preview) > 200:
                            preview = preview[:200] + "..."
                        print(f"  Tool result: {tr.get('tool', '?')}: {preview}")
            if result.error:
                print(f"  Error: {result.error}")
        print()

    # --- Final output ---
    if final_output:
        if not args.quiet:
            print("\n" + "=" * 40)
            print("Output:")
        print(final_output)
    elif failed:
        print(f"\nAgent failed: {failure_reason}", file=sys.stderr)

    # Write to file if requested
    if args.output:
        Path(args.output).write_text(final_output + "\n" if final_output else "")
        if not args.quiet:
            print(f"\nOutput written to: {args.output}")

    # --- Summary (unless --quiet) ---
    if not args.quiet:
        print(f"\n--- {total_turns} turn{'s' if total_turns != 1 else ''}"
              f" | {total_tool_calls} tool call{'s' if total_tool_calls != 1 else ''}"
              f" | {elapsed_ms:.0f}ms"
              f" | ${total_cost:.4f} ---")
        if tool_errors:
            print(f"    ({tool_errors} tool error{'s' if tool_errors != 1 else ''})")

    if failed:
        sys.exit(1)


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


def cmd_codemap(args: argparse.Namespace) -> None:
    """Generate repository code maps for humans and agents."""
    from agentos.analysis.codemap import build_codemap, write_outputs

    root = Path(args.root).resolve()
    if not root.exists():
        raise FileNotFoundError(f"Repository root does not exist: {root}")

    payload = build_codemap(root=root, include_portal=not args.no_portal)
    outputs = write_outputs(
        payload=payload,
        json_path=(root / args.json_out).resolve(),
        dot_path=(root / args.dot_out).resolve(),
        svg_path=(root / args.svg_out).resolve() if args.svg_out else None,
    )

    summary = payload.get("summary", {})
    print("Code map generated.")
    print(f"  Nodes: {summary.get('node_count', 0)}")
    print(f"  Edges: {summary.get('edge_count', 0)}")
    print(f"  JSON: {outputs.get('json', '')}")
    print(f"  DOT:  {outputs.get('dot', '')}")
    if outputs.get("svg"):
        print(f"  SVG:  {outputs.get('svg', '')}")
    else:
        print("  SVG:  not generated (graphviz `dot` not installed or failed)")


async def cmd_chat(args: argparse.Namespace) -> None:
    """Interactive chat session with an agent."""
    from agentos.agent import Agent

    agent = _load_agent(args.name)
    _warn_identity_mismatch(agent)
    _warn_stub_provider(agent)

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

    # Validate agent exists (warn but continue if not found)
    agent_name = args.name
    try:
        _load_agent(agent_name)
    except (FileNotFoundError, Exception) as exc:
        print(f"Warning: Agent '{agent_name}' not found — ingesting documents globally.")
        print(f"  Create the agent first with: agentos create --one-shot \"{agent_name}\"")
        print()

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
                    metadatas.append({"source": str(f), "filename": f.name, "agent": agent_name})
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

    # Persist chunks to SQLite for fast loading on startup
    pipeline.save_chunks(data_dir / "rag_chunks.db")

    index_path = data_dir / "rag_index.json"
    index_data = {
        "agent": agent_name,
        "chunk_size": args.chunk_size,
        "documents": [
            {"length": len(doc), "metadata": meta}
            for doc, meta in zip(documents, metadatas)
        ],
        "total_chunks": len(pipeline.retriever._chunks) if hasattr(pipeline.retriever, '_chunks') else 0,
        "source_files": [m.get("source", "") for m in metadatas],
    }
    index_path.write_text(json.dumps(index_data, indent=2) + "\n")

    total_chunks = sum(len(pipeline.chunker.chunk(d)) for d in documents)
    print(f"Ingested {len(documents)} documents ({total_chunks} chunks) for agent '{agent_name}'")
    print(f"  Sources: {', '.join(m['filename'] for m in metadatas[:5])}")
    if len(metadatas) > 5:
        print(f"  ... and {len(metadatas) - 5} more")
    print(f"  Index saved to: {index_path}")


async def cmd_eval(args: argparse.Namespace) -> None:
    """Evaluate an agent with test cases."""
    _validate_positive(args.trials, "trials")
    agent = _load_agent(args.name)

    gym, tasks_data = _load_eval_tasks(Path(args.tasks_file))
    gym.trials_per_task = args.trials

    print(f"Evaluating agent '{agent.config.name}' with {len(tasks_data)} tasks ({args.trials} trials each)")
    print("-" * 50)

    report = await gym.run(_make_agent_fn(agent))

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

    # Persist eval run to database (if available)
    if agent.db:
        try:
            report.agent_name = agent.config.name
            report.agent_version = agent.config.version
            report.model = agent.config.model
            agent.db.insert_eval_run(report.to_dict())
        except Exception as exc:
            logger.warning("Could not persist eval run: %s", exc)


async def cmd_evolve(args: argparse.Namespace) -> None:
    """Run the continuous evolution loop — observe, analyze, propose, review, apply."""
    _validate_positive(args.trials, "trials")
    _validate_positive(args.min_sessions, "min-sessions")
    if args.surface_ratio is not None and not (0.0 < args.surface_ratio <= 1.0):
        print(f"Error: --surface-ratio must be between 0 and 1 (got {args.surface_ratio})", file=sys.stderr)
        sys.exit(1)

    from agentos.evolution.loop import EvolutionLoop

    max_cycles = getattr(args, "max_cycles", 1) or 1
    auto_approve = getattr(args, "auto_approve", False)

    agent = _load_agent(args.name)

    gym, tasks_data = _load_eval_tasks(Path(args.tasks_file))
    gym.trials_per_task = args.trials

    print(f"Evolution loop for '{agent.config.name}' v{agent.config.version}")
    print(f"  Tasks: {len(tasks_data)} | Trials: {args.trials} | Surface ratio: {args.surface_ratio:.0%}")
    if max_cycles > 1:
        print(f"  Max cycles: {max_cycles}")
    if auto_approve:
        print(f"  Mode: auto-approve (non-interactive)")
    print("=" * 60)

    for cycle in range(1, max_cycles + 1):
        if max_cycles > 1:
            print(f"\n{'─' * 60}")
            print(f"Cycle {cycle}/{max_cycles}")
            print(f"{'─' * 60}")

        # Set up the evolution loop (re-create each cycle to pick up config changes)
        loop = EvolutionLoop.for_agent(
            agent,
            min_sessions_for_analysis=args.min_sessions,
            surface_ratio=args.surface_ratio,
        )

        # Step 1: Run baseline eval
        print("\n[1/4] Running baseline evaluation...")

        baseline_report = await gym.run(_make_agent_fn(agent))
        baseline_report.agent_name = agent.config.name
        baseline_report.agent_version = agent.config.version
        baseline_report.model = agent.config.model

        print(f"  Baseline: pass_rate={baseline_report.pass_rate:.1%}, "
              f"avg_latency={baseline_report.avg_latency_ms:.0f}ms, "
              f"cost=${baseline_report.total_cost_usd:.4f}")

        # Step 2: Analyze patterns
        print("\n[2/4] Analyzing session patterns...")
        report = loop.analyze(db=agent.db)

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
            break

        # Step 4: Review proposals
        print(f"\n[4/4] Review proposals ({len(proposals)} surfaced for review):")
        print(loop.show_proposals())
        print()

        pending = loop.review_queue.pending

        if auto_approve:
            # Auto-approve all proposals
            for proposal in pending:
                loop.approve(proposal.id, note="auto-approved")
                print(f"  Auto-approved: {proposal.title}")
        else:
            # Interactive review loop
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
                # Reload agent for next cycle
                agent = _load_agent(args.name)

                # Post-apply verification: re-run eval to check quality
                print(f"\n  Verifying changes...")
                verify_report = await gym.run(_make_agent_fn(agent))
                verify_pass = verify_report.pass_rate
                baseline_pass = baseline_report.pass_rate

                if verify_pass < baseline_pass * 0.8 and baseline_pass > 0:
                    # Quality dropped by >20% — rollback
                    print(f"  Quality regression: {baseline_pass:.0%} → {verify_pass:.0%}")
                    print(f"  Rolling back to pre-v{new_config.version}...")
                    rolled_back = loop.rollback(new_config.version)
                    if rolled_back:
                        agent = _load_agent(args.name)
                        print(f"  Rolled back to v{rolled_back.version}")
                    else:
                        print(f"  Warning: Rollback failed — manually check agents/{args.name}.json")
                else:
                    print(f"  Verified: pass rate {verify_pass:.0%} (was {baseline_pass:.0%})")
        else:
            print("\nNo proposals approved. Agent config unchanged.")
            if not auto_approve:
                break  # No point continuing if human rejected everything

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


def _rename_agent_config(config, new_name: str):
    """Return a copy of the AgentConfig with an updated name."""
    from agentos.agent import AgentConfig
    data = config.to_dict()
    data["name"] = new_name
    return AgentConfig.from_dict(data)


def _validate_positive(value, name: str, allow_zero: bool = False) -> None:
    """Validate that a numeric CLI argument is positive. Exits on failure."""
    if value is None:
        return
    if allow_zero and value < 0:
        print(f"Error: --{name} must be non-negative (got {value})", file=sys.stderr)
        sys.exit(1)
    if not allow_zero and value <= 0:
        print(f"Error: --{name} must be positive (got {value})", file=sys.stderr)
        sys.exit(1)


def _load_eval_tasks(tasks_path: Path):
    """Load eval tasks from a JSON file and return (EvalGym, tasks_data).

    Shared by cmd_eval and cmd_evolve to avoid duplicated task-loading logic.
    Exits with code 1 if the file is missing or malformed.
    """
    from agentos.eval.gym import EvalGym, EvalTask
    from agentos.eval.grader import ContainsGrader, ExactMatchGrader, LLMGrader

    if not tasks_path.exists():
        print(f"Error: Tasks file not found: {tasks_path}", file=sys.stderr)
        sys.exit(1)

    try:
        tasks_data = json.loads(tasks_path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Error: Could not parse tasks file: {exc}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(tasks_data, list):
        tasks_data = [tasks_data]

    if not tasks_data:
        print("Error: Tasks file is empty.", file=sys.stderr)
        sys.exit(1)

    gym = EvalGym()
    for t in tasks_data:
        if "input" not in t or "expected" not in t:
            print(f"Error: Task missing 'input' or 'expected' field: {t}", file=sys.stderr)
            sys.exit(1)
        grader_type = t.get("grader", "contains")
        if grader_type == "exact":
            grader = ExactMatchGrader()
        elif grader_type == "contains":
            grader = ContainsGrader()
        elif grader_type == "llm":
            # LLM grader: uses "expected" as a rubric/criteria for the LLM judge
            criteria = t.get("criteria", t.get("expected", "correctness"))
            provider = _get_grader_provider()
            grader = LLMGrader(criteria=criteria, provider=provider, pass_threshold=t.get("pass_threshold", 0.5))
        else:
            print(f"Warning: Unknown grader type '{grader_type}', using 'contains'", file=sys.stderr)
            grader = ContainsGrader()
        gym.add_task(EvalTask(
            name=t.get("name", t.get("input", "")[:30]),
            input=t["input"],
            expected=t["expected"],
            grader=grader,
        ))

    return gym, tasks_data


def _make_agent_fn(agent):
    """Create an async agent function for eval/evolve runs.

    Returns an ``AgentResult`` so the gym picks up cost, tool-call counts,
    and model metadata from the agent's harness results.
    """
    from agentos.eval.gym import AgentResult

    async def agent_fn(task_input: str) -> AgentResult:
        results = await agent.run(task_input)
        output = ""
        total_cost = 0.0
        total_tool_calls = 0
        model = ""
        for r in results:
            if r.llm_response:
                output = r.llm_response.content
                model = getattr(r, "model_used", "") or r.llm_response.model
            total_cost += getattr(r, "cost_usd", 0.0)
            total_tool_calls += len(r.tool_results) if r.tool_results else 0
        return AgentResult(
            output=output,
            cost_usd=total_cost,
            tool_calls_count=total_tool_calls,
            model=model,
        )
    return agent_fn


def _load_project_defaults(config_path: Path) -> dict:
    """Load project-level defaults from agentos.yaml (if it exists).

    Returns the ``defaults:`` section or an empty dict.
    """
    if not config_path.exists():
        return {}
    try:
        # agentos.yaml is simple enough for a lightweight parse;
        # full YAML is an optional dep so we do a best-effort read.
        text = config_path.read_text()
        try:
            import yaml
            data = yaml.safe_load(text) or {}
        except ImportError:
            # Minimal key-value extraction for the defaults section
            data = {}
        return data.get("defaults", {}) if isinstance(data, dict) else {}
    except Exception:
        return {}


def _apply_project_defaults(config, defaults: dict):
    """Merge project defaults (model, budget) into an AgentConfig if not already set."""
    from agentos.agent import AgentConfig
    if not defaults:
        return config
    data = config.to_dict()
    # Only override model if the builder produced the generic default
    if defaults.get("model") and data.get("model") == DEFAULT_MODEL:
        data["model"] = defaults["model"]
    # Inherit budget from project if governance uses the generic default
    budget = defaults.get("budget_limit_usd")
    if budget and data.get("governance", {}).get("budget_limit_usd") == 10.0:
        data.setdefault("governance", {})["budget_limit_usd"] = budget
    return AgentConfig.from_dict(data)


def _stamp_project_identity(config, agents_dir: Path):
    """If agents/.identity.json exists, stamp its agent_id onto the config."""
    from agentos.agent import AgentConfig
    identity_path = agents_dir / ".identity.json"
    if not identity_path.exists():
        return config
    try:
        identity_data = json.loads(identity_path.read_text())
        agent_id = identity_data.get("agent_id", "")
        if agent_id and not config.agent_id:
            data = config.to_dict()
            data["agent_id"] = agent_id
            return AgentConfig.from_dict(data)
    except (json.JSONDecodeError, OSError):
        pass
    return config


def cmd_login(args: argparse.Namespace) -> None:
    """Authenticate via OAuth device flow (like `gh auth login`)."""
    from agentos.auth.credentials import CredentialsStore, StoredCredential
    from agentos.auth.jwt import create_token

    provider = args.provider
    server = args.server or "local"

    print(f"Authenticating with {provider.title()}...")
    print()

    try:
        if provider not in ("github", "google"):
            print(f"Unknown provider: {provider}", file=sys.stderr)
            sys.exit(1)

        access_token, user = _oauth_device_flow(provider)
        print(f" done!")
        print()

        # If targeting a remote server, exchange the OAuth token there
        # so the JWT is signed with the server's secret.
        if server and server != "local":
            token = _exchange_token_with_server(
                server_url=server,
                oauth_token=access_token,
                provider=provider,
                user=user,
            )
        else:
            # Local mode: sign locally (secret is persisted to disk)
            token = create_token(
                user_id=user.id,
                email=user.email,
                name=user.name,
                provider=user.provider,
            )

        # Store credential
        store = CredentialsStore.load()
        store.store(StoredCredential(
            token=token,
            user_id=user.id,
            email=user.email,
            name=user.name,
            provider=user.provider,
            server=server,
        ))

        print(f"Logged in as {user.name} ({user.email})")
        print(f"  Provider: {user.provider}")
        print(f"  User ID:  {user.id}")
        print(f"  Server:   {server}")
        print()
        print(f"Credentials saved to ~/.agentos/credentials.json")

    except ValueError as e:
        print(f"Error: {e}")
        print()
        print("To set up OAuth:")
        if provider == "github":
            print("  1. Create a GitHub OAuth App: https://github.com/settings/developers")
            print("  2. Enable 'Device Flow' in app settings")
            print("  3. Set GITHUB_CLIENT_ID environment variable")
        elif provider == "google":
            print("  1. Create OAuth credentials: https://console.cloud.google.com/apis/credentials")
            print("  2. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables")
        sys.exit(1)


def cmd_logout(args: argparse.Namespace) -> None:
    """Remove stored credentials."""
    from agentos.auth.credentials import CredentialsStore

    store = CredentialsStore.load()
    server = args.server or ""

    if store.remove(server):
        print(f"Logged out from {server or store.default_server or 'default server'}")
    else:
        print("No credentials found to remove.")


def cmd_whoami(args: argparse.Namespace) -> None:
    """Show current authenticated user."""
    from agentos.auth.credentials import CredentialsStore

    store = CredentialsStore.load()

    if not store.credentials:
        print("Not logged in. Run 'agentos login' to authenticate.")
        return

    for server, cred in store.credentials.items():
        default = " (default)" if server == store.default_server else ""
        print(f"{server}{default}:")
        print(f"  User:     {cred.name} ({cred.email})")
        print(f"  Provider: {cred.provider}")
        print(f"  User ID:  {cred.user_id}")


def cmd_serve(args: argparse.Namespace) -> None:
    """Start local API server with dashboard."""
    try:
        import uvicorn
    except ImportError:
        print("Error: uvicorn not installed. Run: pip install uvicorn")
        sys.exit(1)

    dashboard_dir = Path(__file__).resolve().parent / "dashboard"
    print(f"Starting AgentOS server on http://{args.host}:{args.port}")
    if dashboard_dir.is_dir():
        print(f"  Dashboard: http://{args.host}:{args.port}/dashboard")
    print(f"  API:       http://{args.host}:{args.port}/health")
    print()

    uvicorn.run(
        "agentos.api.app:create_app",
        host=args.host,
        port=args.port,
        factory=True,
    )


async def cmd_sandbox(args: argparse.Namespace) -> None:
    """E2B sandbox operations — create, exec, list, kill."""
    from agentos.sandbox import SandboxManager

    subcmd = args.sandbox_command
    if not subcmd:
        print("Usage: agentos sandbox {create|exec|list|kill}", file=sys.stderr)
        print("  create          Create a new E2B sandbox", file=sys.stderr)
        print("  exec <command>  Execute command in sandbox", file=sys.stderr)
        print("  list            List active sandboxes", file=sys.stderr)
        print("  kill <id>       Kill a sandbox", file=sys.stderr)
        sys.exit(1)

    mgr = SandboxManager()

    if subcmd == "create":
        session = await mgr.create()
        print(f"Sandbox created: {session.sandbox_id}")
        print(f"  Template: {session.template}")
        print(f"  Status:   {session.status}")
        if not mgr.has_api_key:
            print("  (local fallback — set E2B_API_KEY for cloud sandboxes)")

    elif subcmd == "exec":
        command = " ".join(args.shell_command)
        sandbox_id = getattr(args, "id", None)
        result = await mgr.exec(command, sandbox_id=sandbox_id)
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        if result.exit_code != 0:
            print(f"\n[exit code: {result.exit_code}]")
        print(f"[sandbox: {result.sandbox_id}, {result.duration_ms:.0f}ms]")

    elif subcmd == "list":
        sandboxes = await mgr.list_sandboxes()
        if not sandboxes:
            print("No active sandboxes.")
        else:
            for s in sandboxes:
                print(f"  {s['sandbox_id']}  template={s.get('template', '-')}  {s.get('status', s.get('started_at', ''))}")

    elif subcmd == "kill":
        killed = await mgr.kill(args.sandbox_id)
        if killed:
            print(f"Sandbox {args.sandbox_id} killed.")
        else:
            print(f"Failed to kill sandbox {args.sandbox_id}")



def cmd_plans(args: argparse.Namespace) -> None:
    """List or create LLM plans."""
    subcmd = getattr(args, "plans_command", None)

    if subcmd == "create":
        # Create a custom plan in agentos.yaml
        project_yaml = Path.cwd() / "agentos.yaml"
        if not project_yaml.exists():
            print("Error: No agentos.yaml found. Run 'agentos init' first.", file=sys.stderr)
            sys.exit(1)

        plan_name = args.name
        provider = args.provider
        tool_call_model = getattr(args, "tool_call", None) or args.moderate
        plan = {
            "_description": f"Custom plan: {plan_name}",
            "simple":    {"provider": provider, "model": args.simple,              "max_tokens": 1024},
            "moderate":  {"provider": provider, "model": args.moderate,            "max_tokens": 4096},
            "complex":   {"provider": provider, "model": getattr(args, "complex"), "max_tokens": 8192},
            "tool_call": {"provider": provider, "model": tool_call_model,          "max_tokens": 4096},
        }

        # Read existing yaml, add plan
        try:
            import yaml
            data = yaml.safe_load(project_yaml.read_text()) or {}
        except ImportError:
            print("Error: PyYAML required for custom plans. Install: pip install pyyaml", file=sys.stderr)
            sys.exit(1)

        if "plans" not in data:
            data["plans"] = {}
        data["plans"][plan_name] = plan

        try:
            import yaml
            project_yaml.write_text(yaml.dump(data, default_flow_style=False, sort_keys=False))
        except Exception:
            # Fallback: append as comment + JSON
            import json as _json
            with open(project_yaml, "a") as f:
                f.write(f"\n# Custom plan: {plan_name}\n")
                f.write(f"# {_json.dumps(plan)}\n")

        print(f"Created custom plan '{plan_name}':")
        print(f"  simple:   {args.simple}")
        print(f"  moderate: {args.moderate}")
        print(f"  complex:  {getattr(args, 'complex')}")
        print(f"  provider: {provider}")
        print(f"\nUse it: agentos run <agent> --plan {plan_name}")

    else:
        # List all plans
        plans = _list_plans()
        if not plans:
            print("No plans found.")
            return

        print("Available LLM Plans:")
        print("=" * 70)
        for name, desc in plans.items():
            print(f"\n  {name}")
            if desc:
                print(f"    {desc}")
            plan = _load_plan(name.replace(" (custom)", ""))
            if plan:
                for tier in ["simple", "moderate", "complex", "tool_call"]:
                    cfg = plan.get(tier, {})
                    if cfg:
                        model = cfg.get("model", "?").split("/")[-1]
                        print(f"    {tier:10s} → {model}")

        print(f"\n{'=' * 70}")
        print("Usage:")
        print("  agentos run <agent> --plan <name>")
        print("  agentos init --plan <name>")
        print("  agentos plans create <name> --simple <model> --moderate <model> --complex <model>")


async def cmd_schedule(args: argparse.Namespace) -> None:
    """Manage scheduled agent runs."""
    from agentos.scheduler import Schedule, load_schedules, save_schedules, parse_cron, scheduler_loop

    subcmd = getattr(args, "schedule_command", None)

    if subcmd == "create":
        # Validate cron
        try:
            parse_cron(args.cron)
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

        # Validate agent exists
        _load_agent(args.name)

        schedules = load_schedules()
        sched = Schedule(agent_name=args.name, task=args.task, cron=args.cron)
        schedules.append(sched)
        save_schedules(schedules)

        print(f"Schedule created: {sched.id}")
        print(f"  Agent: {args.name}")
        print(f"  Task: {args.task}")
        print(f"  Cron: {args.cron}")
        print(f"\nStart the scheduler: agentos schedule run")

    elif subcmd == "list":
        schedules = load_schedules()
        if not schedules:
            print("No schedules. Create one: agentos schedule create <agent> '<cron>' --task '<task>'")
            return
        print(f"Schedules ({len(schedules)}):")
        for s in schedules:
            status = "enabled" if s.enabled else "disabled"
            last = f"last run: {s.last_status}" if s.last_run else "never run"
            print(f"  {s.id}  {s.agent_name:15s}  {s.cron:15s}  [{status}]  runs={s.run_count}  {last}")
            print(f"          task: {s.task[:60]}")

    elif subcmd == "delete":
        schedules = load_schedules()
        before = len(schedules)
        schedules = [s for s in schedules if s.id != args.schedule_id]
        if len(schedules) == before:
            print(f"Schedule '{args.schedule_id}' not found", file=sys.stderr)
            sys.exit(1)
        save_schedules(schedules)
        print(f"Deleted schedule {args.schedule_id}")

    elif subcmd == "run":
        print("Starting AgentOS scheduler...")
        print("  Checking for due tasks every 60 seconds")
        print("  Press Ctrl+C to stop\n")
        try:
            await scheduler_loop(check_interval=60)
        except KeyboardInterrupt:
            print("\nScheduler stopped.")

    else:
        print("Usage: agentos schedule {create|list|delete|run}")


async def cmd_compare(args: argparse.Namespace) -> None:
    """A/B test two agent versions on the same eval tasks."""
    from pathlib import Path

    version_a = args.version_a.lstrip("v")
    version_b = args.version_b.lstrip("v")

    # Load the agent config
    agent = _load_agent(args.name)
    current_version = agent.config.version

    # Load eval tasks
    gym_a, tasks_data = _load_eval_tasks(Path(args.eval_file))
    gym_b, _ = _load_eval_tasks(Path(args.eval_file))
    gym_a.trials_per_task = args.trials
    gym_b.trials_per_task = args.trials

    # Check evolution ledger for version history
    evolution_dir = Path.cwd() / "data" / "evolution" / args.name
    ledger_path = evolution_dir / "ledger.json"

    version_configs: dict[str, dict] = {}
    if ledger_path.exists():
        try:
            ledger = json.loads(ledger_path.read_text())
            for entry in ledger.get("entries", []):
                v = entry.get("version", "")
                if v == version_a and "config_before" in entry:
                    version_configs[version_a] = entry["config_before"]
                if v == version_b and "config_after" in entry:
                    version_configs[version_b] = entry["config_after"]
                elif v == version_b:
                    version_configs[version_b] = entry.get("config_before", {})
        except Exception:
            pass

    # If versions not in ledger, use current config for both
    if version_a not in version_configs and version_b not in version_configs:
        print(f"Note: Version history not found in ledger. Running current config (v{current_version}) for both.")
        print(f"  The compare command works best after 'agentos evolve' has created version history.\n")

    print(f"Comparing agent '{args.name}': v{version_a} vs v{version_b}")
    print(f"  Eval: {args.eval_file} ({len(tasks_data)} tasks, {args.trials} trials)")
    print("=" * 60)

    # Run version A
    print(f"\n[A] Running v{version_a}...")
    report_a = await gym_a.run(_make_agent_fn(agent))

    # If we have a different config for version B, apply it
    if version_b in version_configs:
        from agentos.agent import Agent, AgentConfig
        config_b = AgentConfig.from_dict(version_configs[version_b])
        agent_b = Agent(config_b)
    else:
        agent_b = agent

    print(f"[B] Running v{version_b}...")
    report_b = await gym_b.run(_make_agent_fn(agent_b))

    # Compare results
    print(f"\n{'=' * 60}")
    print(f"{'Metric':<25s} {'v' + version_a:>15s} {'v' + version_b:>15s} {'Delta':>10s}")
    print(f"{'-' * 60}")

    metrics = [
        ("Pass rate", f"{report_a.pass_rate:.1%}", f"{report_b.pass_rate:.1%}",
         f"{(report_b.pass_rate - report_a.pass_rate):+.1%}"),
        ("Avg score", f"{report_a.avg_score:.3f}", f"{report_b.avg_score:.3f}",
         f"{(report_b.avg_score - report_a.avg_score):+.3f}"),
        ("Avg latency", f"{report_a.avg_latency_ms:.0f}ms", f"{report_b.avg_latency_ms:.0f}ms",
         f"{(report_b.avg_latency_ms - report_a.avg_latency_ms):+.0f}ms"),
        ("Total cost", f"${report_a.total_cost_usd:.4f}", f"${report_b.total_cost_usd:.4f}",
         f"${(report_b.total_cost_usd - report_a.total_cost_usd):+.4f}"),
    ]

    for name, val_a, val_b, delta in metrics:
        print(f"{name:<25s} {val_a:>15s} {val_b:>15s} {delta:>10s}")

    # Recommendation
    print(f"\n{'=' * 60}")
    if report_b.pass_rate > report_a.pass_rate:
        print(f"Recommendation: v{version_b} is better (higher pass rate)")
    elif report_b.pass_rate < report_a.pass_rate:
        print(f"Recommendation: v{version_a} is better (higher pass rate)")
    elif report_b.total_cost_usd < report_a.total_cost_usd:
        print(f"Recommendation: v{version_b} is better (same quality, lower cost)")
    else:
        print(f"Recommendation: No significant difference between versions")


def cmd_mcp_serve(args: argparse.Namespace) -> None:
    """Expose agents as MCP tool servers for Claude Code, Cursor, etc."""
    import sys

    from agentos.agent import list_agents

    agents = list_agents()
    if not agents:
        print("No agents found. Run 'agentos init' first.", file=sys.stderr)
        sys.exit(1)

    agent_filter = getattr(args, "agent", None)
    if agent_filter:
        agents = [a for a in agents if a.name == agent_filter]
        if not agents:
            print(f"Agent '{agent_filter}' not found", file=sys.stderr)
            sys.exit(1)

    # Build MCP tool list from agents
    tools = []
    for agent_config in agents:
        tools.append({
            "name": f"run-{agent_config.name}",
            "description": agent_config.description,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "Task to give the agent"},
                },
                "required": ["task"],
            },
        })

    print(f"AgentOS MCP Server", file=sys.stderr)
    print(f"  Exposing {len(tools)} agent(s) as MCP tools:", file=sys.stderr)
    for t in tools:
        print(f"    - {t['name']}: {t['description'][:60]}", file=sys.stderr)
    print(f"\n  Connect from Claude Code:", file=sys.stderr)
    print(f"    claude mcp add agentos -- agentos mcp-serve", file=sys.stderr)
    print(f"\n  Or add to .claude/settings.json:", file=sys.stderr)
    print(f'    "mcpServers": {{"agentos": {{"command": "agentos", "args": ["mcp-serve"]}}}}', file=sys.stderr)
    print(file=sys.stderr)

    # Run MCP stdio server
    _run_mcp_stdio(agents, tools)


def _run_mcp_stdio(agents: list, tools: list[dict]) -> None:
    """Run an MCP server over stdio (JSON-RPC)."""
    import sys
    import traceback

    class _ParseError(Exception):
        """Raised when a request cannot be parsed."""

    class _InvalidRequest(Exception):
        """Raised when a parsed request violates JSON-RPC request shape."""

    def _write_jsonrpc(payload: dict[str, Any]) -> None:
        resp = json.dumps(payload, ensure_ascii=False)
        resp_bytes = resp.encode("utf-8")
        sys.stdout.write(f"Content-Length: {len(resp_bytes)}\r\n\r\n")
        sys.stdout.buffer.write(resp_bytes)
        sys.stdout.flush()

    def _write_response(id: Any, result: Any) -> None:
        # JSON-RPC notifications do not have ids and must not receive responses.
        if id is None:
            return
        _write_jsonrpc({"jsonrpc": "2.0", "id": id, "result": result})

    def _write_error(id: Any, code: int, message: str, *, allow_null_id: bool = False) -> None:
        # For request errors (parse/invalid), JSON-RPC uses id=null.
        if id is None and not allow_null_id:
            return
        _write_jsonrpc({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message},
        })

    def _read_request() -> dict | None:
        stream = getattr(sys.stdin, "buffer", None)

        # MCP framing path: read bytes only to avoid text/buffer desync.
        if stream is not None:
            headers_bytes = bytearray()
            while True:
                ch = stream.read(1)
                if not ch:
                    if not headers_bytes:
                        return None
                    raise _ParseError("Unexpected EOF while reading headers")
                headers_bytes.extend(ch)
                if headers_bytes.endswith(b"\r\n\r\n") or headers_bytes.endswith(b"\n\n"):
                    break
                if len(headers_bytes) > 65536:
                    raise _InvalidRequest("MCP headers too large")

            header_text = headers_bytes.decode("latin-1", errors="replace")
            header_lines = [line.strip() for line in header_text.splitlines() if line.strip()]
            content_length: int | None = None
            for h in header_lines:
                if h.lower().startswith("content-length:"):
                    try:
                        content_length = int(h.split(":", 1)[1].strip())
                    except ValueError as exc:
                        raise _InvalidRequest("Invalid Content-Length header") from exc
                    break

            if content_length is None:
                # Compatibility fallback for JSON line inputs.
                first = header_lines[0] if header_lines else ""
                if not first:
                    return None
                try:
                    payload = json.loads(first)
                except json.JSONDecodeError as exc:
                    raise _ParseError(f"Invalid JSON payload: {exc}") from exc
            else:
                if content_length < 0:
                    raise _InvalidRequest("Content-Length cannot be negative")
                body_bytes = stream.read(content_length)
                if len(body_bytes) != content_length:
                    raise _ParseError("Unexpected EOF while reading request body")
                try:
                    payload = json.loads(body_bytes.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise _ParseError(f"Invalid JSON payload: {exc}") from exc
        else:
            # Plain JSON-line fallback for tests or non-framed clients.
            line = sys.stdin.readline()
            if not line:
                return None
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                raise _ParseError(f"Invalid JSON payload: {exc}") from exc

        if not isinstance(payload, dict):
            raise _InvalidRequest("Request must be a JSON object")
        return payload

    while True:
        try:
            request = _read_request()
            if request is None:
                break

            if request.get("jsonrpc") != "2.0":
                raise _InvalidRequest("Only JSON-RPC 2.0 requests are supported")

            method = request.get("method", "")
            req_id = request.get("id")
            if not isinstance(method, str) or not method:
                raise _InvalidRequest("Request method must be a non-empty string")

            if method == "initialize":
                _write_response(req_id, {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "agentos", "version": "0.2.0"},
                })

            elif method == "tools/list":
                _write_response(req_id, {"tools": tools})

            elif method == "tools/call":
                params = request.get("params", {})
                tool_name = params.get("name", "")
                arguments = params.get("arguments", {})
                task = arguments.get("task", "")

                # Find agent from tool name (run-<agent-name>)
                agent_name = tool_name.replace("run-", "", 1)

                try:
                    import asyncio
                    from agentos.agent import Agent
                    agent = Agent.from_name(agent_name)
                    results = asyncio.run(agent.run(task))
                    output = ""
                    for r in results:
                        if r.llm_response and r.llm_response.content:
                            output = r.llm_response.content
                    _write_response(req_id, {
                        "content": [{"type": "text", "text": output}],
                    })
                except Exception as exc:
                    _write_response(req_id, {
                        "content": [{"type": "text", "text": f"Error: {exc}"}],
                        "isError": True,
                    })

            elif method == "notifications/initialized":
                pass  # Acknowledgement, no response needed

            else:
                _write_error(req_id, -32601, f"Method not found: {method}")

        except _ParseError as exc:
            _write_error(None, -32700, f"Parse error: {exc}", allow_null_id=True)
        except _InvalidRequest as exc:
            _write_error(None, -32600, f"Invalid request: {exc}", allow_null_id=True)
        except (KeyboardInterrupt, EOFError):
            break
        except Exception as exc:
            # Keep server alive and return a protocol-level error.
            logger.debug("MCP stdio server error: %s\n%s", exc, traceback.format_exc())
            _write_error(None, -32000, f"Internal error: {exc}", allow_null_id=True)


def cmd_deploy(args: argparse.Namespace) -> None:
    """Deploy an agent to Cloudflare Workers."""
    import shutil
    import subprocess

    config = _load_agent_config(args.name)

    # Always write deploy scaffold into the current project directory
    deploy_dir = Path.cwd() / "deploy"
    package_deploy_dir = Path(__file__).resolve().parent.parent / "deploy"

    # Copy deploy scaffold from package to project if it doesn't exist locally
    if not deploy_dir.exists():
        if package_deploy_dir.exists():
            shutil.copytree(package_deploy_dir, deploy_dir)
            print(f"Copied deploy scaffold to {deploy_dir}")
        else:
            print("Error: No deploy/ scaffold found in the AgentOS package.", file=sys.stderr)
            sys.exit(1)

    # Validate governance structure before converting
    gov = config.governance
    if not isinstance(gov, dict):
        print(f"Error: Agent governance config is malformed (expected dict, got {type(gov).__name__})", file=sys.stderr)
        sys.exit(1)

    # Determine provider from env
    provider = ""
    if os.environ.get("ANTHROPIC_API_KEY"):
        provider = "anthropic"
    elif os.environ.get("OPENAI_API_KEY"):
        provider = "openai"
    else:
        provider = "workers-ai"

    # Convert Python agent config → CF worker config format
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
        "provider": provider,
        "model": config.model,
        "spentUsd": 0,
    }

    deploy_config_path = deploy_dir / "agent-config.json"
    try:
        deploy_config_path.write_text(json.dumps(cf_config, indent=2) + "\n")
    except OSError as exc:
        print(f"Error: Could not write deploy config: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Deploying agent '{config.name}' to Cloudflare Workers...")
    print(f"  Model: {config.model}")
    print(f"  Provider: {provider}")
    print(f"  Tools: {', '.join(str(t) for t in config.tools) or 'none'}")
    print(f"  Budget: ${gov.get('budget_limit_usd', 10.0)}")
    print(f"  System prompt: {config.system_prompt[:60]}...")
    print()

    # Check for required tools
    npm_path = shutil.which("npm")
    wrangler_path = shutil.which("wrangler")

    if not npm_path:
        print("Error: npm not found. Install Node.js to deploy.", file=sys.stderr)
        sys.exit(1)

    # Install dependencies
    print("[1/4] Installing dependencies...")
    try:
        subprocess.run(["npm", "install"], cwd=str(deploy_dir), check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        print(f"Error: npm install failed: {exc.stderr.decode()}", file=sys.stderr)
        sys.exit(1)

    # Use local wrangler if global not available
    if not wrangler_path:
        wrangler_path = str(deploy_dir / "node_modules" / ".bin" / "wrangler")
        if not Path(wrangler_path).exists():
            print("Error: wrangler not found. Install with: npm install -g wrangler", file=sys.stderr)
            sys.exit(1)

    # Create Vectorize index (ignore errors if it already exists)
    print("[2/4] Creating Vectorize index...")
    subprocess.run(
        [wrangler_path, "vectorize", "create", "agentos-knowledge", "--dimensions", "768", "--metric", "cosine"],
        cwd=str(deploy_dir), capture_output=True,
    )

    # Set secrets from environment
    print("[3/4] Configuring secrets...")
    for env_var, secret_name in [
        ("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
        ("OPENAI_API_KEY", "OPENAI_API_KEY"),
        ("E2B_API_KEY", "E2B_API_KEY"),
    ]:
        value = os.environ.get(env_var, "")
        if value:
            subprocess.run(
                [wrangler_path, "secret", "put", secret_name],
                input=value.encode(), cwd=str(deploy_dir), capture_output=True,
            )
            print(f"  Set {secret_name}")

    # Deploy
    print("[4/4] Deploying to Cloudflare Workers...")
    result = subprocess.run(
        [wrangler_path, "deploy"], cwd=str(deploy_dir), capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Deploy failed:\n{result.stderr}", file=sys.stderr)
        print("\nAgent config written to:", deploy_config_path)
        print("You can retry manually: cd deploy && npx wrangler deploy")
        sys.exit(1)

    # Extract worker URL from output (look for workers.dev URLs specifically)
    import re as _re
    worker_url = ""
    for line in result.stdout.splitlines():
        urls = _re.findall(r"https://[^\s]*\.workers\.dev[^\s]*", line)
        if urls:
            worker_url = urls[0].rstrip(".")
            break

    print()
    if worker_url:
        print(f"Deployed successfully to: {worker_url}")
        print(f"\n  Health: curl {worker_url}/agents/agentos/{config.name}/health")
        print(f"  Run:    curl -X POST {worker_url}/agents/agentos/{config.name}/run \\")
        print(f'            -H "Content-Type: application/json" -d \'{{"input":"hello"}}\'')
    else:
        print("Deploy completed. Check wrangler output for your Worker URL.")
        print(result.stdout)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _load_agent(name: str):
    """Load an agent from a name or file path."""
    from agentos.agent import Agent

    path = Path(name)
    if path.exists() and path.is_file():
        return Agent.from_file(path)
    return Agent.from_name(name)


def _load_agent_config(name: str):
    """Load an agent config from a name or file path.

    For most commands, prefer ``_load_agent()`` which returns a full
    ``Agent`` instance with observability attached. This function is
    only for commands that need the config without running the agent
    (e.g. ``deploy``).
    """
    from agentos.agent import load_agent_config, _resolve_agents_dir

    path = Path(name)
    if path.exists() and path.is_file():
        return load_agent_config(path)

    agents_dir = _resolve_agents_dir()
    for ext in (".yaml", ".yml", ".json"):
        p = agents_dir / f"{name}{ext}"
        if p.exists():
            return load_agent_config(p)

    raise FileNotFoundError(f"Agent '{name}' not found")


def _load_plan(plan_name: str) -> dict[str, dict[str, Any]] | None:
    """Load an LLM plan — checks project agentos.yaml first, then config/default.json."""
    # 1. Check project-level custom plans (agentos.yaml)
    project_yaml = Path.cwd() / "agentos.yaml"
    if project_yaml.exists():
        try:
            try:
                import yaml
                data = yaml.safe_load(project_yaml.read_text()) or {}
            except ImportError:
                data = {}
            custom_plans = data.get("plans", {})
            if plan_name in custom_plans:
                plan = custom_plans[plan_name]
                return {k: v for k, v in plan.items() if not k.startswith("_")}
        except Exception:
            pass

    # 2. Check built-in plans (config/default.json)
    config_path = Path(__file__).resolve().parent.parent / "config" / "default.json"
    if not config_path.exists():
        return None
    try:
        raw = json.loads(config_path.read_text())
        plans = raw.get("llm", {}).get("plans", {})
        plan = plans.get(plan_name)
        if plan:
            return {k: v for k, v in plan.items() if not k.startswith("_")}
        return None
    except Exception:
        return None


def _list_plans() -> dict[str, str]:
    """List all available plans with descriptions."""
    plans: dict[str, str] = {}

    # Built-in plans
    config_path = Path(__file__).resolve().parent.parent / "config" / "default.json"
    if config_path.exists():
        try:
            raw = json.loads(config_path.read_text())
            for name, plan in raw.get("llm", {}).get("plans", {}).items():
                plans[name] = plan.get("_description", "")
        except Exception:
            pass

    # Project custom plans
    project_yaml = Path.cwd() / "agentos.yaml"
    if project_yaml.exists():
        try:
            try:
                import yaml
                data = yaml.safe_load(project_yaml.read_text()) or {}
            except ImportError:
                data = {}
            for name, plan in data.get("plans", {}).items():
                plans[f"{name} (custom)"] = plan.get("_description", "Custom plan")
        except Exception:
            pass

    return plans


def _apply_plan_to_agent(agent, plan_name: str) -> None:
    """Override an agent's LLM router with a plan's routing config."""
    plan = _load_plan(plan_name)
    if not plan:
        print(f"Warning: Plan '{plan_name}' not found, using default routing", file=sys.stderr)
        return

    from agentos.llm.router import Complexity
    from agentos.llm.provider import HttpProvider

    gmi_key = os.environ.get("GMI_API_KEY", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")

    for tier in Complexity:
        tier_cfg = plan.get(tier.value, {})
        tier_model = tier_cfg.get("model", "")
        tier_provider = tier_cfg.get("provider", "gmi")
        tier_max_tokens = tier_cfg.get("max_tokens", 4096)

        provider = None
        if tier_provider == "gmi" and gmi_key:
            provider = HttpProvider(model_id=tier_model, api_base="https://api.gmi-serving.com/v1", api_key=gmi_key)
        elif tier_provider == "anthropic" and anthropic_key:
            provider = HttpProvider(model_id=tier_model, api_base="https://api.anthropic.com", api_key=anthropic_key, headers={"anthropic-version": "2023-06-01"})
        elif tier_provider == "openai" and openai_key:
            provider = HttpProvider(model_id=tier_model, api_base="https://api.openai.com", api_key=openai_key)
        # Fallback to GMI if available
        if provider is None and gmi_key:
            provider = HttpProvider(model_id=tier_model, api_base="https://api.gmi-serving.com/v1", api_key=gmi_key)

        if provider is not None:
            agent._harness.llm_router.register(tier, provider, max_tokens=tier_max_tokens)


def _get_grader_provider():
    """Get an LLM provider for the LLMGrader — uses the cheapest available model."""
    from agentos.llm.provider import HttpProvider

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")

    if anthropic_key:
        return HttpProvider(
            model_id="claude-haiku-4-5-20251001",
            api_base="https://api.anthropic.com",
            api_key=anthropic_key,
        )
    elif openai_key:
        return HttpProvider(
            model_id="gpt-4o-mini",
            api_base="https://api.openai.com",
            api_key=openai_key,
        )
    return None  # LLMGrader will fall back to heuristic


def _warn_identity_mismatch(agent) -> None:
    """Warn if agent_id doesn't match project identity (.identity.json).

    Shared by cmd_run and cmd_chat to avoid duplication.
    """
    identity_path = Path.cwd() / "agents" / ".identity.json"
    if not identity_path.exists() or not agent.config.agent_id:
        return
    try:
        project_id = json.loads(identity_path.read_text()).get("agent_id", "")
        if project_id and agent.config.agent_id != project_id:
            print(f"Warning: Agent '{agent.config.name}' has agent_id "
                  f"'{agent.config.agent_id}' but project identity is "
                  f"'{project_id}'.", file=sys.stderr)
    except (json.JSONDecodeError, OSError):
        pass


def _warn_stub_provider(agent, *, show_recreate_hint: bool = False) -> None:
    """Warn about stub provider usage.

    Shared by cmd_run and cmd_chat. ``show_recreate_hint`` adds the
    extra message about re-creating stub-built agents (cmd_run only).
    """
    if not agent.uses_stub_provider:
        return
    print("Note: No LLM API key found — using stub provider (responses will be placeholders).")
    print("  Set ANTHROPIC_API_KEY or OPENAI_API_KEY for real responses.")
    if show_recreate_hint and agent.config.built_with == "stub":
        print("  This agent was also created with the stub provider —")
        print("  re-create it with a real LLM for better results:")
        print(f"    agentos create --one-shot \"{agent.config.description}\"")
    print()


def _oauth_device_flow(provider: str):
    """Run OAuth device code flow for a given provider.

    Shared by GitHub and Google login paths to avoid 21 lines of
    near-identical code. Returns (access_token, user) or exits.
    """
    from agentos.auth import oauth

    # Dispatch to provider-specific functions
    request_fn = getattr(oauth, f"{provider}_request_device_code")
    poll_fn = getattr(oauth, f"{provider}_poll_for_token")
    user_fn = getattr(oauth, f"{provider}_get_user")

    dc = request_fn()
    print(f"  Open this URL in your browser:  {dc.verification_uri}")
    print(f"  Enter this code:                {dc.user_code}")
    print()
    print("Waiting for authorization...", end="", flush=True)

    access_token = poll_fn(
        dc.device_code, interval=dc.interval, timeout=dc.expires_in
    )
    if not access_token:
        print("\nAuthorization failed or timed out.")
        sys.exit(1)

    user = user_fn(access_token)
    return access_token, user


def _exchange_token_with_server(
    server_url: str, oauth_token: str, provider: str, user: Any
) -> str:
    """Exchange an OAuth access token with a remote AgentOS server for a server-signed JWT.

    The server verifies the OAuth token, creates a user record if needed,
    and returns a JWT signed with its own secret.
    """
    import urllib.error
    import urllib.request

    url = f"{server_url.rstrip('/')}/auth/token/exchange"
    payload = json.dumps({
        "oauth_token": oauth_token,
        "provider": provider,
        "user_id": user.id,
        "email": user.email,
        "name": user.name,
    }).encode()

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data["token"]
    except (urllib.error.HTTPError, urllib.error.URLError, KeyError) as exc:
        print(f"Warning: Could not exchange token with server {server_url}: {exc}")
        print("  Falling back to local JWT (may not work with this server).")
        from agentos.auth.jwt import create_token
        return create_token(
            user_id=user.id,
            email=user.email,
            name=user.name,
            provider=user.provider,
        )


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
            model_id=model or DEFAULT_MODEL,
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
