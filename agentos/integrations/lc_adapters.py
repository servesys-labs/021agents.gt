"""Runnable-first helpers that mirror common LangChain object shapes.

No third-party imports. Docstrings note LangChain class equivalents for
migration and client-side mapping without pulling LangChain as a dependency.

LangChain mappings (conceptual):
- :class:`RunnablePromptFormat` ↔ ``langchain_core.prompts.PromptTemplate`` /
  ``ChatPromptTemplate`` (format / format_messages → string here).
- :class:`RunnableOutputParse` ↔ ``StrOutputParser``, ``JsonOutputParser``,
  simple ``BaseOutputParser`` (parse).
- :class:`RunnableToolSchema` ↔ ``StructuredTool`` / ``langchain_core.tools.tool``
  JSON-schema style ``args_schema``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping


class RunnablePromptFormat:
    """Format a template string with variables (LangChain: PromptTemplate)."""

    __slots__ = ("template",)

    def __init__(self, template: str) -> None:
        self.template = template

    def format(self, variables: Mapping[str, Any] | None = None) -> str:
        """Substitute ``{name}`` placeholders; supports ``{{`` / ``}}`` literals."""
        vars_dict: dict[str, Any] = dict(variables or {})
        return self.template.format(**vars_dict)

    @classmethod
    def from_spec(cls, spec: Mapping[str, Any]) -> RunnablePromptFormat:
        t = spec.get("template")
        if not isinstance(t, str) or not t.strip():
            raise ValueError("prompt template spec requires non-empty string 'template'")
        return cls(t)


def merge_prompt_variables(
    spec: Mapping[str, Any],
    runnable_input: Any,
) -> dict[str, Any]:
    """Merge ``spec['variables']`` with dict-shaped runnable ``input`` (input wins on conflict)."""
    base: dict[str, Any] = {}
    raw = spec.get("variables")
    if isinstance(raw, dict):
        base.update({str(k): v for k, v in raw.items()})
    if isinstance(runnable_input, dict):
        base.update({str(k): v for k, v in runnable_input.items()})
    return base


def format_runnable_prompt(spec: Mapping[str, Any], runnable_input: Any) -> str:
    """Build task text from a template spec plus runnable input."""
    fmt = RunnablePromptFormat.from_spec(spec)
    variables = merge_prompt_variables(spec, runnable_input)
    return fmt.format(variables)


_JSON_FENCE_RE = re.compile(
    r"^\s*```(?:json)?\s*\n?(.*?)\n?```\s*$",
    re.DOTALL | re.IGNORECASE,
)


class RunnableOutputParse:
    """Parse model text into structured values (LangChain: output parsers)."""

    __slots__ = ("kind", "strip_ws")

    def __init__(self, kind: str = "text", *, strip_ws: bool = True) -> None:
        self.kind = (kind or "text").strip().lower()
        self.strip_ws = strip_ws

    @classmethod
    def from_spec(cls, spec: Mapping[str, Any]) -> RunnableOutputParse:
        k = str(spec.get("kind", "text") or "text")
        strip_ws = bool(spec.get("strip_ws", True))
        return cls(k, strip_ws=strip_ws)

    def parse(self, text: str) -> Any:
        raw = text if not self.strip_ws else text.strip()
        if self.kind in ("text", "str", "string", "none"):
            return raw
        if self.kind in ("lines", "list_lines"):
            lines = [ln.strip() for ln in raw.splitlines()] if self.strip_ws else [ln for ln in raw.splitlines()]
            return [ln for ln in lines if ln]
        if self.kind == "json":
            candidate = raw
            m = _JSON_FENCE_RE.match(raw)
            if m:
                candidate = m.group(1).strip()
            return json.loads(candidate)
        raise ValueError(f"unsupported output_parse kind: {self.kind!r}")


class RunnableToolSchema:
    """Describe a callable tool for interchange (LangChain: StructuredTool schema)."""

    __slots__ = ("name", "description", "parameters")

    def __init__(
        self,
        name: str,
        description: str = "",
        parameters: dict[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.parameters = dict(parameters or {})

    def to_openai_style(self) -> dict[str, Any]:
        """Shape often used by tool-calling APIs (type/function/parameters)."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> RunnableToolSchema:
        name = raw.get("name") or raw.get("tool_name") or ""
        if not isinstance(name, str) or not name.strip():
            raise ValueError("tool schema requires non-empty 'name'")
        desc = raw.get("description") or raw.get("desc") or ""
        desc = str(desc) if desc is not None else ""
        params = raw.get("parameters")
        if params is None:
            params = raw.get("args_schema")
        if not isinstance(params, dict):
            params = {}
        return cls(str(name).strip(), desc, params)

    def normalized_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


def normalize_tool_schemas(raw_list: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Validate and normalize a list of tool schema dicts."""
    if not raw_list:
        return []
    out: list[dict[str, Any]] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        try:
            out.append(RunnableToolSchema.from_dict(item).normalized_dict())
        except ValueError:
            continue
    return out


def coerce_tool_call_request(payload: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """Map LangChain-style tool payloads to AgentOS ``tool`` + ``args``.

    Accepts ``tool`` / ``name``, ``args`` / ``tool_input`` / ``arguments``.
    """
    name = payload.get("tool") or payload.get("name") or ""
    name = str(name).strip()
    chosen: dict[str, Any] | None = None
    for key in ("args", "tool_input", "arguments"):
        raw = payload.get(key)
        if isinstance(raw, dict):
            chosen = dict(raw)
            if raw:
                break
    return name, chosen or {}
