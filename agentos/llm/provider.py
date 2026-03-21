"""LLM provider abstraction."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class LLMResponse:
    """Unified response from any LLM provider."""

    content: str
    model: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    cost_usd: float = 0.0
    latency_ms: float = 0.0


class LLMProvider(Protocol):
    """Protocol that any LLM backend must implement."""

    @property
    def model_id(self) -> str: ...

    async def complete(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 4096,
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse: ...


class StubProvider:
    """A stub provider for testing without real API calls."""

    def __init__(self, model_id: str = "stub-model") -> None:
        self._model_id = model_id

    @property
    def model_id(self) -> str:
        return self._model_id

    async def complete(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 4096,
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = m.get("content", "")
                break
        return LLMResponse(
            content=f"[stub] Processed: {last_user[:80]}",
            model=self._model_id,
            usage={"input_tokens": 10, "output_tokens": 20},
            cost_usd=0.001,
            latency_ms=50.0,
        )


class HttpProvider:
    """Generic HTTP-based LLM provider using httpx."""

    def __init__(
        self,
        model_id: str,
        api_base: str,
        api_key: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._model_id = model_id
        self._api_base = api_base.rstrip("/")
        self._api_key = api_key
        self._headers = headers or {}

    @property
    def model_id(self) -> str:
        return self._model_id

    async def complete(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 4096,
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        import httpx

        payload: dict[str, Any] = {
            "model": self._model_id,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools:
            payload["tools"] = tools

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            **self._headers,
        }

        start = time.monotonic()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._api_base}/v1/messages",
                json=payload,
                headers=headers,
                timeout=120.0,
            )
            resp.raise_for_status()
        elapsed_ms = (time.monotonic() - start) * 1000
        body = resp.json()

        content = ""
        tool_calls: list[dict[str, Any]] = []
        for block in body.get("content", []):
            if block.get("type") == "text":
                content += block.get("text", "")
            elif block.get("type") == "tool_use":
                tool_calls.append({
                    "name": block["name"],
                    "arguments": block.get("input", {}),
                })

        usage = body.get("usage", {})
        return LLMResponse(
            content=content,
            model=body.get("model", self._model_id),
            tool_calls=tool_calls,
            usage=usage,
            latency_ms=elapsed_ms,
        )
