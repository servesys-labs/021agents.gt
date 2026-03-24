"""Issues router — auto-detected issues, classification, remediation, lifecycle."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/issues", tags=["issues"])


class CreateIssueRequest(BaseModel):
    agent_name: str = ""
    title: str = Field(..., min_length=1, max_length=500)
    description: str = ""
    category: str = "unknown"
    severity: str = "low"
    source_session_id: str = ""


class UpdateIssueRequest(BaseModel):
    status: str | None = None
    severity: str | None = None
    category: str | None = None
    assigned_to: str | None = None
    suggested_fix: str | None = None


# ── Static routes first ──────────────────────────────────────────


@router.get("/summary")
async def issue_summary(
    agent_name: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Get aggregate issue summary."""
    db = _get_db()
    return db.issue_summary(org_id=user.org_id, agent_name=agent_name)


@router.get("")
async def list_issues(
    agent_name: str = "",
    status: str = "",
    category: str = "",
    severity: str = "",
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List issues with optional filters."""
    db = _get_db()
    issues = db.list_issues(
        org_id=user.org_id,
        agent_name=agent_name,
        status=status,
        category=category,
        severity=severity,
        limit=min(200, max(1, limit)),
    )
    return {"issues": issues}


@router.post("")
async def create_issue(
    request: CreateIssueRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Manually create an issue."""
    import uuid
    from agentos.issues.classifier import IssueClassifier
    from agentos.issues.remediation import RemediationEngine

    db = _get_db()
    issue_id = uuid.uuid4().hex[:16]

    # Auto-classify if category is unknown
    classifier = IssueClassifier()
    classification = classifier.classify(
        title=request.title,
        description=request.description,
        existing_category=request.category,
        existing_severity=request.severity,
    )

    # Generate fix suggestion
    engine = RemediationEngine()
    issue_data = {
        "category": classification["category"],
        "title": request.title,
        "description": request.description,
    }
    suggested_fix = engine.suggest_fix(issue_data)

    db.insert_issue(
        issue_id=issue_id,
        org_id=user.org_id,
        agent_name=request.agent_name,
        title=request.title,
        description=request.description,
        category=classification["category"],
        severity=classification["severity"],
        source="manual",
        source_session_id=request.source_session_id,
        suggested_fix=suggested_fix,
    )

    return {
        "issue_id": issue_id,
        "category": classification["category"],
        "severity": classification["severity"],
        "suggested_fix": suggested_fix,
    }


@router.post("/detect/{session_id}")
async def detect_issues(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Run issue detection on a specific session."""
    from agentos.issues.detector import IssueDetector

    db = _get_db()

    # Load session
    session_row = db.conn.execute(
        "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
    ).fetchone()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")
    session_data = dict(session_row)

    # Load conversation scores if available
    scores = db.query_conversation_scores(session_id=session_id)

    detector = IssueDetector(db=db)
    issues = detector.detect_from_session(
        session_id=session_id,
        agent_name=session_data.get("agent_name", ""),
        org_id=user.org_id,
        session_data=session_data,
        scores=scores,
    )

    # Generate fix suggestions
    from agentos.issues.remediation import RemediationEngine
    engine = RemediationEngine()
    for issue in issues:
        fix = engine.suggest_fix(issue)
        if fix and db:
            db.update_issue(issue["issue_id"], suggested_fix=fix)
        issue["suggested_fix"] = fix

    return {"session_id": session_id, "issues_created": len(issues), "issues": issues}


# ── Dynamic /{issue_id} routes ────────────────────────────────────


@router.get("/{issue_id}")
async def get_issue(
    issue_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get a specific issue."""
    db = _get_db()
    issue = db.get_issue(issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    return issue


@router.put("/{issue_id}")
async def update_issue(
    issue_id: str,
    request: UpdateIssueRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Update an issue (status, severity, category, assignment, fix)."""
    db = _get_db()
    existing = db.get_issue(issue_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    updates: dict[str, Any] = {}
    if request.status is not None:
        updates["status"] = request.status
        if request.status == "resolved":
            updates["resolved_by"] = user.user_id
            updates["resolved_at"] = time.time()
    if request.severity is not None:
        updates["severity"] = request.severity
    if request.category is not None:
        updates["category"] = request.category
    if request.assigned_to is not None:
        updates["assigned_to"] = request.assigned_to
    if request.suggested_fix is not None:
        updates["suggested_fix"] = request.suggested_fix

    if updates:
        db.update_issue(issue_id, **updates)

    return db.get_issue(issue_id)


@router.post("/{issue_id}/resolve")
async def resolve_issue(
    issue_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Mark an issue as resolved."""
    db = _get_db()
    existing = db.get_issue(issue_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    db.update_issue(
        issue_id,
        status="resolved",
        resolved_by=user.user_id,
        resolved_at=time.time(),
    )
    return {"resolved": True, "issue_id": issue_id}


@router.post("/{issue_id}/triage")
async def triage_issue(
    issue_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Triage an issue — auto-classify and suggest fix."""
    from agentos.issues.classifier import IssueClassifier
    from agentos.issues.remediation import RemediationEngine

    db = _get_db()
    existing = db.get_issue(issue_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    classifier = IssueClassifier()
    classification = classifier.classify(
        title=existing.get("title", ""),
        description=existing.get("description", ""),
    )

    engine = RemediationEngine()
    fix = engine.suggest_fix({**existing, **classification})

    db.update_issue(
        issue_id,
        status="triaged",
        category=classification["category"],
        severity=classification["severity"],
        suggested_fix=fix,
    )

    return {
        "issue_id": issue_id,
        "status": "triaged",
        "category": classification["category"],
        "severity": classification["severity"],
        "suggested_fix": fix,
    }


@router.post("/{issue_id}/auto-fix")
async def auto_fix_issue(
    issue_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Auto-apply remediation config changes for an issue."""
    from agentos.issues.remediation import RemediationEngine
    import json as _json
    from pathlib import Path

    db = _get_db()
    existing = db.get_issue(issue_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    agent_name = existing.get("agent_name", "")
    if not agent_name:
        raise HTTPException(status_code=400, detail="Issue has no associated agent")

    agent_path = Path("agents") / f"{agent_name}.json"
    if not agent_path.exists():
        raise HTTPException(status_code=404, detail=f"Agent config not found: {agent_name}")

    agent_config = _json.loads(agent_path.read_text())
    engine = RemediationEngine()
    changes = engine.auto_remediate(existing, agent_config)

    if not changes:
        return {"applied": False, "message": "No auto-fix available for this issue type"}

    # Apply changes to agent config
    applied: list[str] = []
    for key, value in changes.items():
        if key == "system_prompt_append":
            agent_config["system_prompt"] = agent_config.get("system_prompt", "") + value
            applied.append("system_prompt (appended)")
        elif "." in key:
            parts = key.split(".", 1)
            sub = agent_config.setdefault(parts[0], {})
            if isinstance(sub, dict):
                sub[parts[1]] = value
                applied.append(key)
        else:
            agent_config[key] = value
            applied.append(key)

    # Write back
    agent_path.write_text(_json.dumps(agent_config, indent=2))

    # Mark issue as fixing
    db.update_issue(issue_id, status="fixing", fix_applied=1)

    # Audit the config change
    try:
        db.insert_config_audit(
            org_id=user.org_id,
            agent_name=agent_name,
            action="issue.auto_fix",
            field_changed=",".join(applied),
            change_reason=f"Auto-fix for issue {issue_id}: {existing.get('title', '')}",
            changed_by=user.user_id,
        )
    except Exception:
        pass

    return {
        "applied": True,
        "issue_id": issue_id,
        "agent_name": agent_name,
        "changes_applied": applied,
        "changes": changes,
    }
