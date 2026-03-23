"""Projects router — org → project → agents hierarchy."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.agent import AgentConfig, list_agents, save_agent_config
from agentos.defaults import AGENT_TEMPLATES, DEFAULT_MODEL

router = APIRouter(prefix="/projects", tags=["projects"])
logger = logging.getLogger(__name__)


def _project_plan_to_agent_plan(project_plan: str) -> str:
    """Map project commercial tiers to runtime routing plans."""
    mapping = {
        "starter": "basic",
        "standard": "standard",
        "pro": "premium",
        "enterprise": "premium",
    }
    return mapping.get(project_plan, "standard")


def _bootstrap_project_meta_agent(
    *,
    project_id: str,
    slug: str,
    project_name: str,
    project_description: str,
    project_plan: str,
) -> dict[str, Any]:
    """Create (or reuse) a project-scoped orchestrator meta-agent."""
    base_name = f"{slug}-meta-agent".strip("-") or f"project-{project_id[:8]}-meta-agent"
    existing_names = {a.name for a in list_agents()}
    if base_name in existing_names:
        return {"name": base_name, "created": False}

    agent_name = base_name

    tpl = AGENT_TEMPLATES["orchestrator"]
    project_context = (
        f"\n\n## Project Context\n"
        f"- project_id: {project_id}\n"
        f"- project_name: {project_name}\n"
        f"- project_slug: {slug}\n"
        f"- plan: {project_plan}\n"
        f"- description: {project_description or 'n/a'}\n"
        f"Prioritize work and recommendations for this project context."
    )
    config = AgentConfig(
        name=agent_name,
        description=f"Project Meta-Agent for {project_name}",
        system_prompt=f"{tpl['system_prompt']}{project_context}",
        model=DEFAULT_MODEL,
        tools=list(tpl["tools"]),
        governance={
            **tpl["governance"],
            "budget_limit_usd": float(tpl["governance"].get("budget_limit_usd", 20.0)),
        },
        memory=tpl["memory"],
        max_turns=int(tpl.get("max_turns", 50)),
        tags=list(dict.fromkeys([*tpl["tags"], "project-meta-agent", f"project:{project_id}"])),
        plan=_project_plan_to_agent_plan(project_plan),
    )
    save_agent_config(config)
    return {"name": config.name, "created": True}


def _require_project_org(project_id: str, user: CurrentUser) -> dict[str, Any]:
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM projects WHERE project_id = ? AND org_id = ?",
        (project_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return dict(row)


@router.get("")
async def list_projects(user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC", (user.org_id,)
    ).fetchall()
    return {"projects": [dict(r) for r in rows]}


@router.post("")
async def create_project(name: str, description: str = "", plan: str = "standard",
                         user: CurrentUser = Depends(get_current_user)):
    allowed_plans = {"starter", "standard", "pro", "enterprise"}
    if plan not in allowed_plans:
        raise HTTPException(status_code=400, detail="Invalid plan")
    db = _get_db()
    project_id = uuid.uuid4().hex[:16]
    slug = name.lower().replace(" ", "-")
    db.conn.execute(
        """INSERT INTO projects (project_id, org_id, name, slug, description, default_plan)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (project_id, user.org_id, name, slug, description, plan),
    )
    # Create default environments
    for env_name in ("development", "staging", "production"):
        db.conn.execute(
            "INSERT INTO environments (env_id, project_id, name) VALUES (?, ?, ?)",
            (uuid.uuid4().hex[:16], project_id, env_name),
        )
    db.conn.commit()
    meta_agent: dict[str, Any] | None = None
    try:
        meta_agent = _bootstrap_project_meta_agent(
            project_id=project_id,
            slug=slug,
            project_name=name,
            project_description=description,
            project_plan=plan,
        )
    except Exception as exc:
        logger.warning("Project %s created but meta-agent bootstrap failed: %s", project_id, exc)
        meta_agent = {"name": "", "created": False, "error": "bootstrap_failed"}
    db.audit("project.create", user_id=user.user_id, org_id=user.org_id,
             resource_type="project", resource_id=project_id, changes={"name": name})
    return {
        "project_id": project_id,
        "name": name,
        "slug": slug,
        "envs": ["development", "staging", "production"],
        "meta_agent": meta_agent,
    }


@router.get("/{project_id}")
async def get_project(project_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    row = _require_project_org(project_id, user)
    envs = db.conn.execute("SELECT * FROM environments WHERE project_id = ?", (project_id,)).fetchall()
    return {"project": row, "environments": [dict(e) for e in envs]}


@router.get("/{project_id}/envs")
async def list_environments(project_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    _require_project_org(project_id, user)
    rows = db.conn.execute("SELECT * FROM environments WHERE project_id = ?", (project_id,)).fetchall()
    return {"environments": [dict(r) for r in rows]}


@router.put("/{project_id}/envs/{env_name}")
async def update_environment(project_id: str, env_name: str, plan: str = "",
                             provider_config: dict[str, Any] | None = None,
                             user: CurrentUser = Depends(get_current_user)):
    _require_project_org(project_id, user)
    db = _get_db()
    updates, params = [], []
    if plan:
        updates.append("plan = ?")
        params.append(plan)
    if provider_config is not None:
        updates.append("provider_config_json = ?")
        params.append(json.dumps(provider_config))
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    params.extend([project_id, env_name])
    db.conn.execute(f"UPDATE environments SET {', '.join(updates)} WHERE project_id = ? AND name = ?", params)
    db.conn.commit()
    return {"updated": env_name}
