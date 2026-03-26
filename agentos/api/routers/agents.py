"""Agents router — CRUD, run, stream, versions."""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, get_optional_user, require_scope, _get_db
from agentos.api.schemas import (
    AgentCreateRequest, AgentResponse, AgentRunRequest, ChatRequest, RunResponse,
)
from agentos.graph.contracts import summarize_graph_contracts
from agentos.graph.design_lint import lint_graph_design
from agentos.graph.autofix import lint_and_autofix_graph

router = APIRouter(prefix="/agents", tags=["agents"])


def _runtime_moved_to_edge(detail_suffix: str = "") -> None:
    detail = (
        "Runtime execution is edge-only. Use worker runtime endpoints "
        "(`/api/v1/runtime-proxy/runnable/*` or `/api/v1/runtime-proxy/agent/run`)."
    )
    if detail_suffix:
        detail = f"{detail} {detail_suffix}"
    raise HTTPException(status_code=410, detail=detail)


def _default_no_code_graph() -> dict[str, Any]:
    """Safe starter graph for no-code agents: response path + async telemetry branch."""
    return {
        "id": "no-code-starter",
        "nodes": [
            {"id": "bootstrap", "kind": "bootstrap"},
            {"id": "route_llm", "kind": "route_llm"},
            {"id": "tools", "kind": "tools"},
            {"id": "after_tools", "kind": "after_tools"},
            {"id": "final", "kind": "final"},
            {
                "id": "telemetry_emit",
                "kind": "telemetry_emit",
                "async": True,
                "idempotency_key": "session:${session_id}:turn:${turn}:telemetry_emit",
            },
        ],
        "edges": [
            {"source": "bootstrap", "target": "route_llm"},
            {"source": "route_llm", "target": "tools"},
            {"source": "tools", "target": "after_tools"},
            {"source": "after_tools", "target": "final"},
            {"source": "bootstrap", "target": "telemetry_emit"},
        ],
    }


def _ensure_declarative_graph(config: Any, *, auto_graph: bool) -> dict[str, Any] | None:
    """Get or initialize declarative graph under harness config."""
    harness = getattr(config, "harness", None)
    if not isinstance(harness, dict):
        harness = {}
        setattr(config, "harness", harness)
    for key in ("declarative_graph", "graph"):
        graph = harness.get(key)
        if isinstance(graph, dict):
            if key != "declarative_graph":
                harness["declarative_graph"] = graph
            return graph
    if not auto_graph:
        return None
    graph = _default_no_code_graph()
    harness["declarative_graph"] = graph
    return graph


def _lint_suggestions_from_errors(errors: list[dict[str, Any]]) -> list[str]:
    code_to_hint = {
        "BACKGROUND_ON_CRITICAL_PATH": "Move telemetry/eval/index nodes off the path to final response.",
        "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY": "Add idempotency_key to async side-effect nodes (e.g. session+turn scoped key).",
        "FANIN_FROM_ASYNC_BRANCH": "Avoid joining async branches into blocking response joins; split or make join async-safe.",
        "CYCLE": "Remove cycles and keep graph as a DAG with deterministic flow.",
    }
    out: list[str] = []
    for item in errors:
        code = str(item.get("code", "")).strip()
        hint = code_to_hint.get(code)
        if hint and hint not in out:
            out.append(hint)
    return out


def _lint_graph_or_raise(
    graph: dict[str, Any] | None,
    *,
    strict: bool,
    source: str,
) -> dict[str, Any] | None:
    """Validate no-code graph semantics and raise 422 with fix suggestions when invalid."""
    if not isinstance(graph, dict):
        return None
    result = lint_graph_design(graph, strict=strict)
    if result.valid:
        return {
            "valid": True,
            "errors": [],
            "warnings": [w.to_dict() for w in result.warnings],
            "summary": result.summary,
        }
    errors = [e.to_dict() for e in result.errors]
    warnings = [w.to_dict() for w in result.warnings]
    raise HTTPException(
        status_code=422,
        detail={
            "message": "No-code graph lint failed. Fix graph design before publish.",
            "source": source,
            "strict": strict,
            "errors": errors,
            "warnings": warnings,
            "suggestions": _lint_suggestions_from_errors(errors),
        },
    )


