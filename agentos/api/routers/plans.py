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

    all_tiers = ["simple", "moderate", "complex", "tool_call", "image_gen", "vision", "tts", "stt"]
    result = {}
    for name, plan in plans.items():
        tiers = {}
        for tier in all_tiers:
            if tier in plan:
                tier_data: dict[str, Any] = {
                    "model": plan[tier].get("model", ""),
                    "provider": plan[tier].get("provider", ""),
                }
                if "max_tokens" in plan[tier]:
                    tier_data["max_tokens"] = plan[tier]["max_tokens"]
                if "per_request" in plan[tier]:
                    tier_data["per_request"] = plan[tier]["per_request"]
                if plan[tier].get("dedicated"):
                    tier_data["dedicated"] = True
                tiers[tier] = tier_data
        result[name] = {
            "description": plan.get("_description", ""),
            "tiers": tiers,
            "multimodal": any(t in plan for t in ["image_gen", "vision", "tts", "stt"]),
        }

    return {"plans": result}


@router.post("")
async def create_plan(
    name: str,
    simple_model: str,
    moderate_model: str,
    complex_model: str,
    tool_call_model: str = "",
    provider: str = "openrouter",
):
    """Create a custom LLM plan."""
    try:
        import yaml
        project_yaml = Path.cwd() / "agentos.yaml"
        if project_yaml.exists():
            data = yaml.safe_load(project_yaml.read_text()) or {}
        else:
            data = {}
        if "plans" not in data:
            data["plans"] = {}
        data["plans"][name] = {
            "_description": f"Custom plan: {name}",
            "simple": {"provider": provider, "model": simple_model, "max_tokens": 1024},
            "moderate": {"provider": provider, "model": moderate_model, "max_tokens": 4096},
            "complex": {"provider": provider, "model": complex_model, "max_tokens": 8192},
            "tool_call": {"provider": provider, "model": tool_call_model or moderate_model, "max_tokens": 4096},
        }
        project_yaml.write_text(yaml.dump(data, default_flow_style=False, sort_keys=False))
        return {"created": name}
    except ImportError:
        return {"error": "PyYAML required for custom plans"}


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
