"""LLM provider abstraction."""

from __future__ import annotations

import json
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


class WorkersAIProvider:
    """LLM provider that runs on Cloudflare Workers AI (edge, sub-second).

    Calls the worker's /cf/llm/infer endpoint which uses env.AI.run().
    No external API call — inference happens on CF's edge GPUs.
    """

    def __init__(self, model_id: str) -> None:
        self._model_id = model_id

    @property
    def model_id(self) -> str:
        return self._model_id

    async def complete(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 1024,
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        from agentos.infra.cloudflare_client import get_cf_client

        cf = get_cf_client()
        if cf is None:
            raise RuntimeError("WorkersAIProvider requires AGENTOS_WORKER_URL to be configured")

        # Convert tools to Workers AI format if present
        ai_tools = None
        if tools:
            ai_tools = [
                {
                    "type": "function",
                    "function": {
                        "name": t.get("name", ""),
                        "description": t.get("description", ""),
                        "parameters": t.get("input_schema", {}),
                    },
                }
                for t in tools
            ]

        start = time.monotonic()
        result = await cf.llm_infer(
            model=self._model_id,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            tools=ai_tools,
        )
        elapsed_ms = (time.monotonic() - start) * 1000

        content = result.get("content", "")
        tool_calls = result.get("tool_calls", [])
        input_tokens = result.get("input_tokens", 0)
        output_tokens = result.get("output_tokens", 0)

        # Estimate cost based on Workers AI Neuron pricing
        # ~$0.011 per 1K Neurons, varies by model
        cost_usd = (input_tokens + output_tokens) * 0.000001  # rough estimate

        return LLMResponse(
            content=content,
            model=self._model_id,
            tool_calls=tool_calls,
            usage={"input_tokens": input_tokens, "output_tokens": output_tokens},
            cost_usd=cost_usd,
            latency_ms=elapsed_ms,
        )


class HttpProvider:
    """Generic HTTP-based LLM provider using httpx.

    Supports both Anthropic (/v1/messages) and OpenAI (/v1/chat/completions)
    API formats, auto-detected from api_base.
    """

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
        self._is_anthropic = "anthropic" in self._api_base

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

        if self._is_anthropic:
            return await self._complete_anthropic(messages, max_tokens, temperature, tools)
        else:
            return await self._complete_openai(messages, max_tokens, temperature, tools)

    async def _complete_anthropic(
        self,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        tools: list[dict[str, Any]] | None,
    ) -> LLMResponse:
        import httpx

        # Separate system messages, and convert tool-related messages
        # to Anthropic's expected format (tool_use blocks on assistant,
        # tool_result blocks on user messages).
        system_text = ""
        chat_messages: list[dict[str, Any]] = []
        i = 0
        while i < len(messages):
            m = messages[i]
            if m.get("role") == "system":
                system_text += m.get("content", "") + "\n"
            elif m.get("role") == "assistant" and m.get("tool_calls"):
                # Convert to Anthropic content blocks
                content_blocks: list[dict[str, Any]] = []
                if m.get("content"):
                    content_blocks.append({"type": "text", "text": m["content"]})
                for tc in m["tool_calls"]:
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id", ""),
                        "name": tc.get("name", ""),
                        "input": tc.get("arguments", {}),
                    })
                chat_messages.append({"role": "assistant", "content": content_blocks})
            elif m.get("role") == "tool":
                # Collect consecutive tool results into a single user message
                tool_results: list[dict[str, Any]] = []
                while i < len(messages) and messages[i].get("role") == "tool":
                    tm = messages[i]
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tm.get("tool_call_id", ""),
                        "content": tm.get("content", ""),
                    })
                    i += 1
                chat_messages.append({"role": "user", "content": tool_results})
                continue  # skip i += 1 at end
            else:
                chat_messages.append({"role": m.get("role", "user"), "content": m.get("content", "")})
            i += 1

        payload: dict[str, Any] = {
            "model": self._model_id,
            "messages": chat_messages or [{"role": "user", "content": "Hello"}],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system_text.strip():
            payload["system"] = system_text.strip()
        if tools:
            payload["tools"] = tools

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self._api_key,
            "anthropic-version": "2023-06-01",
            **self._headers,
        }

        start = time.monotonic()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._api_base.rstrip('/')}/v1/messages" if not self._api_base.rstrip("/").endswith("/v1") else f"{self._api_base.rstrip('/')}/messages",
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
                    "id": block.get("id", ""),
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

    async def _complete_openai(
        self,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        tools: list[dict[str, Any]] | None,
    ) -> LLMResponse:
        import httpx

        # Convert harness messages to OpenAI format
        oai_messages: list[dict[str, Any]] = []
        for m in messages:
            if m.get("role") == "assistant" and m.get("tool_calls"):
                # Convert to OpenAI tool_calls format
                oai_tool_calls = []
                for tc in m["tool_calls"]:
                    oai_tool_calls.append({
                        "id": tc.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": tc.get("name", ""),
                            "arguments": json.dumps(tc.get("arguments", {})),
                        },
                    })
                msg: dict[str, Any] = {"role": "assistant", "content": m.get("content") or None, "tool_calls": oai_tool_calls}
                oai_messages.append(msg)
            elif m.get("role") == "tool":
                oai_messages.append({
                    "role": "tool",
                    "tool_call_id": m.get("tool_call_id", ""),
                    "content": m.get("content", ""),
                })
            else:
                role = m.get("role", "user")
                # GPT-5.x uses "developer" instead of "system"
                if role == "system" and "gpt-5" in self._model_id:
                    role = "developer"
                oai_messages.append({"role": role, "content": m.get("content", "")})

        payload: dict[str, Any] = {
            "model": self._model_id,
            "messages": oai_messages,
            "temperature": temperature,
        }
        # GPT-5.x rejects max_tokens — use max_completion_tokens instead.
        # Other providers (DeepSeek, Qwen, etc.) still use max_tokens.
        if "gpt-5" in self._model_id:
            payload["max_completion_tokens"] = max_tokens
        else:
            payload["max_tokens"] = max_tokens
        if tools:
            # Convert MCP-style tools to OpenAI function-calling format.
            # GPT-5.x strictly validates schemas — ensure all array types have "items".
            def _fix_schema(schema: dict) -> dict:
                """Ensure array types have items defined (GPT-5.x requirement)."""
                if not isinstance(schema, dict):
                    return schema
                fixed = dict(schema)
                for key, val in fixed.items():
                    if isinstance(val, dict):
                        if val.get("type") == "array" and "items" not in val:
                            val = {**val, "items": {"type": "string"}}
                        fixed[key] = _fix_schema(val)
                return fixed

            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.get("name", ""),
                        "description": t.get("description", ""),
                        "parameters": _fix_schema(t.get("input_schema", {})),
                    },
                }
                for t in tools
            ]

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            **self._headers,
        }

        start = time.monotonic()
        async with httpx.AsyncClient() as client:
            base = self._api_base.rstrip("/")
            url = f"{base}/chat/completions" if base.endswith("/v1") else f"{base}/v1/chat/completions"

            # Retry on 429 (rate limit) with exponential backoff
            resp = None
            for attempt in range(3):
                resp = await client.post(url, json=payload, headers=headers, timeout=120.0)
                if resp.status_code != 429:
                    break
                wait = (attempt + 1) * 2  # 2s, 4s, 6s
                import asyncio
                await asyncio.sleep(wait)
            resp.raise_for_status()
        elapsed_ms = (time.monotonic() - start) * 1000
        body = resp.json()

        choice = body.get("choices", [{}])[0]
        message = choice.get("message", {})
        content = message.get("content", "") or ""

        tool_calls: list[dict[str, Any]] = []
        for tc in message.get("tool_calls", []):
            fn = tc.get("function", {})
            import json as _json
            try:
                args = _json.loads(fn.get("arguments", "{}"))
            except _json.JSONDecodeError:
                args = {}
            tool_calls.append({"id": tc.get("id", ""), "name": fn.get("name", ""), "arguments": args})

        usage = body.get("usage", {})
        return LLMResponse(
            content=content,
            model=body.get("model", self._model_id),
            tool_calls=tool_calls,
            usage={
                "input_tokens": usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("completion_tokens", 0),
            },
            latency_ms=elapsed_ms,
        )