def _latest_eval_gate(
    agent_name: str,
    *,
    min_eval_pass_rate: float,
    min_eval_trials: int,
) -> dict[str, Any]:
    """Compute eval gate status from latest eval run."""
    try:
        db = _get_db()
        row = db.conn.execute(
            "SELECT id, pass_rate, total_trials, total_tasks, created_at FROM eval_runs WHERE agent_name = ? ORDER BY created_at DESC LIMIT 1",
            (agent_name,),
        ).fetchone()
    except Exception:
        row = None
    latest_eval = dict(row) if row else None
    passed = False
    if latest_eval is not None:
        pass_rate = float(latest_eval.get("pass_rate") or 0.0)
        total_trials = int(latest_eval.get("total_trials") or 0)
        passed = pass_rate >= min_eval_pass_rate and total_trials >= min_eval_trials
    return {
        "latest_eval_run": latest_eval,
        "min_eval_pass_rate": min_eval_pass_rate,
        "min_eval_trials": min_eval_trials,
        "passed": passed,
    }


def _rollout_recommendation(
    *,
    agent_name: str,
    graph_lint: dict[str, Any] | None,
    eval_gate: dict[str, Any],
    target_channel: str,
) -> dict[str, Any]:
    """Build rollout recommendation payload for no-code wizard consumers."""
    rollout = {
        "decision": "hold",
        "target_channel": target_channel,
        "reason": "",
        "recommended_action": "",
        "release_endpoint": f"/api/v1/releases/{agent_name}/promote?from_channel=draft&to_channel={target_channel}",
    }
    lint_valid = bool((graph_lint or {}).get("valid"))
    latest_eval = eval_gate.get("latest_eval_run")
    if not lint_valid:
        rollout["reason"] = "Graph lint failed."
        rollout["recommended_action"] = "Apply graph_autofix result and re-check gate_pack."
    elif latest_eval is None:
        rollout["reason"] = "No eval run found for agent."
        rollout["recommended_action"] = "Run /api/v1/eval/run before promotion."
    elif not bool(eval_gate.get("passed")):
        rollout["reason"] = (
            f"Eval gate failed (pass_rate={float(latest_eval.get('pass_rate') or 0.0):.2f}, "
            f"trials={int(latest_eval.get('total_trials') or 0)})."
        )
        rollout["recommended_action"] = "Run targeted eval/experiments and iterate before promotion."
    else:
        rollout["decision"] = "promote_candidate"
        rollout["reason"] = "Lint and eval gates passed."
        rollout["recommended_action"] = "Promote to target channel and optionally start canary."
    return rollout


@router.get("", response_model=list[AgentResponse])
async def list_agents():
    """List all available agents."""
    from agentos.agent import list_agents as _list_agents
    agents = _list_agents()
    return [
        AgentResponse(
            name=a.name, description=a.description, model=a.model,
            tools=a.tools, tags=a.tags, version=a.version,
        )
        for a in agents
    ]


