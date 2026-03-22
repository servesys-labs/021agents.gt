"""Middleware router — status, stats, and event history."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from agentos.api.deps import _get_db
from agentos.api.schemas import MiddlewareStatusResponse

router = APIRouter(prefix="/middleware", tags=["middleware"])


@router.get("/status", response_model=list[MiddlewareStatusResponse])
async def middleware_status():
    """Get status of all active middlewares in the harness.

    Returns each middleware's name, order, type, and live statistics
    (e.g., loop detection warning counts, summarization token savings).
    """
    from agentos.middleware.loop_detection import LoopDetectionMiddleware
    from agentos.middleware.summarization import SummarizationMiddleware

    # Build a representative middleware chain for status reporting
    middlewares = [
        LoopDetectionMiddleware(),
        SummarizationMiddleware(),
    ]
    return [
        MiddlewareStatusResponse(
            name=mw.name,
            order=mw.order,
            type=type(mw).__name__,
            stats=mw.stats() if hasattr(mw, "stats") else {},
        )
        for mw in middlewares
    ]


@router.get("/events")
async def middleware_events(
    session_id: str = "",
    middleware_name: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Query middleware event history (loop detections, summarizations, etc.)."""
    db = _get_db()
    if not db:
        return []
    return db.query_middleware_events(
        session_id=session_id,
        middleware_name=middleware_name,
        limit=limit,
    )
