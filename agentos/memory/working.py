"""Working memory: short-term, volatile context for the current session."""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any


@dataclass
class MemoryEntry:
    key: str
    value: Any
    created_at: float
    ttl: float | None = None


class WorkingMemory:
    """Fast, volatile key-value store for current session state."""

    def __init__(self, max_items: int = 100) -> None:
        self._store: OrderedDict[str, MemoryEntry] = OrderedDict()
        self.max_items = max_items

    def set(self, key: str, value: Any, ttl: float | None = None) -> None:
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = MemoryEntry(key=key, value=value, created_at=time.time(), ttl=ttl)
        while len(self._store) > self.max_items:
            self._store.popitem(last=False)

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if entry.ttl and (time.time() - entry.created_at) > entry.ttl:
            del self._store[key]
            return None
        return entry.value

    def delete(self, key: str) -> bool:
        if key in self._store:
            del self._store[key]
            return True
        return False

    def keys(self) -> list[str]:
        return list(self._store.keys())

    def clear(self) -> None:
        self._store.clear()

    def snapshot(self) -> dict[str, Any]:
        return {k: e.value for k, e in self._store.items()}
