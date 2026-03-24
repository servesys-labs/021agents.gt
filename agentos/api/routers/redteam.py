"""Red-team security router — scans, findings, AIVSS risk profiles."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/security", tags=["security"])


# ── Static routes first ──────────────────────────────────────────


@router.get("/probes")
async def list_probes(user: CurrentUser = Depends(get_current_user)):
    """List all available OWASP LLM Top 10 probes."""
    from agentos.security.owasp_probes import OwaspProbeLibrary
    lib = OwaspProbeLibrary()
    return {"probes": [p.to_dict() for p in lib.get_all()]}


@router.get("/scans")
async def list_scans(
    agent_name: str = "",
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List security scans."""
    db = _get_db()
    scans = db.list_security_scans(org_id=user.org_id, agent_name=agent_name, limit=limit)
    return {"scans": scans}


@router.get("/findings")
async def list_findings(
    scan_id: str = "",
    agent_name: str = "",
    severity: str = "",
    limit: int = 100,
    user: CurrentUser = Depends(get_current_user),
):
    """List security findings with filters."""
    db = _get_db()
    findings = db.list_security_findings(
        scan_id=scan_id, agent_name=agent_name, severity=severity, limit=limit,
    )
    return {"findings": findings}


@router.get("/risk-profiles")
async def list_risk_profiles(user: CurrentUser = Depends(get_current_user)):
    """List all agent risk profiles."""
    db = _get_db()
    profiles = db.list_risk_profiles(org_id=user.org_id)
    return {"profiles": profiles}


@router.get("/risk-profiles/{agent_name}")
async def get_risk_profile(
    agent_name: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get risk profile for a specific agent."""
    db = _get_db()
    profile = db.get_risk_profile(agent_name)
    if not profile:
        return {"agent_name": agent_name, "risk_score": 0.0, "risk_level": "not_scanned"}
    return profile


@router.post("/scan/{agent_name}")
async def run_security_scan(
    agent_name: str,
    scan_type: str = "config",
    user: CurrentUser = Depends(get_current_user),
):
    """Run a security scan against an agent."""
    from agentos.security.redteam import RedTeamRunner

    db = _get_db()

    # Load agent config
    import json as _json
    from pathlib import Path
    agent_path = Path("agents") / f"{agent_name}.json"
    if not agent_path.exists():
        # Try loading via Agent class
        try:
            from agentos.agent import load_agent_config
            agent_config = load_agent_config(agent_name)
        except Exception:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
    else:
        agent_config = _json.loads(agent_path.read_text())

    runner = RedTeamRunner(db=db)
    result = runner.scan_config(
        agent_name=agent_name,
        agent_config=agent_config,
        org_id=user.org_id,
        scan_type=scan_type,
    )

    return {
        "scan_id": result["scan_id"],
        "agent_name": agent_name,
        "risk_score": result["risk_score"],
        "risk_level": result["risk_level"],
        "total_probes": result["total_probes"],
        "passed": result["passed"],
        "failed": result["failed"],
        "findings_count": len(result.get("findings", [])),
    }


@router.post("/scan/{agent_name}/runtime")
async def run_runtime_scan(
    agent_name: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Run output-level adversarial probes against a live agent."""
    from agentos.security.redteam import RedTeamRunner

    db = _get_db()

    # Load agent config
    import json as _json
    from pathlib import Path
    agent_path = Path("agents") / f"{agent_name}.json"
    if not agent_path.exists():
        try:
            from agentos.agent import load_agent_config
            agent_config = load_agent_config(agent_name).to_dict()
        except Exception:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
    else:
        agent_config = _json.loads(agent_path.read_text())

    # Build the agent and create a run function
    try:
        from agentos.agent import Agent
        agent = Agent.from_name(agent_name)

        async def run_fn(input_text: str) -> str:
            results = await agent.run(input_text)
            if results and isinstance(results, list):
                last = results[-1]
                return last.get("content", str(last)) if isinstance(last, dict) else str(last)
            return str(results)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not load agent: {exc}")

    runner = RedTeamRunner(db=db)
    result = await runner.scan_runtime(
        agent_name=agent_name,
        agent_config=agent_config,
        run_fn=run_fn,
        org_id=user.org_id,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return {
        "scan_id": result["scan_id"],
        "agent_name": agent_name,
        "scan_type": "runtime",
        "risk_score": result["risk_score"],
        "risk_level": result["risk_level"],
        "total_probes": result["total_probes"],
        "passed": result["passed"],
        "failed": result["failed"],
        "findings_count": len(result.get("findings", [])),
    }


@router.get("/scan/{scan_id}/report")
async def get_scan_report(
    scan_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get full security report for a scan."""
    db = _get_db()
    scan = db.get_security_scan(scan_id)
    if not scan:
        raise HTTPException(status_code=404, detail="Scan not found")

    findings = db.list_security_findings(scan_id=scan_id)

    from agentos.security.report import SecurityReportGenerator
    gen = SecurityReportGenerator()
    report = gen.generate({
        **scan,
        "findings": findings,
        "maestro_layers": [],
        "aivss_summary": {"overall_score": scan.get("risk_score", 0)},
    })
    return report


@router.post("/aivss/calculate")
async def calculate_aivss(
    body: dict[str, Any],
    user: CurrentUser = Depends(get_current_user),
):
    """Calculate AIVSS score from vector components."""
    from agentos.security.aivss import AIVSSCalculator, AIVSSVector

    calc = AIVSSCalculator()
    vector = AIVSSVector(
        attack_vector=body.get("attack_vector", "network"),
        attack_complexity=body.get("attack_complexity", "low"),
        privileges_required=body.get("privileges_required", "none"),
        scope=body.get("scope", "unchanged"),
        confidentiality_impact=body.get("confidentiality_impact", "none"),
        integrity_impact=body.get("integrity_impact", "none"),
        availability_impact=body.get("availability_impact", "none"),
    )
    score = calc.calculate(vector)
    return {
        "score": score,
        "risk_level": calc.classify_risk(score),
        "vector": vector.to_dict(),
    }


@router.get("/risk-trends/{agent_name}")
async def risk_trends(
    agent_name: str,
    limit: int = 20,
    user: CurrentUser = Depends(get_current_user),
):
    """Get historical risk score trends for an agent."""
    db = _get_db()
    scans = db.list_security_scans(org_id=user.org_id, agent_name=agent_name, limit=limit)
    # Reverse to chronological order (oldest first) for trend charts
    trends = [
        {
            "scan_id": s["scan_id"],
            "risk_score": s.get("risk_score", 0),
            "risk_level": s.get("risk_level", "unknown"),
            "passed": s.get("passed", 0),
            "failed": s.get("failed", 0),
            "created_at": s.get("created_at", 0),
        }
        for s in reversed(scans)
    ]
    return {
        "agent_name": agent_name,
        "trends": trends,
    }
