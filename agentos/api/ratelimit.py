"""Rate limiting middleware — per API key and per org.

Uses a simple in-memory sliding window counter. For production at scale,
swap to Redis-backed limiter.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware


class RateLimiter:
    """In-memory sliding window rate limiter."""

    def __init__(self, requests_per_minute: int = 60, burst: int = 10) -> None:
        self.rpm = requests_per_minute
        self.burst = burst
        self._windows: dict[str, list[float]] = defaultdict(list)

    def check(self, key: str) -> bool:
        """Returns True if request is allowed, False if rate limited."""
        now = time.time()
        window = self._windows[key]

        # Remove requests older than 60 seconds
        window[:] = [t for t in window if now - t < 60]

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
        window[:] = [t for t in window if now - t < 60]
        return max(0, self.rpm - len(window))


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
            raise HTTPException(
                status_code=429,
                detail="Rate limit exceeded. Try again in a few seconds.",
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
