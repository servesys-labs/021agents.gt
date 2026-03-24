"""Gold Images router — CRUD, drift detection, compliance checks, config audit."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/gold-images", tags=["gold-images"])


# ── Static routes FIRST (before /{image_id} catch-all) ───────────


@router.get("")
async def list_gold_images(
    active_only: bool = True,
    user: CurrentUser = Depends(get_current_user),
):
    """List all gold images for the org."""
    db = _get_db()
    images = db.list_gold_images(org_id=user.org_id, active_only=active_only)
    for img in images:
        img.pop("config", None)
        img.pop("config_json", None)
    return {"images": images}


@router.post("")
async def create_gold_image(
    body: dict[str, Any],
    user: CurrentUser = Depends(get_current_user),
):
    """Create a new gold image from a config."""
    name = body.get("name", "")
    config = body.get("config", {})
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if not config:
        raise HTTPException(status_code=400, detail="config is required")

    from agentos.config.gold_image import GoldImageManager
    db = _get_db()
    manager = GoldImageManager(db)
    result = manager.create(
        name=name,
        config=config,
        org_id=user.org_id,
        description=body.get("description", ""),
        version=body.get("version", "1.0.0"),
        category=body.get("category", "general"),
        created_by=user.user_id,
    )
    return result


@router.get("/audit")
async def config_audit_log(
    agent_name: str = "",
    limit: int = 100,
    user: CurrentUser = Depends(get_current_user),
):
    """Get config change audit trail."""
    db = _get_db()
    entries = db.list_config_audit(
        org_id=user.org_id,
        agent_name=agent_name,
        limit=min(200, max(1, limit)),
    )
    return {"entries": entries}


@router.post("/from-agent/{agent_name}")
async def create_from_agent(
    agent_name: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a gold image from an existing agent's current config."""
    from agentos.config.gold_image import GoldImageManager

    db = _get_db()

    import json as _json
    from pathlib import Path
    agent_path = Path("agents") / f"{agent_name}.json"
    if agent_path.exists():
        config = _json.loads(agent_path.read_text())
    else:
        try:
            from agentos.agent import load_agent_config
            config = load_agent_config(agent_name)
        except Exception:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    manager = GoldImageManager(db)
    result = manager.create_from_agent(
        agent_config=config,
        org_id=user.org_id,
        created_by=user.user_id,
    )
    return result


# ── Compliance routes (static paths before /{image_id}) ──────────


@router.get("/compliance/summary")
async def compliance_summary(
    user: CurrentUser = Depends(get_current_user),
):
    """Get aggregate compliance summary."""
    from agentos.config.compliance import ComplianceChecker

    db = _get_db()
    checker = ComplianceChecker(db)
    return checker.compliance_summary(org_id=user.org_id)


@router.get("/compliance/checks")
async def list_compliance_checks(
    agent_name: str = "",
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List compliance check history."""
    db = _get_db()
    checks = db.list_compliance_checks(
        org_id=user.org_id,
        agent_name=agent_name,
        limit=min(200, max(1, limit)),
    )
    return {"checks": checks}


@router.post("/compliance/check/{agent_name}")
async def check_compliance(
    agent_name: str,
    image_id: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Check an agent's compliance against gold images."""
    from agentos.config.compliance import ComplianceChecker
    import json as _json
    from pathlib import Path

    db = _get_db()

    agent_path = Path("agents") / f"{agent_name}.json"
    if agent_path.exists():
        agent_config = _json.loads(agent_path.read_text())
    else:
        try:
            from agentos.agent import load_agent_config
            agent_config = load_agent_config(agent_name)
        except Exception:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    checker = ComplianceChecker(db)
    report = checker.check_agent(
        agent_name=agent_name,
        agent_config=agent_config,
        image_id=image_id,
        org_id=user.org_id,
        checked_by=user.user_id,
    )
    return report.to_dict()


@router.post("/drift/{agent_name}/{image_id}")
async def detect_drift(
    agent_name: str,
    image_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Detect drift between an agent and a specific gold image."""
    from agentos.config.drift import DriftDetector
    import json as _json
    from pathlib import Path

    db = _get_db()

    agent_path = Path("agents") / f"{agent_name}.json"
    if agent_path.exists():
        agent_config = _json.loads(agent_path.read_text())
    else:
        try:
            from agentos.agent import load_agent_config
            agent_config = load_agent_config(agent_name)
        except Exception:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    gold = db.get_gold_image(image_id)
    if not gold:
        raise HTTPException(status_code=404, detail="Gold image not found")

    detector = DriftDetector()
    report = detector.detect(
        agent_config=agent_config,
        gold_config=gold.get("config", {}),
        agent_name=agent_name,
        image_id=image_id,
        image_name=gold.get("name", ""),
    )
    return report.to_dict()


# ── Dynamic /{image_id} routes LAST ──────────────────────────────


@router.get("/{image_id}")
async def get_gold_image(
    image_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get a specific gold image with full config."""
    db = _get_db()
    image = db.get_gold_image(image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Gold image not found")
    return image


@router.put("/{image_id}")
async def update_gold_image(
    image_id: str,
    body: dict[str, Any],
    user: CurrentUser = Depends(get_current_user),
):
    """Update a gold image."""
    from agentos.config.gold_image import GoldImageManager

    db = _get_db()
    manager = GoldImageManager(db)
    result = manager.update(
        image_id=image_id,
        config=body.get("config"),
        name=body.get("name"),
        description=body.get("description"),
        version=body.get("version"),
        updated_by=user.user_id,
        org_id=user.org_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Gold image not found")
    return result


@router.post("/{image_id}/approve")
async def approve_gold_image(
    image_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Approve a gold image for compliance enforcement."""
    from agentos.config.gold_image import GoldImageManager

    db = _get_db()
    manager = GoldImageManager(db)
    success = manager.approve(image_id, approved_by=user.user_id, org_id=user.org_id)
    if not success:
        raise HTTPException(status_code=404, detail="Gold image not found")
    return {"approved": True, "image_id": image_id}


@router.delete("/{image_id}")
async def delete_gold_image(
    image_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Delete a gold image."""
    from agentos.config.gold_image import GoldImageManager

    db = _get_db()
    manager = GoldImageManager(db)
    success = manager.delete(image_id, deleted_by=user.user_id, org_id=user.org_id)
    if not success:
        raise HTTPException(status_code=404, detail="Gold image not found")
    return {"deleted": True, "image_id": image_id}