@router.get("/{name}", response_model=AgentResponse)
async def get_agent(name: str):
    """Get agent details."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        c = agent.config
        return AgentResponse(
            name=c.name, description=c.description, model=c.model,
            tools=c.tools, tags=c.tags, version=c.version,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("", response_model=AgentResponse)
async def create_agent(request: AgentCreateRequest, user: CurrentUser = Depends(require_scope("agents:write"))):
    """Create a new agent."""
    from agentos.agent import AgentConfig, save_agent_config

    config = AgentConfig(
        name=request.name,
        description=request.description,
        system_prompt=request.system_prompt,
        model=request.model or "anthropic/claude-sonnet-4.6",
        tools=request.tools,
        max_turns=request.max_turns,
        tags=request.tags,
    )
    config.governance["budget_limit_usd"] = request.budget_limit_usd
    if isinstance(request.graph, dict):
        if not isinstance(config.harness, dict):
            config.harness = {}
        config.harness["declarative_graph"] = request.graph
    graph = _ensure_declarative_graph(config, auto_graph=bool(request.auto_graph))
    _lint_graph_or_raise(graph, strict=bool(request.strict_graph_lint), source="agents.create")
    save_agent_config(config, org_id=user.org_id, created_by=user.user_id)

    # Snapshot version in agent_versions table
    _snapshot_version(config, user.user_id)

    # Auto-deploy customer worker to dispatch namespace
    from agentos.infra.dispatch import auto_deploy_agent
    await auto_deploy_agent(config.name, user.org_id, user.project_id)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


def _snapshot_version(config: Any, created_by: str = "") -> None:
    """Store a version snapshot in agent_versions table."""
    try:
        db = _get_db()
        db.conn.execute(
            """INSERT OR REPLACE INTO agent_versions (agent_name, version, config_json, created_by)
            VALUES (?, ?, ?, ?)""",
            (config.name, config.version, json.dumps(config.to_dict()), created_by),
        )
        db.conn.commit()
    except Exception:
        pass  # Non-critical


def _extract_project_scope(agent: Any) -> str:
    """Read project scope from agent tags: project:<project_id>."""
    tags = getattr(getattr(agent, "config", None), "tags", []) or []
    for tag in tags:
        if isinstance(tag, str) and tag.startswith("project:"):
            return tag.split("project:", 1)[1].strip()
    return ""


def _enforce_compliance(agent: Any, user: CurrentUser) -> None:
    """Block execution if agent has critical drift from its gold image."""
    try:
        db = _get_db()
        from agentos.config.compliance import ComplianceChecker
        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name=agent.config.name,
            agent_config=agent.config.to_dict(),
            org_id=user.org_id,
            checked_by=user.user_id,
        )
        if report.status == "critical":
            drift_fields = ", ".join(d.field for d in report.drifted_fields[:5])
            raise HTTPException(
                status_code=403,
                detail=f"Agent '{agent.config.name}' has critical config drift from gold image "
                       f"'{report.image_name}': {drift_fields}. "
                       f"Fix the drift or update the gold image before running.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # Compliance check is best-effort — don't block on infra errors


def _enforce_project_scope_access(scoped_project_id: str, user: CurrentUser) -> None:
    """Ensure caller can execute a project-scoped agent."""
    if not scoped_project_id:
        return

    # API keys can be pinned to one project. Enforce exact project match.
    if user.project_id and user.project_id != scoped_project_id:
        raise HTTPException(status_code=403, detail="API key is scoped to a different project")

    # Org must still own the scoped project.
    db = _get_db()
    row = db.conn.execute(
        "SELECT 1 FROM projects WHERE project_id = ? AND org_id = ?",
        (scoped_project_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="Agent is scoped to another project/org")


@router.put("/{name}", response_model=AgentResponse)
async def update_agent(name: str, request: AgentCreateRequest, user: CurrentUser = Depends(require_scope("agents:write"))):
    """Update an existing agent."""
    from agentos.agent import Agent, AgentConfig, save_agent_config

    try:
        existing = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    config = existing.config
    if request.description:
        config.description = request.description
    if request.system_prompt:
        config.system_prompt = request.system_prompt
    if request.model:
        config.model = request.model
    if request.tools:
        config.tools = request.tools
    if request.tags:
        config.tags = request.tags
    config.max_turns = request.max_turns
    config.governance["budget_limit_usd"] = request.budget_limit_usd
    if isinstance(request.graph, dict):
        if not isinstance(config.harness, dict):
            config.harness = {}
        config.harness["declarative_graph"] = request.graph
    graph = _ensure_declarative_graph(config, auto_graph=bool(request.auto_graph))
    _lint_graph_or_raise(graph, strict=bool(request.strict_graph_lint), source="agents.update")
    save_agent_config(config, org_id=user.org_id, created_by=user.user_id)

    # Snapshot updated version
    _snapshot_version(config, user.user_id)

    # Re-deploy customer worker with updated config
    from agentos.infra.dispatch import auto_deploy_agent
    await auto_deploy_agent(config.name, user.org_id, user.project_id)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


@router.delete("/{name}")
async def delete_agent(
    name: str,
    hard_delete: bool = False,
    user: CurrentUser = Depends(require_scope("agents:write")),
):
    """Delete an agent and cascade-clean all associated resources.

    Cleans up: DB records (sessions, turns, costs, evals, issues, compliance,
    schedules, webhooks, memory), Vectorize entries, R2 files, filesystem config.

    ?hard_delete=true  → permanently DELETE all rows (irreversible)
    ?hard_delete=false → soft-delete agent, count associated records (default)
    """
    from pathlib import Path
    from agentos.agent import _resolve_agents_dir

    # 1. Cascading DB cleanup
    db = _get_db()
    teardown_result = db.teardown_agent(name, org_id=user.org_id, hard_delete=hard_delete)

    if teardown_result.get("counts", {}).get("agent", 0) == 0:
        # Agent wasn't in DB — check filesystem
        agents_dir = _resolve_agents_dir()
        found_fs = any(
            (agents_dir / f"{name}{ext}").exists()
            for ext in (".json", ".yaml", ".yml")
        )
        if not found_fs:
            raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    # 2. Remove from filesystem
    agents_dir = _resolve_agents_dir()
    for ext in (".json", ".yaml", ".yml"):
        p = agents_dir / f"{name}{ext}"
        if p.exists():
            p.unlink()

    # 3. Clean up CF-side resources (Vectorize, R2) — best-effort
    cf_cleanup = {}
    try:
        from agentos.infra.cloudflare_client import get_cf_client
        cf = get_cf_client()
        if cf:
            cf_cleanup = await cf.teardown_agent(agent_name=name, org_id=user.org_id)
    except Exception as exc:
        cf_cleanup = {"error": str(exc)}

    # 4. Undeploy customer worker from dispatch namespace
    from agentos.infra.dispatch import auto_undeploy_agent
    undeploy_result = await auto_undeploy_agent(name, user.org_id)

    # 4. Audit log
    try:
        db.conn.execute(
            """INSERT INTO config_audit (agent_name, action, details_json, created_at)
            VALUES (?, ?, ?, ?)""",
            (name, "delete", json.dumps({
                "user": user.user_id, "org": user.org_id,
                "hard_delete": hard_delete, "cf_cleanup": cf_cleanup,
            }), time.time()),
        )
        db.conn.commit()
    except Exception:
        pass

    return {
        "deleted": name,
        "hard_delete": hard_delete,
        "db_cleanup": teardown_result.get("counts", {}),
        "cf_cleanup": cf_cleanup,
        "total_records_affected": teardown_result.get("total_records", 0),
    }


@router.post("/{name}/run", response_model=RunResponse)
async def run_agent(
    name: str,
    request: AgentRunRequest,
    user: CurrentUser = Depends(require_scope("agents:run")),
):
    """Runtime execution is edge-only; keep access checks for policy parity."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    scoped_project_id = _extract_project_scope(agent)
    _enforce_project_scope_access(scoped_project_id, user)
    _enforce_compliance(agent, user)
    if hasattr(agent, "set_runtime_context"):
        agent.set_runtime_context(
            org_id=user.org_id,
            project_id=scoped_project_id,
            user_id=user.user_id,
        )

    _runtime_moved_to_edge()


