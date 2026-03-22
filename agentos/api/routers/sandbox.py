"""Sandbox router — E2B sandbox management via v1 API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from agentos.api.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/sandbox", tags=["sandbox"])


@router.post("/create")
async def create_sandbox(
    template: str = "base",
    timeout_sec: int = 300,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a new E2B sandbox."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    if not mgr.has_api_key:
        raise HTTPException(status_code=503, detail="E2B_API_KEY not configured")
    session = await mgr.create(template=template, timeout_sec=timeout_sec)
    return {"sandbox_id": session.sandbox_id, "template": session.template, "status": session.status}


@router.post("/exec")
async def exec_command(
    command: str,
    sandbox_id: str = "",
    timeout_ms: int = 30000,
    user: CurrentUser = Depends(get_current_user),
):
    """Execute a command in a sandbox."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    if not mgr.has_api_key:
        raise HTTPException(status_code=503, detail="E2B_API_KEY not configured")
    result = await mgr.exec(command=command, sandbox_id=sandbox_id or None, timeout_ms=timeout_ms)
    return {
        "sandbox_id": result.sandbox_id, "stdout": result.stdout,
        "stderr": result.stderr, "exit_code": result.exit_code,
    }


@router.get("/list")
async def list_sandboxes(user: CurrentUser = Depends(get_current_user)):
    """List active sandboxes."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    sandboxes = await mgr.list_sandboxes()
    return {"sandboxes": sandboxes}


@router.post("/kill")
async def kill_sandbox(sandbox_id: str, user: CurrentUser = Depends(get_current_user)):
    """Kill a sandbox."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    killed = await mgr.kill(sandbox_id=sandbox_id)
    return {"killed": killed, "sandbox_id": sandbox_id}


@router.get("/{sandbox_id}/files")
async def list_sandbox_files(
    sandbox_id: str,
    path: str = "/",
    user: CurrentUser = Depends(get_current_user),
):
    """List files in a sandbox directory."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    if not mgr.has_api_key:
        raise HTTPException(status_code=503, detail="E2B_API_KEY not configured")
    result = await mgr.exec(command=f"ls -la {path}", sandbox_id=sandbox_id, timeout_ms=10000)
    lines = result.stdout.strip().split("\n") if result.stdout else []
    return {"sandbox_id": sandbox_id, "path": path, "files": lines}


@router.post("/{sandbox_id}/files/upload")
async def upload_sandbox_file(
    sandbox_id: str,
    dest_path: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Upload a file to a sandbox."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    if not mgr.has_api_key:
        raise HTTPException(status_code=503, detail="E2B_API_KEY not configured")
    content = (await file.read()).decode("utf-8", errors="replace")
    result = await mgr.file_write(path=dest_path, content=content, sandbox_id=sandbox_id)
    return {
        "sandbox_id": result.sandbox_id,
        "path": result.path,
        "success": result.success,
        "error": result.error,
    }


@router.get("/{sandbox_id}/logs")
async def get_sandbox_logs(
    sandbox_id: str,
    lines: int = 100,
    user: CurrentUser = Depends(get_current_user),
):
    """Get sandbox execution logs."""
    from agentos.sandbox import SandboxManager
    mgr = SandboxManager()
    if not mgr.has_api_key:
        raise HTTPException(status_code=503, detail="E2B_API_KEY not configured")
    # Retrieve recent command history / logs from the sandbox
    result = await mgr.exec(
        command=f"tail -n {lines} /var/log/sandbox.log 2>/dev/null || echo 'No logs available'",
        sandbox_id=sandbox_id,
        timeout_ms=10000,
    )
    return {
        "sandbox_id": sandbox_id,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exit_code": result.exit_code,
    }
