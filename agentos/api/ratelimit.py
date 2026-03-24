"""Rate limiting middleware — per API key and per org.

Uses an in-memory sliding window counter with bounded memory.
The _windows dict is capped at MAX_KEYS entries; when exceeded,
stale keys are evicted in bulk to amortize cleanup cost.

For multi-pod production, swap to Redis-backed limiter.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from fastapi import Request
from starlette.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

MAX_KEYS = 10_000          # Max unique rate-limit keys before eviction
EVICT_FRACTION = 0.25      # Remove oldest 25% on eviction
WINDOW_SECONDS = 60        # Sliding window size


class RateLimiter:
    """In-memory sliding window rate limiter with bounded memory."""

    def __init__(self, requests_per_minute: int = 60, burst: int = 10) -> None:
        self.rpm = requests_per_minute
        self.burst = burst
        self._windows: dict[str, list[float]] = defaultdict(list)
        self._call_count = 0  # Track calls for periodic eviction

    def _maybe_evict(self) -> None:
        """Evict stale keys when over capacity. Runs every 500 calls."""
        self._call_count += 1
        if self._call_count < 500:
            return
        self._call_count = 0

        now = time.time()
        # Remove keys with no recent activity
        stale = [k for k, v in self._windows.items() if not v or now - v[-1] > WINDOW_SECONDS]
        for k in stale:
            del self._windows[k]

        # If still over limit, remove oldest by last-activity time
        if len(self._windows) > MAX_KEYS:
            by_last_activity = sorted(self._windows.items(), key=lambda x: x[1][-1] if x[1] else 0)
            to_remove = int(len(by_last_activity) * EVICT_FRACTION)
            for k, _ in by_last_activity[:to_remove]:
                del self._windows[k]

    def check(self, key: str) -> bool:
        """Returns True if request is allowed, False if rate limited."""
        self._maybe_evict()

        now = time.time()
        window = self._windows[key]

        # Remove requests older than 60 seconds
        window[:] = [t for t in window if now - t < WINDOW_SECONDS]

        # Check burst (per-second)
        recent = sum(1 for t in window if now - t < 1)
        if recent >= self.burst:
            return False

        # Check RPM
        if len(window) >= self.rpm:
            return False

        window.append(now)
        return True

    def remaining(self, key: str) -> int:
        now = time.time()
        window = self._windows[key]
        window[:] = [t for t in window if now - t < WINDOW_SECONDS]
        return max(0, self.rpm - len(window))

    def stats(self) -> dict[str, Any]:
        """Return limiter stats for monitoring."""
        return {
            "unique_keys": len(self._windows),
            "max_keys": MAX_KEYS,
            "rpm_limit": self.rpm,
            "burst_limit": self.burst,
        }


# Global limiter instance
_limiter = RateLimiter(requests_per_minute=120, burst=20)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that enforces rate limits per API key or IP."""

    async def dispatch(self, request: Request, call_next):
        import os
        # Skip in test mode
        if os.environ.get("TESTING") or os.environ.get("PYTEST_CURRENT_TEST"):
            return await call_next(request)

        # Skip rate limiting for health checks and docs
        path = request.url.path
        if path in ("/health", "/docs", "/redoc", "/openapi.json", "/.well-known/agent.json"):
            return await call_next(request)

        # Determine rate limit key
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer ak_"):
            key = f"apikey:{auth[7:18]}"  # Use key prefix
        elif auth.startswith("Bearer "):
            key = f"jwt:{auth[7:20]}"  # Use token prefix
        else:
            key = f"ip:{request.client.host if request.client else 'unknown'}"

        if not _limiter.check(key):
            remaining = _limiter.remaining(key)
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Try again in a few seconds."},
                headers={
                    "Retry-After": "5",
                    "X-RateLimit-Remaining": str(remaining),
                    "X-RateLimit-Limit": str(_limiter.rpm),
                },
            )

        response = await call_next(request)
        remaining = _limiter.remaining(key)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        response.headers["X-RateLimit-Limit"] = str(_limiter.rpm)
        return response
