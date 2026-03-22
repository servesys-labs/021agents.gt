"""GPU router — manage dedicated GPU endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/gpu", tags=["gpu"])


@router.get("/endpoints")
async def list_gpu_endpoints(status: str = "", user: CurrentUser = Depends(get_current_user)):
    """List dedicated GPU endpoints."""
    db = _get_db()
    return {"endpoints": db.list_gpu_endpoints(status=status or None, org_id=user.org_id)}


@router.post("/endpoints")
async def provision_gpu(
    model_id: str,
    gpu_type: str = "h200",
    gpu_count: int = 1,
    user: CurrentUser = Depends(get_current_user),
):
    """Provision a dedicated GPU endpoint via GMI Cloud."""
    import os
    infra_key = os.environ.get("GMI_INFRA_API_KEY", "")
    if not infra_key:
        raise HTTPException(status_code=503, detail="GMI_INFRA_API_KEY not configured")

    # TODO: Call GMI infrastructure API to provision
    # For now, register the intent
    import uuid
    db = _get_db()
    endpoint_id = uuid.uuid4().hex[:16]
    hourly_rates = {"h100": 2.98, "h200": 3.98}

    db.register_gpu_endpoint(
        endpoint_id=endpoint_id,
        model_id=model_id,
        api_base=f"https://dedicated-{endpoint_id}.gmi-serving.com/v1",
        gpu_type=gpu_type,
        gpu_count=gpu_count,
        hourly_rate_usd=hourly_rates.get(gpu_type, 3.98),
        org_id=user.org_id,
    )

    return {
        "endpoint_id": endpoint_id,
        "status": "provisioning",
        "gpu_type": gpu_type,
        "gpu_count": gpu_count,
        "model_id": model_id,
        "hourly_rate_usd": hourly_rates.get(gpu_type, 3.98),
    }


@router.delete("/endpoints/{endpoint_id}")
async def terminate_gpu(endpoint_id: str, user: CurrentUser = Depends(get_current_user)):
    """Stop and terminate a dedicated GPU endpoint."""
    db = _get_db()
    result = db.stop_gpu_endpoint(endpoint_id)
    if not result:
        raise HTTPException(status_code=404, detail="GPU endpoint not found")

    # Record billing for GPU compute
    db.record_billing(
        cost_type="gpu_compute",
        total_cost_usd=result["cost_usd"],
        org_id=user.org_id,
        gpu_type="h200",
        gpu_hours=result["hours"],
        gpu_cost_usd=result["cost_usd"],
        description=f"Dedicated GPU endpoint {endpoint_id}",
    )

    return result
