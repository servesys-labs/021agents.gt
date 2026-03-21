"""E2B Sandbox integration for AgentOS.

Provides secure code execution, file I/O, and browser access via E2B micro-VMs.
Each sandbox is a Firecracker micro-VM with full Linux, terminal, and filesystem.

Usage:
    from agentos.sandbox import SandboxManager

    mgr = SandboxManager(api_key="e2b_...")
    result = await mgr.exec("echo hello")
    print(result.stdout)  # "hello"
"""

from agentos.sandbox.manager import SandboxManager, SandboxSession, ExecResult, FileResult

__all__ = ["SandboxManager", "SandboxSession", "ExecResult", "FileResult"]
