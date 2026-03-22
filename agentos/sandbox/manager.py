"""E2B Sandbox Manager — manages sandbox lifecycle and operations.

Uses the E2B REST API directly (no SDK dependency required).
Falls back to local subprocess execution when E2B_API_KEY is not set.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from agentos.sandbox.virtual_paths import PathMapping

logger = logging.getLogger(__name__)

E2B_API_BASE = "https://api.e2b.dev"


@dataclass
class ExecResult:
    """Result of executing a command in a sandbox."""
    sandbox_id: str
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: float


@dataclass
class FileResult:
    """Result of a file operation in a sandbox."""
    sandbox_id: str
    path: str
    content: str | None = None
    success: bool = True
    error: str | None = None


@dataclass
class SandboxSession:
    """Tracks an active sandbox session."""
    sandbox_id: str
    template: str = "base"
    status: str = "running"
    created_at: float = field(default_factory=time.time)
    last_activity_at: float = field(default_factory=time.time)


class SandboxManager:
    """Manages E2B sandbox lifecycle — create, exec, file I/O, kill.

    When E2B_API_KEY is not available, falls back to local subprocess
    execution (for development only — NOT sandboxed).
    """

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("E2B_API_KEY", "")
        self.allow_local_fallback = (
            os.environ.get("AGENTOS_ALLOW_LOCAL_SANDBOX", "").lower()
            in {"1", "true", "yes"}
            or "PYTEST_CURRENT_TEST" in os.environ
        )
        root = os.environ.get("AGENTOS_LOCAL_SANDBOX_ROOT", ".agentos_sandbox")
        self.local_sandbox_root = (Path.cwd() / root).resolve()
        self._sessions: dict[str, SandboxSession] = {}
        self._path_mappings: dict[str, PathMapping] = {}
        self._default_sandbox_id: str | None = None

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict[str, str]:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    async def create(
        self, template: str = "base", timeout_sec: int = 300
    ) -> SandboxSession:
        """Create a new E2B sandbox."""
        if not self.has_api_key:
            if not self.allow_local_fallback:
                raise RuntimeError(
                    "E2B_API_KEY is not set and local fallback is disabled. "
                    "Set AGENTOS_ALLOW_LOCAL_SANDBOX=1 for local development."
                )
            # Local fallback — fake sandbox ID
            session = SandboxSession(sandbox_id=f"local-{int(time.time())}", template="local")
            mapping = PathMapping.for_session(
                session_id=session.sandbox_id,
                base_dir=self.local_sandbox_root,
                skills_dir=(Path.cwd() / "skills").resolve(),
            )
            mapping.ensure_dirs()
            self._path_mappings[session.sandbox_id] = mapping
            self._sessions[session.sandbox_id] = session
            self._default_sandbox_id = session.sandbox_id
            logger.info("Created local fallback sandbox: %s", session.sandbox_id)
            return session

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{E2B_API_BASE}/sandboxes",
                headers=self._headers(),
                json={"templateID": template, "timeout": timeout_sec},
            )
            resp.raise_for_status()
            data = resp.json()

        sandbox_id = data["sandboxID"]
        session = SandboxSession(sandbox_id=sandbox_id, template=template)
        self._sessions[sandbox_id] = session
        self._default_sandbox_id = sandbox_id
        logger.info("Created E2B sandbox: %s (template=%s)", sandbox_id, template)
        return session

    async def _ensure_sandbox(self, sandbox_id: str | None = None) -> str:
        """Get an existing sandbox ID or create a new one."""
        sid = sandbox_id or self._default_sandbox_id
        if sid and sid in self._sessions:
            return sid
        session = await self.create()
        return session.sandbox_id

    async def exec(
        self,
        command: str,
        sandbox_id: str | None = None,
        timeout_ms: int = 30000,
    ) -> ExecResult:
        """Execute a shell command in a sandbox."""
        sid = await self._ensure_sandbox(sandbox_id)
        start = time.time()

        if sid.startswith("local-"):
            return await self._exec_local(sid, command, timeout_ms)

        async with httpx.AsyncClient(timeout=max(timeout_ms / 1000 + 5, 35.0)) as client:
            resp = await client.post(
                f"{E2B_API_BASE}/sandboxes/{sid}/commands",
                headers=self._headers(),
                json={"cmd": command, "timeout": timeout_ms // 1000},
            )

            if not resp.is_success:
                err = resp.text
                return ExecResult(
                    sandbox_id=sid,
                    stdout="",
                    stderr=f"E2B error: {err}",
                    exit_code=-1,
                    duration_ms=(time.time() - start) * 1000,
                )

            data = resp.json()

        self._touch(sid)
        return ExecResult(
            sandbox_id=sid,
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            exit_code=data.get("exitCode", 0),
            duration_ms=(time.time() - start) * 1000,
        )

    async def _exec_local(self, sid: str, command: str, timeout_ms: int) -> ExecResult:
        """Local subprocess fallback (development only)."""
        import asyncio

        start = time.time()
        try:
            mapping = self._path_mappings.get(sid)
            translated_command = mapping.translate_command(command) if mapping else command
            proc = await asyncio.create_subprocess_exec(
                "/bin/sh",
                "-lc",
                translated_command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._local_session_dir(sid)),
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_ms / 1000
            )
            return ExecResult(
                sandbox_id=sid,
                stdout=stdout.decode(errors="replace"),
                stderr=stderr.decode(errors="replace"),
                exit_code=proc.returncode or 0,
                duration_ms=(time.time() - start) * 1000,
            )
        except asyncio.TimeoutError:
            # Kill the subprocess to prevent it from running in the background
            try:
                proc.kill()
                await proc.wait()
            except (ProcessLookupError, OSError):
                pass
            return ExecResult(
                sandbox_id=sid,
                stdout="",
                stderr="Command timed out",
                exit_code=-1,
                duration_ms=(time.time() - start) * 1000,
            )

    async def file_write(
        self, path: str, content: str, sandbox_id: str | None = None
    ) -> FileResult:
        """Write a file inside the sandbox."""
        sid = await self._ensure_sandbox(sandbox_id)

        if sid.startswith("local-"):
            try:
                p = self._resolve_local_path(sid, path)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content)
                return FileResult(sandbox_id=sid, path=path, success=True)
            except Exception as e:
                return FileResult(sandbox_id=sid, path=path, success=False, error=str(e))

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{E2B_API_BASE}/sandboxes/{sid}/files",
                headers=self._headers(),
                json={"path": path, "content": content},
            )

        self._touch(sid)
        if not resp.is_success:
            return FileResult(sandbox_id=sid, path=path, success=False, error=resp.text)
        return FileResult(sandbox_id=sid, path=path, success=True)

    async def file_read(
        self, path: str, sandbox_id: str | None = None
    ) -> FileResult:
        """Read a file from the sandbox."""
        sid = await self._ensure_sandbox(sandbox_id)

        if sid.startswith("local-"):
            try:
                content = self._resolve_local_path(sid, path).read_text(errors="replace")
                return FileResult(sandbox_id=sid, path=path, content=content, success=True)
            except Exception as e:
                return FileResult(sandbox_id=sid, path=path, success=False, error=str(e))

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{E2B_API_BASE}/sandboxes/{sid}/files",
                headers=self._headers(),
                params={"path": path},
            )

        self._touch(sid)
        if not resp.is_success:
            return FileResult(sandbox_id=sid, path=path, success=False, error=resp.text)
        data = resp.json()
        return FileResult(sandbox_id=sid, path=path, content=data.get("content", ""), success=True)

    async def list_sandboxes(self) -> list[dict[str, Any]]:
        """List all active sandboxes from E2B API."""
        if not self.has_api_key:
            return [
                {"sandbox_id": s.sandbox_id, "template": s.template, "status": s.status}
                for s in self._sessions.values()
            ]

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{E2B_API_BASE}/sandboxes",
                headers=self._headers(),
            )

        if not resp.is_success:
            return []

        data = resp.json()
        return [
            {"sandbox_id": s["sandboxID"], "template": s["templateID"], "started_at": s.get("startedAt", "")}
            for s in data
        ]

    async def kill(self, sandbox_id: str | None = None) -> bool:
        """Kill a sandbox."""
        sid = sandbox_id or self._default_sandbox_id
        if not sid:
            return False

        if sid.startswith("local-"):
            self._sessions.pop(sid, None)
            self._path_mappings.pop(sid, None)
            if self._default_sandbox_id == sid:
                self._default_sandbox_id = None
            return True

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.delete(
                f"{E2B_API_BASE}/sandboxes/{sid}",
                headers=self._headers(),
            )

        self._sessions.pop(sid, None)
        self._path_mappings.pop(sid, None)
        if self._default_sandbox_id == sid:
            self._default_sandbox_id = None
        return resp.is_success

    async def keepalive(self, sandbox_id: str | None = None, timeout_sec: int = 300) -> bool:
        """Extend sandbox timeout."""
        sid = sandbox_id or self._default_sandbox_id
        if not sid or not self.has_api_key or sid.startswith("local-"):
            return False

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{E2B_API_BASE}/sandboxes/{sid}/timeout",
                headers=self._headers(),
                json={"timeout": timeout_sec},
            )

        self._touch(sid)
        return resp.is_success

    def _touch(self, sandbox_id: str) -> None:
        """Update last activity timestamp."""
        if sandbox_id in self._sessions:
            self._sessions[sandbox_id].last_activity_at = time.time()

    def _local_session_dir(self, sandbox_id: str) -> Path:
        """Return the local workspace directory for fallback mode."""
        mapping = self._path_mappings.get(sandbox_id)
        if mapping:
            mapping.ensure_dirs()
            return mapping.workspace
        # Backward compatibility for sessions created before mapping integration.
        p = (self.local_sandbox_root / sandbox_id / "user-data" / "workspace").resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _resolve_local_path(self, sandbox_id: str, raw_path: str) -> Path:
        """Resolve and constrain local file paths to a session directory."""
        if not raw_path.strip():
            raise ValueError("path cannot be empty")

        mapping = self._path_mappings.get(sandbox_id)
        normalized_path = raw_path
        if mapping:
            normalized_path = mapping.virtual_to_physical(raw_path)

        session_dir = self._local_session_dir(sandbox_id)
        requested = Path(normalized_path)
        if requested.is_absolute():
            resolved = requested.resolve()
        else:
            resolved = (session_dir / requested).resolve()

        allowed_roots = [session_dir]
        if mapping:
            allowed_roots = [mapping.workspace.resolve(), mapping.uploads.resolve(), mapping.outputs.resolve()]

        in_bounds = False
        for root in allowed_roots:
            try:
                resolved.relative_to(root)
                in_bounds = True
                break
            except ValueError:
                continue
        if not in_bounds:
            raise ValueError(f"path escapes local sandbox: {raw_path}")
        return resolved
