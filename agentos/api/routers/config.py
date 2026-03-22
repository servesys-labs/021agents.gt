"""Config router — project configuration, health, A2A management."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user

router = APIRouter(tags=["config"])

_start_time = time.time()


@router.get("/health")
async def health():
    """Health check with version and uptime."""
    from agentos import __version__
    return {
        "status": "ok",
        "version": __version__,
        "uptime_seconds": round(time.time() - _start_time, 1),
    }


@router.get("/config")
async def get_config():
    """Get project configuration (agentos.yaml)."""
    config_path = Path.cwd() / "agentos.yaml"
    if not config_path.exists():
        return {"config": {}, "exists": False}
    try:
        try:
            import yaml
            data = yaml.safe_load(config_path.read_text()) or {}
        except ImportError:
            data = {"raw": config_path.read_text()}
        return {"config": data, "exists": True}
    except Exception as e:
        return {"config": {}, "error": str(e)}


@router.put("/config")
async def update_config(updates: dict[str, Any], user: CurrentUser = Depends(get_current_user)):
    """Update project configuration."""
    config_path = Path.cwd() / "agentos.yaml"
    try:
        import yaml
        data = yaml.safe_load(config_path.read_text()) or {} if config_path.exists() else {}
        data.update(updates)
        config_path.write_text(yaml.dump(data, default_flow_style=False, sort_keys=False))
        return {"updated": True}
    except ImportError:
        raise HTTPException(status_code=503, detail="PyYAML required")


@router.get("/a2a/remotes")
async def list_remote_a2a_agents():
    """List known remote A2A agent endpoints."""
    # Stored in project config
    config_path = Path.cwd() / "agentos.yaml"
    if not config_path.exists():
        return {"remotes": []}
    try:
        import yaml
        data = yaml.safe_load(config_path.read_text()) or {}
        return {"remotes": data.get("a2a_remotes", [])}
    except Exception:
        return {"remotes": []}


@router.post("/a2a/test")
async def test_a2a_connection(url: str):
    """Test connectivity to a remote A2A agent."""
    from agentos.a2a.client import A2AClient
    try:
        client = A2AClient(url)
        card = await client.discover()
        return {
            "reachable": True,
            "agent": card.get("name", "unknown"),
            "description": card.get("description", ""),
            "capabilities": card.get("capabilities", {}),
            "skills": len(card.get("skills", [])),
        }
    except Exception as exc:
        return {"reachable": False, "error": str(exc)}
