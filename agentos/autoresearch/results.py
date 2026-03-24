"""TSV experiment log — tracks every autoresearch run.

Format matches Karpathy's results.tsv:
    commit\tval_bpb\tmemory_gb\tstatus\tdescription

The file is NOT git-tracked — it accumulates all experiments across
the branch's lifetime.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Iterator


class ExperimentStatus(str, Enum):
    KEEP = "keep"
    DISCARD = "discard"
    CRASH = "crash"
    RUNNING = "running"


@dataclass
class ExperimentRecord:
    """One row in results.tsv."""

    commit: str  # 7-char git short hash
    val_bpb: float  # bits-per-byte (lower is better), 0.0 on crash
    memory_gb: float  # peak VRAM in GB
    status: ExperimentStatus
    description: str
    # Optional extra fields parsed from training output
    training_seconds: float = 0.0
    total_seconds: float = 0.0
    mfu_percent: float = 0.0
    total_tokens_m: float = 0.0
    num_steps: int = 0
    num_params_m: float = 0.0

    @property
    def improved(self) -> bool:
        return self.status == ExperimentStatus.KEEP

    def to_tsv_row(self) -> str:
        return (
            f"{self.commit}\t"
            f"{self.val_bpb:.6f}\t"
            f"{self.memory_gb:.1f}\t"
            f"{self.status.value}\t"
            f"{self.description}"
        )


HEADER = "commit\tval_bpb\tmemory_gb\tstatus\tdescription"


class ResultsLog:
    """Append-only TSV log of autoresearch experiments."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._ensure_header()

    def _ensure_header(self) -> None:
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(HEADER + "\n")

    def append(self, record: ExperimentRecord) -> None:
        with self.path.open("a") as f:
            f.write(record.to_tsv_row() + "\n")

    def records(self) -> list[ExperimentRecord]:
        """Read all experiment records."""
        if not self.path.exists():
            return []
        rows: list[ExperimentRecord] = []
        with self.path.open() as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row in reader:
                rows.append(
                    ExperimentRecord(
                        commit=row["commit"],
                        val_bpb=float(row["val_bpb"]),
                        memory_gb=float(row["memory_gb"]),
                        status=ExperimentStatus(row["status"]),
                        description=row["description"],
                    )
                )
        return rows

    @property
    def best_bpb(self) -> float | None:
        """Lowest val_bpb among kept experiments."""
        kept = [r for r in self.records() if r.status == ExperimentStatus.KEEP]
        if not kept:
            return None
        return min(r.val_bpb for r in kept)

    @property
    def total_experiments(self) -> int:
        return len(self.records())

    @property
    def kept_count(self) -> int:
        return sum(1 for r in self.records() if r.status == ExperimentStatus.KEEP)

    @property
    def discarded_count(self) -> int:
        return sum(1 for r in self.records() if r.status == ExperimentStatus.DISCARD)

    @property
    def crash_count(self) -> int:
        return sum(1 for r in self.records() if r.status == ExperimentStatus.CRASH)

    def summary(self) -> str:
        records = self.records()
        if not records:
            return "No experiments recorded yet."
        kept = [r for r in records if r.status == ExperimentStatus.KEEP]
        best = min(kept, key=lambda r: r.val_bpb) if kept else None
        lines = [
            f"Total experiments: {len(records)}",
            f"  Kept:      {len(kept)}",
            f"  Discarded: {sum(1 for r in records if r.status == ExperimentStatus.DISCARD)}",
            f"  Crashed:   {sum(1 for r in records if r.status == ExperimentStatus.CRASH)}",
        ]
        if best:
            lines.append(f"  Best bpb:  {best.val_bpb:.6f} (commit {best.commit})")
        return "\n".join(lines)