@router.post("/{name}/run/checkpoints/{checkpoint_id}/resume", response_model=RunResponse)
async def resume_agent_run_checkpoint(
    name: str,
    checkpoint_id: str,
    user: CurrentUser = Depends(require_scope("agents:run")),
):
    """Resume is handled by edge runtime endpoints."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    scoped_project_id = _extract_project_scope(agent)
    _enforce_project_scope_access(scoped_project_id, user)
    _enforce_compliance(agent, user)
    if hasattr(agent, "set_runtime_context"):
        agent.set_runtime_context(
            org_id=user.org_id,
            project_id=scoped_project_id,
            user_id=user.user_id,
        )

    _runtime_moved_to_edge("Resume via edge checkpoint endpoint.")


@router.post("/{name}/run/stream")
async def run_agent_stream(
    name: str,
    request: AgentRunRequest,
    user: CurrentUser = Depends(require_scope("agents:run")),
):
    """Streaming execution is edge-only."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    scoped_project_id = _extract_project_scope(agent)
    _enforce_project_scope_access(scoped_project_id, user)
    _enforce_compliance(agent, user)
    if hasattr(agent, "set_runtime_context"):
        agent.set_runtime_context(
            org_id=user.org_id,
            project_id=scoped_project_id,
            user_id=user.user_id,
        )

    _runtime_moved_to_edge("Use `/api/v1/runtime-proxy/runnable/stream-events` on worker.")


@router.get("/{name}/versions")
async def list_versions(name: str):
    """List all versions of an agent from DB + evolution ledger."""
    from pathlib import Path

    # Query agent_versions table
    db_versions: list[dict] = []
    try:
        db = _get_db()
        rows = db.conn.execute(
            "SELECT version, config_json, created_by, created_at FROM agent_versions WHERE agent_name = ? ORDER BY created_at DESC",
            (name,),
        ).fetchall()
        db_versions = [dict(r) for r in rows]
    except Exception:
        pass

    # Also check evolution ledger for backward compatibility
    ledger_path = Path.cwd() / "data" / "evolution" / name / "ledger.json"
    ledger_entries: list = []
    current = "0.1.0"
    if ledger_path.exists():
        try:
            ledger = json.loads(ledger_path.read_text())
            ledger_entries = ledger.get("entries", [])
            current = ledger.get("current_version", "0.1.0")
        except Exception:
            pass

    return {
        "versions": db_versions or ledger_entries,
        "current": current,
    }


