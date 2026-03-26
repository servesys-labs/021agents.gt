"""Deterministic state patch application helpers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

_ALLOWED_REDUCERS = {"append", "last_write_wins", "set_union", "scored_merge"}


def _apply_reducer(existing: Any, value: Any, reducer: str, score: float | None = None) -> Any:
    if reducer == "last_write_wins":
        return value
    if reducer == "append":
        base = list(existing) if isinstance(existing, list) else ([] if existing is None else [existing])
        base.append(value)
        return base
    if reducer == "set_union":
        base = list(existing) if isinstance(existing, list) else ([] if existing is None else [existing])
        merged = list(dict.fromkeys([*base, value]))
        return merged
    if reducer == "scored_merge":
        current = existing if isinstance(existing, dict) else {"value": existing, "score": float("-inf")}
        cand_score = float(score if score is not None else 0.0)
        cur_score = float(current.get("score", float("-inf"))) if isinstance(current, dict) else float("-inf")
        if cand_score >= cur_score:
            return {"value": value, "score": cand_score}
        return current
    return value


def apply_state_patch(
    state: dict[str, Any],
    patch: dict[str, Any],
    *,
    reducers: dict[str, str] | None = None,
    default_reducer: str = "last_write_wins",
) -> dict[str, Any]:
    """Apply declarative state patch ops deterministically."""
    if default_reducer not in _ALLOWED_REDUCERS:
        raise ValueError(f"Invalid default reducer: {default_reducer}")
    reducers = reducers or {}
    for key, reducer in reducers.items():
        if reducer not in _ALLOWED_REDUCERS:
            raise ValueError(f"Invalid reducer for key '{key}': {reducer}")
    if not isinstance(state, dict):
        raise ValueError("state must be an object")
    if not isinstance(patch, dict):
        raise ValueError("patch must be an object")
    ops = patch.get("ops")
    if not isinstance(ops, list):
        raise ValueError("patch.ops must be a list")
    next_state = deepcopy(state)
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            raise ValueError(f"patch.ops[{i}] must be an object")
        key = op.get("key")
        if not isinstance(key, str) or not key.strip():
            raise ValueError(f"patch.ops[{i}].key must be a non-empty string")
        key = key.strip()
        op_type = str(op.get("op", "set")).strip()
        if op_type not in {"set", "merge"}:
            raise ValueError(f"patch.ops[{i}].op must be 'set' or 'merge'")
        value = op.get("value")
        reducer = str(op.get("reducer") or reducers.get(key) or default_reducer).strip()
        if reducer not in _ALLOWED_REDUCERS:
            raise ValueError(f"patch.ops[{i}] reducer '{reducer}' is invalid")
        if op_type == "merge":
            existing = next_state.get(key)
            next_state[key] = _apply_reducer(existing, value, reducer, score=op.get("score"))
        else:
            next_state[key] = value
    return next_state

