"""Composable middleware chain for the agent harness.

Inspired by DeerFlow's middleware architecture — order-sensitive, composable
before_model/after_model hooks that separate cross-cutting concerns from the
core agent loop.

Each middleware sees full state and can modify messages, tool calls, or
halt execution without polluting the harness code.
"""

from agentos.middleware.base import Middleware, MiddlewareChain, MiddlewareContext
from agentos.middleware.loop_detection import LoopDetectionMiddleware
from agentos.middleware.summarization import SummarizationMiddleware

__all__ = [
    "Middleware",
    "MiddlewareChain",
    "MiddlewareContext",
    "LoopDetectionMiddleware",
    "SummarizationMiddleware",
]
