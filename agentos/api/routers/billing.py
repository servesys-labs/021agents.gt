"""Billing router — usage, invoices, Stripe integration."""

from __future__ import annotations

import asyncio
from collections import defaultdict
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db, require_scope

router = APIRouter(prefix="/billing", tags=["billing"])
logger = logging.getLogger(__name__)


def _coerce_per_token_price(raw: Any) -> float | None:
    """Best-effort normalize provider pricing into USD/token."""
    try:
        v = float(raw)
    except Exception:
        return None
    if v <= 0:
        return None
    # Heuristic: provider catalogs often publish per-1M token prices.
    return (v / 1_000_000.0) if v > 0.05 else v




@router.get("/usage")
async def get_usage(
    since_days: int = 30,
    user: CurrentUser = Depends(get_current_user),
):
    """Get usage and cost data for the current billing period.

    All queries are org-scoped to prevent cross-tenant data leakage.
    """
    since_days = max(1, min(365, int(since_days)))
    import time
    db = _get_db()
    since = time.time() - (since_days * 86400)
    summary = db.billing_summary(org_id=user.org_id, since=since)

    # Per-agent breakdown — MUST filter by org_id
    rows = db.conn.execute(
        """SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as call_count
        FROM billing_records
        WHERE org_id = ? AND created_at >= ?
        GROUP BY agent_name ORDER BY cost DESC""",
        (user.org_id, since),
    ).fetchall()
    by_agent = {r["agent_name"]: r["cost"] for r in rows if r["agent_name"]}

    return {
        "total_cost_usd": summary.get("total_cost_usd", 0),
        "inference_cost_usd": summary.get("inference_cost_usd", 0),
        "gpu_compute_cost_usd": summary.get("gpu_compute_cost_usd", 0),
        "connector_cost_usd": summary.get("by_cost_type", {}).get("connector", 0),
        "total_input_tokens": summary.get("total_input_tokens", 0),
        "total_output_tokens": summary.get("total_output_tokens", 0),
        "total_billing_records": summary.get("total_records", 0),
        "total_gpu_hours": summary.get("total_gpu_hours", 0),
        "by_cost_type": summary.get("by_cost_type", {}),
        "by_model": summary.get("by_model", {}),
        "by_agent": by_agent,
    }


@router.get("/usage/daily")
async def get_daily_usage(days: int = 30, user: CurrentUser = Depends(get_current_user)):
    """Get daily cost breakdown for charts. Org-scoped."""
    days = max(1, min(365, int(days)))
    import time
    db = _get_db()
    since = time.time() - (days * 86400)

    # Use DB-agnostic grouping in Python to avoid SQLite/Postgres date SQL drift.
    rows = db.conn.execute(
        """SELECT created_at, total_cost_usd, input_tokens, output_tokens
        FROM billing_records
        WHERE org_id = ? AND created_at >= ?
        ORDER BY created_at""",
        (user.org_id, since),
    ).fetchall()

    daily: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"cost": 0.0, "input_tokens": 0, "output_tokens": 0, "call_count": 0}
    )
    for row in rows:
        entry = dict(row)
        created_at = float(entry.get("created_at", 0) or 0)
        day = time.strftime("%Y-%m-%d", time.gmtime(created_at))
        bucket = daily[day]
        bucket["cost"] += float(entry.get("total_cost_usd", 0) or 0)
        bucket["input_tokens"] += int(entry.get("input_tokens", 0) or 0)
        bucket["output_tokens"] += int(entry.get("output_tokens", 0) or 0)
        bucket["call_count"] += 1

    out = [{"day": day, **daily[day]} for day in sorted(daily.keys())]
    return {"days": out}


