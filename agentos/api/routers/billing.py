"""Billing router — usage, invoices, Stripe integration."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/billing", tags=["billing"])


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

    rows = db.conn.execute(
        """SELECT
            date(created_at, 'unixepoch') as day,
            SUM(total_cost_usd) as cost,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            COUNT(*) as call_count
        FROM billing_records
        WHERE org_id = ? AND created_at >= ?
        GROUP BY day ORDER BY day""",
        (user.org_id, since),
    ).fetchall()

    return {"days": [dict(r) for r in rows]}


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
