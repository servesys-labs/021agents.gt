"""Skills router — list, enable/disable, and query skills."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agentos.api.deps import _get_db
from agentos.api.schemas import SkillResponse, SkillUpdateRequest
from agentos.skills.loader import SkillLoader

router = APIRouter(prefix="/skills", tags=["skills"])

# Module-level loader (lazy init)
_loader: SkillLoader | None = None


def _get_loader() -> SkillLoader:
    global _loader
    if _loader is None:
        _loader = SkillLoader()
        _loader.load()
    return _loader


@router.get("", response_model=list[SkillResponse])
async def list_skills():
    """List all loaded skills with their enabled state."""
    loader = _get_loader()
    return [
        SkillResponse(**s.to_dict())
        for s in loader.all_skills()
    ]


@router.get("/{name}", response_model=SkillResponse)
async def get_skill(name: str):
    """Get a specific skill by name."""
    loader = _get_loader()
    skill = loader.get(name)
    if not skill:
        raise HTTPException(404, f"Skill '{name}' not found")
    return SkillResponse(**skill.to_dict())


@router.put("/{name}", response_model=SkillResponse)
async def update_skill(name: str, req: SkillUpdateRequest):
    """Enable or disable a skill."""
    loader = _get_loader()
    found = loader.set_enabled(name, req.enabled)
    if not found:
        raise HTTPException(404, f"Skill '{name}' not found")

    skill = loader.get(name)

    # Persist to DB if available
    db = _get_db()
    if db:
        db.upsert_skill(skill.to_dict())

    return SkillResponse(**skill.to_dict())


@router.post("/reload")
async def reload_skills():
    """Reload all skills from the filesystem."""
    loader = _get_loader()
    skills = loader.load()

    # Sync to DB
    db = _get_db()
    if db:
        for s in skills:
            db.upsert_skill(s.to_dict())

    return {
        "total": len(skills),
        "enabled": sum(1 for s in skills if s.enabled),
        "skills": [s.name for s in skills],
    }
