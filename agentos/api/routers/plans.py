"""Plans router — list and create LLM plans."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/plans", tags=["plans"])


@router.get("")
async def list_plans():
    """List all available LLM plans."""
    config_path = Path(__file__).resolve().parent.parent.parent.parent / "config" / "default.json"
    if not config_path.exists():
        return {"plans": {}}
    raw = json.loads(config_path.read_text())
    plans = raw.get("llm", {}).get("plans", {})

    result = {}
    for name, plan in plans.items():
        tiers = {}
        for tier in ["simple", "moderate", "complex", "tool_call"]:
            if tier in plan:
                tiers[tier] = {
                    "model": plan[tier].get("model", ""),
                    "provider": plan[tier].get("provider", ""),
                    "max_tokens": plan[tier].get("max_tokens", 4096),
                }
        result[name] = {
            "description": plan.get("_description", ""),
            "tiers": tiers,
        }

    return {"plans": result}


@router.get("/{name}")
async def get_plan(name: str):
    """Get details of a specific plan."""
    config_path = Path(__file__).resolve().parent.parent.parent.parent / "config" / "default.json"
    if not config_path.exists():
        return {"error": "Config not found"}
    raw = json.loads(config_path.read_text())
    plan = raw.get("llm", {}).get("plans", {}).get(name)
    if not plan:
        return {"error": f"Plan '{name}' not found"}
    return {"name": name, "plan": plan}
