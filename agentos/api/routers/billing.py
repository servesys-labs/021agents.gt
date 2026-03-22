"""Billing router — usage, invoices, Stripe integration."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import UsageResponse

router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/usage", response_model=UsageResponse)
async def get_usage(
    since_days: int = 30,
    user: CurrentUser = Depends(get_current_user),
):
    """Get usage and cost data for the current billing period."""
    import time
    db = _get_db()
    since = time.time() - (since_days * 86400)
    summary = db.billing_summary(org_id=user.org_id, since=since)

    # Also get per-agent breakdown
    rows = db.conn.execute(
        """SELECT agent_name, SUM(total_cost_usd) as cost, COUNT(*) as sessions
        FROM billing_records WHERE created_at >= ? GROUP BY agent_name ORDER BY cost DESC""",
        (since,),
    ).fetchall()
    by_agent = {r["agent_name"]: r["cost"] for r in rows}

    return UsageResponse(
        total_cost_usd=summary.get("total_cost_usd", 0),
        inference_cost_usd=summary.get("inference_cost_usd", 0),
        gpu_compute_cost_usd=summary.get("gpu_compute_cost_usd", 0),
        total_input_tokens=summary.get("total_input_tokens", 0),
        total_output_tokens=summary.get("total_output_tokens", 0),
        total_sessions=summary.get("total_records", 0),
        by_model=summary.get("by_model", {}),
        by_agent=by_agent,
    )


@router.get("/usage/daily")
async def get_daily_usage(days: int = 30):
    """Get daily cost breakdown for charts."""
    import time
    db = _get_db()
    since = time.time() - (days * 86400)

    rows = db.conn.execute(
        """SELECT
            date(created_at, 'unixepoch') as day,
            SUM(total_cost_usd) as cost,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            COUNT(*) as sessions
        FROM billing_records
        WHERE created_at >= ?
        GROUP BY day ORDER BY day""",
        (since,),
    ).fetchall()

    return {"days": [dict(r) for r in rows]}


@router.get("/invoices")
async def list_invoices(user: CurrentUser = Depends(get_current_user)):
    """List billing invoices (placeholder for Stripe integration)."""
    # TODO: Wire Stripe API for real invoices
    return {"invoices": [], "note": "Stripe integration pending"}


@router.post("/checkout")
async def create_checkout(plan: str = "standard", user: CurrentUser = Depends(get_current_user)):
    """Create a Stripe checkout session for plan upgrade."""
    # TODO: Wire Stripe checkout
    return {
        "checkout_url": f"https://checkout.stripe.com/placeholder?plan={plan}",
        "note": "Stripe integration pending",
    }
