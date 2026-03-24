"""Billing router — usage, invoices, Stripe integration."""

from __future__ import annotations

from collections import defaultdict
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db, require_scope

router = APIRouter(prefix="/billing", tags=["billing"])


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


def _extract_gmi_token_prices(model_obj: dict[str, Any]) -> tuple[float | None, float | None]:
    """Extract input/output token prices from flexible model payloads."""
    pricing = model_obj.get("pricing", {}) if isinstance(model_obj.get("pricing"), dict) else {}

    input_candidates = [
        pricing.get("input_per_million"),
        pricing.get("input_cost_per_1m"),
        pricing.get("prompt_per_million"),
        pricing.get("prompt_cost_per_1m"),
        model_obj.get("input_per_million"),
        model_obj.get("prompt_per_million"),
    ]
    output_candidates = [
        pricing.get("output_per_million"),
        pricing.get("output_cost_per_1m"),
        pricing.get("completion_per_million"),
        pricing.get("completion_cost_per_1m"),
        model_obj.get("output_per_million"),
        model_obj.get("completion_per_million"),
    ]

    in_price = next((p for p in (_coerce_per_token_price(x) for x in input_candidates) if p is not None), None)
    out_price = next((p for p in (_coerce_per_token_price(x) for x in output_candidates) if p is not None), None)
    return in_price, out_price


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


@router.post("/pricing/sync-gmi")
async def sync_gmi_pricing_catalog(
    dry_run: bool = False,
    user: CurrentUser = Depends(require_scope("billing:write")),
):
    """Sync GMI model catalog/rates into pricing_catalog and mark missing models inactive.

    This endpoint is designed for periodic scheduling (e.g., hourly/daily cron).
    """
    if not user.has_role("admin"):
        raise HTTPException(status_code=403, detail="Admin role required for pricing sync")

    api_key = (os.environ.get("GMI_API_KEY", "") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="GMI_API_KEY not configured on backend")

    # Use config/default.json as source of truth for provider base URL.
    config_path = Path(__file__).resolve().parent.parent.parent.parent / "config" / "default.json"
    api_base = "https://api.gmi-serving.com/v1"
    try:
        raw = json.loads(config_path.read_text()) if config_path.exists() else {}
        api_base = (
            raw.get("llm", {})
            .get("providers", {})
            .get("gmi", {})
            .get("api_base", api_base)
        ) or api_base
    except Exception:
        pass

    models_url = f"{api_base.rstrip('/')}/models"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                models_url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
        if not resp.is_success:
            raise HTTPException(status_code=502, detail=f"GMI models endpoint error: {resp.status_code}")
        payload = resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GMI sync failed: {exc}") from exc

    db = _get_db()
    now = time.time()
    catalog = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(catalog, list):
        raise HTTPException(status_code=502, detail="Unexpected GMI models response format")

    active_models: set[str] = set()
    upserts = 0
    deprecated_count = 0
    pricing_rows_written = 0
    sync_version = time.strftime("gmi-%Y%m%d-%H%M%S", time.gmtime(now))

    for item in catalog:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or item.get("model") or "").strip()
        if not model_id:
            continue
        active_models.add(model_id)

        deprecated = bool(item.get("deprecated") or str(item.get("status", "")).lower() in {"deprecated", "sunset"})
        if deprecated:
            deprecated_count += 1

        in_price, out_price = _extract_gmi_token_prices(item)
        if dry_run:
            continue

        # Always upsert a model-availability marker row (unit=model, price=0).
        db.upsert_pricing_rate(
            provider="gmi",
            model=model_id,
            resource_type="model_catalog",
            operation="availability",
            unit="model",
            unit_price_usd=0.0,
            source="gmi_sync",
            pricing_version=sync_version,
            effective_from=now,
            is_active=not deprecated,
            metadata_json=json.dumps(
                {
                    "deprecated": deprecated,
                    "status": str(item.get("status", "")),
                    "raw": item,
                }
            ),
        )
        upserts += 1

        if in_price is not None:
            db.upsert_pricing_rate(
                provider="gmi",
                model=model_id,
                resource_type="llm",
                operation="infer",
                unit="input_token",
                unit_price_usd=float(in_price),
                source="gmi_sync",
                pricing_version=sync_version,
                effective_from=now,
                is_active=not deprecated,
                metadata_json=json.dumps({"deprecated": deprecated}),
            )
            pricing_rows_written += 1
        if out_price is not None:
            db.upsert_pricing_rate(
                provider="gmi",
                model=model_id,
                resource_type="llm",
                operation="infer",
                unit="output_token",
                unit_price_usd=float(out_price),
                source="gmi_sync",
                pricing_version=sync_version,
                effective_from=now,
                is_active=not deprecated,
                metadata_json=json.dumps({"deprecated": deprecated}),
            )
            pricing_rows_written += 1

    missing_models = 0
    if not dry_run:
        # Mark previously active GMI llm rates as inactive when model disappears from catalog.
        rows = db.conn.execute(
            """SELECT DISTINCT model FROM pricing_catalog
               WHERE provider = ? AND resource_type = ? AND operation = ? AND is_active = 1""",
            ("gmi", "llm", "infer"),
        ).fetchall()
        known = {str(r["model"]) for r in rows if r.get("model")}
        to_deactivate = sorted(m for m in known if m not in active_models)
        missing_models = len(to_deactivate)
        for model_id in to_deactivate:
            db.conn.execute(
                """UPDATE pricing_catalog
                   SET is_active = 0, effective_to = ?, updated_at = ?
                   WHERE provider = ? AND model = ? AND resource_type = ? AND operation = ? AND is_active = 1""",
                (now, now, "gmi", model_id, "llm", "infer"),
            )
        db.conn.commit()

    return {
        "ok": True,
        "dry_run": dry_run,
        "provider": "gmi",
        "models_seen": len(active_models),
        "deprecated_seen": deprecated_count,
        "catalog_rows_upserted": upserts,
        "pricing_rows_upserted": pricing_rows_written,
        "models_marked_inactive": missing_models,
        "pricing_version": sync_version,
        "source_url": models_url,
    }
