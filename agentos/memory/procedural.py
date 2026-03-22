"""Procedural memory: learned workflows and tool sequences."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Procedure:
    name: str
    steps: list[dict[str, Any]]
    description: str = ""
    success_count: int = 0
    failure_count: int = 0
    last_used: float = field(default_factory=time.time)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total else 0.0


class ProceduralMemory:
    """Stores and retrieves learned workflows and tool sequences.

    When a database is provided, procedures are persisted to SQLite
    and survive across process restarts.
    """

    def __init__(self, max_procedures: int = 500, db: Any = None) -> None:
        self._procedures: dict[str, Procedure] = {}
        self.max_procedures = max_procedures
        self._db = db

        # Load existing procedures from DB on init
        if self._db is not None:
            self._load_from_db()

    def _load_from_db(self) -> None:
        """Load procedures from SQLite into memory."""
        try:
            rows = self._db.conn.execute(
                "SELECT * FROM procedures ORDER BY last_used DESC LIMIT ?",
                (self.max_procedures,),
            ).fetchall()
            import json
            for row in rows:
                r = dict(row)
                self._procedures[r["name"]] = Procedure(
                    name=r["name"],
                    steps=json.loads(r["steps_json"]),
                    description=r.get("description", ""),
                    success_count=r.get("success_count", 0),
                    failure_count=r.get("failure_count", 0),
                    last_used=r.get("last_used", 0),
                )
            if self._procedures:
                logger.info("Loaded %d procedures from database", len(self._procedures))
        except Exception as exc:
            logger.warning("Could not load procedures from DB: %s", exc)

    def store(self, procedure: Procedure) -> None:
        self._procedures[procedure.name] = procedure
        if len(self._procedures) > self.max_procedures:
            # Evict the least successful procedure
            worst = min(self._procedures.values(), key=lambda p: p.success_rate)
            del self._procedures[worst.name]

        # Persist to DB
        if self._db is not None:
            try:
                import json
                self._db.conn.execute(
                    """INSERT OR REPLACE INTO procedures
                    (name, description, steps_json, success_count, failure_count, last_used)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        procedure.name,
                        procedure.description,
                        json.dumps(procedure.steps),
                        procedure.success_count,
                        procedure.failure_count,
                        procedure.last_used,
                    ),
                )
                self._db.conn.commit()
            except Exception as exc:
                logger.warning("Could not persist procedure to DB: %s", exc)

    def get(self, name: str) -> Procedure | None:
        return self._procedures.get(name)

    def record_outcome(self, name: str, success: bool) -> None:
        proc = self._procedures.get(name)
        if proc:
            if success:
                proc.success_count += 1
            else:
                proc.failure_count += 1
            proc.last_used = time.time()

            # Persist outcome to DB
            if self._db is not None:
                try:
                    self._db.record_procedure_outcome(name, success)
                except Exception as exc:
                    logger.warning("Could not persist procedure outcome: %s", exc)

    def find_best(self, task_description: str, limit: int = 3) -> list[Procedure]:
        """Find procedures matching the task description by keyword overlap."""
        task_words = set(task_description.lower().split())
        scored: list[tuple[float, Procedure]] = []
        for proc in self._procedures.values():
            desc_words = set(f"{proc.name} {proc.description}".lower().split())
            overlap = len(task_words & desc_words)
            if overlap > 0:
                score = overlap * (0.5 + 0.5 * proc.success_rate)
                scored.append((score, proc))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [p for _, p in scored[:limit]]

    def list_all(self) -> list[Procedure]:
        return list(self._procedures.values())
