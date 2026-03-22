"""Virtual path translation for sandboxes.

Agents see clean virtual paths like /mnt/user-data/workspace/...,
while the actual physical paths are session-specific directories.

This decouples agent code from the underlying filesystem layout, making
the same agent work in local dev, Docker, E2B, and Kubernetes.

Virtual path scheme:
    /mnt/user-data/workspace/  → per-session workspace
    /mnt/user-data/uploads/    → uploaded files
    /mnt/user-data/outputs/    → generated artifacts
    /mnt/skills/               → skill definitions
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# Virtual path prefix the agent sees
VIRTUAL_PREFIX = "/mnt/user-data"
VIRTUAL_WORKSPACE = f"{VIRTUAL_PREFIX}/workspace"
VIRTUAL_UPLOADS = f"{VIRTUAL_PREFIX}/uploads"
VIRTUAL_OUTPUTS = f"{VIRTUAL_PREFIX}/outputs"
VIRTUAL_SKILLS = "/mnt/skills"

# Pattern to match virtual paths in commands
_VIRTUAL_PATH_RE = re.compile(r"/mnt/(user-data|skills)(/[^\s\"']*)?")


@dataclass
class PathMapping:
    """Maps virtual paths to physical paths for a session."""

    session_id: str
    workspace: Path = Path("")
    uploads: Path = Path("")
    outputs: Path = Path("")
    skills: Path = Path("")

    @classmethod
    def for_session(
        cls,
        session_id: str,
        base_dir: Path | None = None,
        skills_dir: Path | None = None,
    ) -> PathMapping:
        """Create a path mapping for a session under a base directory."""
        base = base_dir or Path(".agentos_sandbox")
        session_dir = base / session_id / "user-data"
        return cls(
            session_id=session_id,
            workspace=session_dir / "workspace",
            uploads=session_dir / "uploads",
            outputs=session_dir / "outputs",
            skills=skills_dir or Path("skills"),
        )

    def ensure_dirs(self) -> None:
        """Create all physical directories."""
        for d in [self.workspace, self.uploads, self.outputs]:
            d.mkdir(parents=True, exist_ok=True)

    def virtual_to_physical(self, virtual_path: str) -> str:
        """Translate a single virtual path to its physical counterpart."""
        if virtual_path.startswith(VIRTUAL_WORKSPACE):
            suffix = virtual_path[len(VIRTUAL_WORKSPACE):]
            return str(self.workspace) + suffix
        if virtual_path.startswith(VIRTUAL_UPLOADS):
            suffix = virtual_path[len(VIRTUAL_UPLOADS):]
            return str(self.uploads) + suffix
        if virtual_path.startswith(VIRTUAL_OUTPUTS):
            suffix = virtual_path[len(VIRTUAL_OUTPUTS):]
            return str(self.outputs) + suffix
        if virtual_path.startswith(VIRTUAL_SKILLS):
            suffix = virtual_path[len(VIRTUAL_SKILLS):]
            return str(self.skills) + suffix
        if virtual_path.startswith(VIRTUAL_PREFIX):
            suffix = virtual_path[len(VIRTUAL_PREFIX):]
            return str(self.workspace) + suffix
        return virtual_path

    def physical_to_virtual(self, physical_path: str) -> str:
        """Translate a physical path back to its virtual counterpart."""
        p = str(physical_path)
        ws = str(self.workspace)
        up = str(self.uploads)
        out = str(self.outputs)
        sk = str(self.skills)
        if p.startswith(ws):
            return VIRTUAL_WORKSPACE + p[len(ws):]
        if p.startswith(up):
            return VIRTUAL_UPLOADS + p[len(up):]
        if p.startswith(out):
            return VIRTUAL_OUTPUTS + p[len(out):]
        if p.startswith(sk):
            return VIRTUAL_SKILLS + p[len(sk):]
        return physical_path

    def translate_command(self, command: str) -> str:
        """Replace all virtual paths in a shell command with physical paths."""
        def _replace(match: re.Match) -> str:
            return self.virtual_to_physical(match.group(0))
        return _VIRTUAL_PATH_RE.sub(_replace, command)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "workspace": str(self.workspace),
            "uploads": str(self.uploads),
            "outputs": str(self.outputs),
            "skills": str(self.skills),
            "virtual_prefix": VIRTUAL_PREFIX,
        }