@router.get("/trace/{trace_id}")
async def billing_by_trace(trace_id: str, user: CurrentUser = Depends(get_current_user)):
    """Get billing breakdown for a specific trace. Org-scoped."""
    db = _get_db()
    records = db.conn.execute(
        "SELECT * FROM billing_records WHERE trace_id = ? AND org_id = ? ORDER BY created_at",
        (trace_id, user.org_id),
    ).fetchall()
    records_list = [dict(r) for r in records]
    if not records_list:
        raise HTTPException(status_code=404, detail="Trace not found")
    rollup = {
        "total_sessions": len({r.get("session_id", "") for r in records_list if r.get("session_id")}),
        "total_cost_usd": float(sum(float(r.get("total_cost_usd", 0) or 0) for r in records_list)),
        "total_tokens": int(
            sum(int(r.get("input_tokens", 0) or 0) + int(r.get("output_tokens", 0) or 0) for r in records_list)
        ),
    }
    return {
        "trace_id": trace_id,
        "rollup": rollup,
        "records": records_list,
    }


@router.get("/invoices")
async def list_invoices(user: CurrentUser = Depends(get_current_user)):
    """List billing invoices (placeholder for Stripe integration)."""
    return {"invoices": [], "note": "Stripe integration pending"}


@router.post("/checkout")
async def create_checkout(plan: str = "standard", user: CurrentUser = Depends(get_current_user)):
    """Create a Stripe checkout session for plan upgrade."""
    allowed = {"starter", "standard", "pro", "enterprise"}
    if plan not in allowed:
        raise HTTPException(status_code=400, detail="Invalid plan")
    return {
        "checkout_url": f"https://checkout.stripe.com/placeholder?plan={plan}",
        "note": "Stripe integration pending",
    }


@router.get("/pricing")
async def list_pricing_catalog(
    resource_type: str = "",
    provider: str = "",
    model: str = "",
    operation: str = "",
    user: CurrentUser = Depends(require_scope("billing:read")),
):
    """List active pricing catalog entries (org-wide control plane view)."""
    db = _get_db()
    sql = "SELECT * FROM pricing_catalog WHERE is_active = 1"
    params: list[Any] = []
    if resource_type:
        sql += " AND resource_type = ?"
        params.append(resource_type)
    if provider:
        sql += " AND provider = ?"
        params.append(provider)
    if model:
        sql += " AND model = ?"
        params.append(model)
    if operation:
        sql += " AND operation = ?"
        params.append(operation)
    sql += " ORDER BY resource_type, provider, model, operation, unit, effective_from DESC"
    rows = db.conn.execute(sql, params).fetchall()
    return {"pricing": [dict(r) for r in rows], "count": len(rows)}


@router.post("/pricing")
async def upsert_pricing_catalog(
    payload: dict[str, Any],
    user: CurrentUser = Depends(require_scope("billing:write")),
):
    """Upsert one pricing rule (deactivates previous active row for same key)."""
    if not user.has_role("admin"):
        raise HTTPException(status_code=403, detail="Admin role required for pricing updates")

    db = _get_db()
    provider = str(payload.get("provider", "") or "")
    model = str(payload.get("model", "") or "")
    resource_type = str(payload.get("resource_type", "") or "")
    operation = str(payload.get("operation", "") or "")
    unit = str(payload.get("unit", "") or "")
    if not resource_type or not operation or not unit:
        raise HTTPException(status_code=400, detail="resource_type, operation, and unit are required")

    row_id = db.upsert_pricing_rate(
        provider=provider,
        model=model,
        resource_type=resource_type,
        operation=operation,
        unit=unit,
        unit_price_usd=float(payload.get("unit_price_usd", 0.0) or 0.0),
        currency=str(payload.get("currency", "USD") or "USD"),
        source=str(payload.get("source", "manual") or "manual"),
        pricing_version=str(payload.get("pricing_version", "") or ""),
        effective_from=payload.get("effective_from"),
        effective_to=payload.get("effective_to"),
        is_active=bool(payload.get("is_active", True)),
        metadata_json=str(payload.get("metadata_json", "{}") or "{}"),
    )
    return {"ok": True, "id": row_id}