@router.post("/create-from-description")
async def create_from_description(
    description: str,
    name: str = "",
    tools: str = "auto",
    draft_only: bool = False,
    strict_graph_lint: bool = True,
    auto_graph: bool = True,
    graph_json: str = "",
    include_autofix: bool = True,
    include_gate_pack: bool = True,
    include_contracts_validate: bool = True,
    min_eval_pass_rate: float = 0.85,
    min_eval_trials: int = 3,
    target_channel: str = "staging",
    override_hold: bool = False,
    override_reason: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Create an agent from a natural language description (LLM-powered).

    tools: 'auto' = auto-detect, 'none' = no tools, or comma-separated list
    """
    from agentos.builder import AgentBuilder, recommend_tools
    from agentos.agent import save_agent_config

    builder = AgentBuilder()
    config = await builder.build_from_description(description)

    if name:
        config.name = name

    if tools == "auto":
        recommended = set(recommend_tools(description))
        existing = {t for t in config.tools if isinstance(t, str)}
        config.tools = sorted(existing | recommended)
    elif tools == "none":
        config.tools = []
    elif tools:
        config.tools = [t.strip() for t in tools.split(",") if t.strip()]

    if graph_json.strip():
        try:
            parsed_graph = json.loads(graph_json)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid graph_json: {exc}") from exc
        if not isinstance(parsed_graph, dict):
            raise HTTPException(status_code=400, detail="graph_json must decode to a JSON object")
        if not isinstance(config.harness, dict):
            config.harness = {}
        config.harness["declarative_graph"] = parsed_graph

    graph = _ensure_declarative_graph(config, auto_graph=auto_graph)
    lint_report: dict[str, Any] | None = None
    graph_autofix: dict[str, Any] | None = None
    if isinstance(graph, dict):
        graph_autofix = lint_and_autofix_graph(graph, strict=strict_graph_lint, apply=include_autofix)
        if graph_autofix.get("autofix_applied") and isinstance(config.harness, dict):
            fixed_graph = graph_autofix.get("graph")
            if isinstance(fixed_graph, dict):
                config.harness["declarative_graph"] = fixed_graph
                graph = fixed_graph
        lint_report = graph_autofix.get("lint_after") if graph_autofix else None
        lint_valid = bool((lint_report or {}).get("valid"))
        if not lint_valid and not draft_only:
            errors = list((lint_report or {}).get("errors") or [])
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "No-code graph lint failed. Fix graph design before publish.",
                    "source": "agents.create-from-description",
                    "strict": strict_graph_lint,
                    "errors": errors,
                    "warnings": list((lint_report or {}).get("warnings") or []),
                    "suggestions": _lint_suggestions_from_errors(errors),
                    "graph_autofix": graph_autofix,
                },
            )
    elif not draft_only:
        lint_report = _lint_graph_or_raise(
            graph,
            strict=strict_graph_lint,
            source="agents.create-from-description",
        )

    eval_gate = _latest_eval_gate(
        config.name,
        min_eval_pass_rate=min_eval_pass_rate,
        min_eval_trials=min_eval_trials,
    )
    gate_pack = {
        "graph_lint": lint_report,
        "eval_gate": eval_gate,
        "rollout": _rollout_recommendation(
            agent_name=config.name,
            graph_lint=lint_report,
            eval_gate=eval_gate,
            target_channel=target_channel,
        ),
    }
    contracts_validate: dict[str, Any] | None = None
    if isinstance(graph, dict):
        contracts_result = lint_graph_design(graph, strict=strict_graph_lint)
        contracts_summary = dict(contracts_result.summary or {})
        contracts_summary["contracts"] = summarize_graph_contracts(graph)
        contracts_validate = {
            "valid": contracts_result.valid,
            "errors": [e.to_dict() for e in contracts_result.errors],
            "warnings": [w.to_dict() for w in contracts_result.warnings],
            "summary": contracts_summary,
        }
    rollout_decision = str(gate_pack.get("rollout", {}).get("decision", "")).strip().lower()
    hold_override_applied = False

    if draft_only:
        payload = {
            "created": False,
            "name": config.name,
            "description": config.description,
            "model": config.model,
            "tools": config.tools,
            "tags": config.tags,
            "version": config.version,
            "draft": config.to_dict(),
            "graph_lint": lint_report,
        }
        if include_autofix:
            payload["graph_autofix"] = graph_autofix
        if include_gate_pack:
            payload["gate_pack"] = gate_pack
        if include_contracts_validate:
            payload["contracts_validate"] = contracts_validate
        return payload

    if rollout_decision == "hold" and not override_hold:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Gate-pack rollout decision is HOLD. Explicit override required to create.",
                "override_required": True,
                "gate_pack": gate_pack,
            },
        )
    if rollout_decision == "hold" and override_hold and not (override_reason or "").strip():
        raise HTTPException(
            status_code=422,
            detail="override_reason is required when overriding a hold decision",
        )
    if rollout_decision == "hold" and override_hold:
        hold_override_applied = True
        try:
            db = _get_db()
            db.audit(
                action="agent.create.hold_override",
                user_id=user.user_id,
                org_id=user.org_id,
                project_id=user.project_id,
                resource_type="agent",
                resource_id=config.name,
                changes={
                    "reason": (override_reason or "").strip(),
                    "gate_pack": gate_pack,
                    "source": "agents.create-from-description",
                },
            )
        except Exception:
            pass
        try:
            db = _get_db()
            db.insert_config_audit(
                org_id=user.org_id,
                agent_name=config.name,
                action="hold_override",
                field_changed="gate_pack.rollout.decision",
                old_value="hold",
                new_value="override",
                change_reason=(override_reason or "").strip(),
                changed_by=user.user_id,
            )
        except Exception:
            pass

    save_agent_config(config, org_id=user.org_id, created_by=user.user_id)
    _snapshot_version(config, user.user_id)

    payload = {
        "created": True,
        "name": config.name,
        "description": config.description,
        "model": config.model,
        "tools": config.tools,
        "tags": config.tags,
        "version": config.version,
    }
    if include_autofix:
        payload["graph_autofix"] = graph_autofix
    if include_gate_pack:
        payload["gate_pack"] = gate_pack
    if include_contracts_validate:
        payload["contracts_validate"] = contracts_validate
    payload["hold_override_applied"] = hold_override_applied
    return payload


@router.post("/{name}/chat")
async def chat_turn(name: str, request: ChatRequest):
    """Chat runtime is edge-only."""
    _runtime_moved_to_edge("Use runnable invoke on worker for chat turns.")


@router.get("/{name}/tools")
async def get_agent_tools(name: str):
    """List tools available to a specific agent."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        return {"tools": agent._harness.tool_executor.available_tools()}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.get("/{name}/config")
async def get_agent_config(name: str):
    """Get raw agent configuration JSON."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        return agent.config.to_dict()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("/{name}/clone")
async def clone_agent(name: str, new_name: str, user: CurrentUser = Depends(get_current_user)):
    """Clone an agent with a new name."""
    from agentos.agent import Agent, save_agent_config
    try:
        agent = Agent.from_name(name)
        config = agent.config
        config.name = new_name
        config.agent_id = ""  # Will get new ID
        save_agent_config(config, org_id=user.org_id, created_by=user.user_id)
        return AgentResponse(
            name=config.name, description=config.description, model=config.model,
            tools=config.tools, tags=config.tags, version=config.version,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("/import")
async def import_agent(config: dict[str, Any], user: CurrentUser = Depends(get_current_user)):
    """Import an agent from a JSON config."""
    from agentos.agent import AgentConfig, save_agent_config
    harness = config.get("harness")
    graph = None
    if isinstance(harness, dict):
        g = harness.get("declarative_graph", harness.get("graph"))
        if isinstance(g, dict):
            graph = g
    if isinstance(config.get("graph"), dict) and graph is None:
        graph = config["graph"]
    _lint_graph_or_raise(graph, strict=True, source="agents.import")
    agent_config = AgentConfig.from_dict(config)
    save_agent_config(agent_config, org_id=user.org_id, created_by=user.user_id)
    return AgentResponse(
        name=agent_config.name, description=agent_config.description,
        model=agent_config.model, tools=agent_config.tools,
        tags=agent_config.tags, version=agent_config.version,
    )


@router.post("/{name}/run/{session_id}/cancel")
async def cancel_agent_run(
    name: str,
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Cancellation is handled by edge runtime/session coordination."""
    _runtime_moved_to_edge("Cancellation is managed in edge runtime/session layer.")


@router.get("/{name}/export")
async def export_agent(name: str):
    """Export agent config as JSON for backup or sharing."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        return {"agent": agent.config.to_dict()}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")
