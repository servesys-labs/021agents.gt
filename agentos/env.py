"""Lightweight .env loader used by CLI and API startup."""

from __future__ import annotations

import os
from pathlib import Path


def load_dotenv_if_present(path: str | Path | None = None, *, override: bool = False) -> bool:
    """Load KEY=VALUE pairs from .env into process environment.

    Returns True when a dotenv file was found and parsed.
    """
    env_path = Path(path) if path else (Path.cwd() / ".env")
    if not env_path.exists() or not env_path.is_file():
        return False

    for raw_line in env_path.read_text(errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue

        # Strip matching single/double quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        if override or key not in os.environ:
            os.environ[key] = value

    return True
