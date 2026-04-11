"""AgentOS CLI — minimal developer surface.

The Python runtime and builder have moved to TypeScript (control-plane + deploy).
This file is deliberately small: it exposes only `agentos codemap`, which uses
`agentos.analysis.codemap` to regenerate the repo's code-graph artifacts
(data/codemap.json, docs/codemap.dot, docs/codemap.svg) for humans and agents
browsing the repo.

All other legacy commands (create, run, chat, deploy, eval, evolve, ingest,
issues, etc.) have been removed — the live paths live in:
  - UI + control-plane for agent authoring, running, eval, evolution
  - Postgres/pgvector for RAG
  - Cloudflare Workers (deploy/) for runtime execution

If a Python entry point for something becomes necessary again, add a new
cmd_* function here and wire it into the dispatcher.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentos",
        description="AgentOS repository tools.",
    )
    sub = parser.add_subparsers(dest="command")

    codemap_p = sub.add_parser(
        "codemap",
        help="Generate code dependency and feature maps",
    )
    codemap_p.add_argument(
        "--root",
        type=str,
        default=".",
        help="Repository root (default: current directory)",
    )
    codemap_p.add_argument(
        "--json-out",
        type=str,
        default="data/codemap.json",
        help="JSON output path",
    )
    codemap_p.add_argument(
        "--dot-out",
        type=str,
        default="docs/codemap.dot",
        help="DOT output path",
    )
    codemap_p.add_argument(
        "--svg-out",
        type=str,
        default="docs/codemap.svg",
        help="SVG output path",
    )
    codemap_p.add_argument(
        "--no-portal",
        action="store_true",
        help="Skip portal TypeScript route/dependency analysis",
    )

    return parser


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


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "codemap":
        cmd_codemap(args)
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
