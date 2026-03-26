"""Static contract checks for edge runnable composition helpers."""

from __future__ import annotations

from pathlib import Path


def test_runnable_helpers_exported_from_runtime_index() -> None:
    text = Path("deploy/src/runtime/index.ts").read_text()
    assert 'from "./runnable"' in text
    assert "pipe" in text
    assert "mapInputs" in text
    assert "branch" in text
    assert "parseOutput" in text


def test_runnable_helpers_file_contains_core_primitives() -> None:
    text = Path("deploy/src/runtime/runnable.ts").read_text()
    assert "export function pipe" in text
    assert "export async function mapInputs" in text
    assert "export function branch" in text
    assert "export function parseOutput" in text
