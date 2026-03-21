"""AgentOS CLI — the user-facing command line interface.

Usage:
    agentos init                    — Scaffold a new agent project
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

    # --- deploy ---
    deploy_p = sub.add_parser("deploy", help="Deploy an agent")
    deploy_p.add_argument("name", help="Agent name or path")

    args = parser.parse_args()

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
        elif args.command == "deploy":
            cmd_deploy(args)
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(1)


# ── Commands ──────────────────────────────────────────────────────────────────


def cmd_init(args: argparse.Namespace) -> None:
    """Scaffold a new agent project."""
    directory = Path(args.directory).resolve()
    print(f"Initializing AgentOS project in {directory}")

    # Create directory structure
    (directory / "agents").mkdir(parents=True, exist_ok=True)
    (directory / "tools").mkdir(parents=True, exist_ok=True)
    (directory / "data").mkdir(parents=True, exist_ok=True)

    # Create a starter agent definition
    starter = {
        "name": "my-agent",
        "description": "A starter agent — customize me!",
        "system_prompt": "You are a helpful AI assistant. Be concise and accurate.",
        "model": "claude-sonnet-4-20250514",
        "tools": [],
        "governance": {
            "budget_limit_usd": 10.0,
            "require_confirmation_for_destructive": True,
        },
        "tags": ["starter"],
    }
    agent_path = directory / "agents" / "my-agent.json"
    if not agent_path.exists():
        agent_path.write_text(json.dumps(starter, indent=2) + "\n")

    # Create a starter tool plugin
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
    tool_path = directory / "tools" / "example-search.json"
    if not tool_path.exists():
        tool_path.write_text(json.dumps(tool_example, indent=2) + "\n")

    print(f"  Created agents/my-agent.json")
    print(f"  Created tools/example-search.json")
    print(f"  Created data/ directory")
    print()
    print("Next steps:")
    print("  1. Edit agents/my-agent.json to define your agent")
    print("  2. Add tools to the tools/ directory")
    print("  3. Run: agentos create   (to build an agent via conversation)")
    print("  4. Run: agentos run my-agent \"your task here\"")


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
        # Read from stdin if no task provided
        try:
            task = input("Task: ").strip()
        except EOFError:
            print("No task provided.")
            return
        if not task:
            print("No task provided.")
            return

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

    print(f"{'Name':<25} {'Description':<40} {'Model':<25}")
    print("-" * 90)
    for a in agents:
        desc = (a.description[:37] + "...") if len(a.description) > 40 else a.description
        print(f"{a.name:<25} {desc:<40} {a.model:<25}")


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


def cmd_deploy(args: argparse.Namespace) -> None:
    """Deploy an agent to Cloudflare Workers."""
    from agentos.agent import AgentConfig, load_agent_config

    config = _load_agent_config(args.name)

    deploy_dir = Path(__file__).resolve().parent.parent / "deploy"
    if not deploy_dir.exists():
        print("Error: deploy/ directory not found. Run from the AgentOS root.")
        sys.exit(1)

    print(f"Deploying agent '{config.name}' to Cloudflare Workers...")
    print(f"  Model: {config.model}")
    print(f"  Tools: {', '.join(str(t) for t in config.tools) or 'none'}")
    print(f"  Budget: ${config.governance.get('budget_limit_usd', 10.0)}")
    print()
    print(f"Run the following from the deploy/ directory:")
    print(f"  cd deploy && npm run setup")
    print()
    print(f"The agent config has been written to deploy/agent-config.json")

    # Write the agent config for the CF worker to pick up
    deploy_config_path = deploy_dir / "agent-config.json"
    deploy_config_path.write_text(json.dumps(config.to_dict(), indent=2) + "\n")


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
