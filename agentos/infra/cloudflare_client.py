"""CloudflareClient — calls worker /cf/* endpoints for CF-only resources.

The backend uses this when it needs Cloudflare bindings (Vectorize, R2,
Dynamic Workers, Browser Rendering) that only the edge worker can access.

Configuration (env vars):
  AGENTOS_WORKER_URL  — base URL of the Cloudflare worker
  EDGE_INGEST_TOKEN   — shared secret (same token the worker sends to backend)

Usage:
  client = get_cf_client()   # singleton, returns None if not configured
  if client:
      result = await client.sandbox_exec("console.log('hello')")
      results = await client.rag_query("how does X work?", org_id="org_123")
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 60.0

# Module-level singleton — avoids creating a new httpx.AsyncClient per call
_cf_client_instance: CloudflareClient | None = None
_cf_client_checked = False


def get_cf_client() -> "CloudflareClient | None":
    """Return the process-wide CloudflareClient singleton.

    Returns None if AGENTOS_WORKER_URL is not set.  Safe to call from
    any async context — the underlying httpx.AsyncClient is created lazily.
    """
    global _cf_client_instance, _cf_client_checked
    if _cf_client_checked:
        return _cf_client_instance
    _cf_client_checked = True
    _cf_client_instance = CloudflareClient.from_env()
    if _cf_client_instance:
        logger.info("CloudflareClient configured: %s", _cf_client_instance.worker_url)
    return _cf_client_instance


class CloudflareClient:
    """HTTP client for Cloudflare worker /cf/* callback endpoints."""

    def __init__(self, worker_url: str, edge_token: str) -> None:
        self.worker_url = worker_url.rstrip("/")
        self.edge_token = edge_token
        self._client: httpx.AsyncClient | None = None

    @classmethod
    def from_env(cls) -> CloudflareClient | None:
        """Create from env vars. Returns None if not configured."""
        url = os.environ.get("AGENTOS_WORKER_URL", "").strip()
        token = (
            os.environ.get("EDGE_INGEST_TOKEN", "")
            or os.environ.get("BACKEND_INGEST_TOKEN", "")
        ).strip()
        if not url or not token:
            return None
        return cls(url, token)

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=_DEFAULT_TIMEOUT,
                headers={
                    "Authorization": f"Bearer {self.edge_token}",
                    "X-Edge-Token": self.edge_token,
                    "Content-Type": "application/json",
                },
            )
        return self._client

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        client = await self._get_client()
        resp = await client.post(f"{self.worker_url}{path}", json=payload)
        resp.raise_for_status()
        return resp.json()

    async def _get(self, path: str, params: dict[str, str] | None = None) -> httpx.Response:
        client = await self._get_client()
        resp = await client.get(f"{self.worker_url}{path}", params=params)
        resp.raise_for_status()
        return resp

    # ── Sandbox ──────────────────────────────────────────────────────

    async def sandbox_exec(
        self,
        code: str,
        language: str = "javascript",
        timeout_ms: int = 30000,
    ) -> dict[str, Any]:
        """Execute code in CF Dynamic Worker or Container sandbox."""
        return await self._post("/cf/sandbox/exec", {
            "code": code,
            "language": language,
            "timeoutMs": timeout_ms,
        })

    # ── AI / Embeddings ──────────────────────────────────────────────

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed texts via Workers AI (bge-base-en-v1.5)."""
        data = await self._post("/cf/ai/embed", {"texts": texts})
        return data.get("vectors", [])

    # ── RAG ──────────────────────────────────────────────────────────

    async def rag_query(
        self,
        query: str,
        top_k: int = 10,
        org_id: str = "",
        agent_name: str = "",
    ) -> list[dict[str, Any]]:
        """Semantic search via Cloudflare Vectorize."""
        data = await self._post("/cf/rag/query", {
            "query": query,
            "topK": top_k,
            "org_id": org_id,
            "agent_name": agent_name,
        })
        return data.get("results", [])

    async def rag_ingest(
        self,
        text: str,
        source: str = "api",
        org_id: str = "",
        agent_name: str = "",
    ) -> dict[str, Any]:
        """Chunk, embed, and store text in Vectorize + R2."""
        return await self._post("/cf/rag/ingest", {
            "text": text,
            "source": source,
            "org_id": org_id,
            "agent_name": agent_name,
        })

    # ── Storage (R2) ─────────────────────────────────────────────────

    async def storage_put(
        self,
        key: str,
        data: bytes,
        content_type: str = "application/octet-stream",
    ) -> dict[str, Any]:
        """Upload to R2 bucket."""
        client = await self._get_client()
        # Content-Type override needed for binary uploads (client default is application/json)
        resp = await client.post(
            f"{self.worker_url}/cf/storage/put",
            params={"key": key},
            content=data,
            headers={"Content-Type": content_type},
        )
        resp.raise_for_status()
        return resp.json()

    async def storage_get(self, key: str) -> bytes:
        """Download from R2 bucket."""
        resp = await self._get("/cf/storage/get", params={"key": key})
        return resp.content

    # ── Browse (Cloudflare Browser Rendering REST API) ──────────────

    async def browse_crawl(
        self,
        url: str,
        limit: int = 10,
        depth: int = 2,
        formats: list[str] | None = None,
    ) -> dict[str, Any]:
        """Start/poll a crawl via Cloudflare Browser Rendering /crawl API.

        Params match the CF REST API: limit (max pages), depth (link depth),
        formats (list of "markdown", "html", "links", etc.).
        """
        return await self._post("/cf/browse/crawl", {
            "url": url,
            "limit": limit,
            "depth": depth,
            "formats": formats or ["markdown"],
        })

    async def browse_render(
        self,
        url: str,
        action: str = "markdown",
        wait_for_selector: str = "",
        timeout_ms: int = 30000,
    ) -> dict[str, Any]:
        """Render a single page via Cloudflare Browser Rendering REST API.

        action maps to a CF endpoint:
          "markdown" → /markdown  (default, best for RAG)
          "html"     → /content
          "links"    → /links
          "text"     → /markdown  (alias)
          "screenshot" → /screenshot

        wait_for_selector: CSS selector to wait for before extraction.
        """
        return await self._post("/cf/browse/render", {
            "url": url,
            "action": action,
            "waitForSelector": wait_for_selector,
            "timeout": timeout_ms,
        })

    # ── Agent Teardown ─────────────────────────────────────────────

    async def teardown_agent(
        self,
        agent_name: str,
        org_id: str = "",
    ) -> dict[str, Any]:
        """Clean up all CF-side resources for a deleted agent.

        Removes: Vectorize entries, R2 files under the agent's prefix.
        """
        return await self._post("/cf/agent/teardown", {
            "agent_name": agent_name,
            "org_id": org_id,
        })

    # ── Dispatch Namespace (Workers for Platforms) ─────────────────

    def _worker_name(self, org_slug: str, agent_name: str) -> str:
        """Deterministic worker name: agentos-{org_slug}-{agent_name}."""
        import re
        slug = re.sub(r"[^a-z0-9-]", "-", f"{org_slug}-{agent_name}".lower())
        slug = re.sub(r"-+", "-", slug).strip("-")
        return f"agentos-{slug}"[:63]  # CF worker name limit

    async def deploy_customer_worker(
        self,
        org_slug: str,
        agent_name: str,
        org_id: str = "",
        project_id: str = "",
    ) -> dict[str, Any]:
        """Deploy a customer agent worker into the dispatch namespace.

        The worker is a stateless proxy — same code for every agent,
        only the env var bindings differ (AGENT_NAME, ORG_ID, etc.).
        """
        worker_name = self._worker_name(org_slug, agent_name)
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
        api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
        namespace = os.environ.get("DISPATCH_NAMESPACE", "agentos-production")
        # Customer worker calls the Railway BACKEND (not the worker).
        # Resolve the backend's public URL from Railway env vars.
        backend_url = os.environ.get("BACKEND_PUBLIC_URL", "").strip()
        if not backend_url:
            domain = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
            if domain:
                backend_url = f"https://{domain}"
        if not backend_url:
            backend_url = "https://backend-production-b174.up.railway.app"
        backend_token = self.edge_token

        if not account_id or not api_token:
            return {"error": "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set", "deployed": False}

        # Read template
        import importlib.resources
        template_path = os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "src", "customer-worker-template.js")
        try:
            template_code = open(template_path).read()
        except FileNotFoundError:
            # Fallback: inline minimal proxy
            template_code = (
                'export default{async fetch(r,e){const b=await r.json().catch(()=>({}));'
                'const resp=await fetch(`${e.BACKEND_INGEST_URL}/api/v1/runtime-proxy/agent/run`,'
                '{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${e.BACKEND_INGEST_TOKEN}`},'
                'body:JSON.stringify({...b,agent_name:e.AGENT_NAME,org_id:e.ORG_ID,channel:"dispatch_worker"})});'
                'return new Response(resp.body,{status:resp.status,headers:{"Content-Type":"application/json"}})}}'
            )

        # Multipart upload to dispatch namespace
        metadata = {
            "main_module": "index.js",
            "bindings": [
                {"type": "plain_text", "name": "AGENT_NAME", "text": agent_name},
                {"type": "plain_text", "name": "ORG_ID", "text": org_id},
                {"type": "plain_text", "name": "PROJECT_ID", "text": project_id},
                {"type": "plain_text", "name": "BACKEND_INGEST_URL", "text": backend_url},
                {"type": "secret_text", "name": "BACKEND_INGEST_TOKEN", "text": backend_token},
            ],
            "tags": [f"org:{org_slug}", f"agent:{agent_name}"],
            "compatibility_date": "2026-03-01",
        }

        import json as _json
        client = await self._get_client()

        # Build multipart form manually
        import io
        boundary = "----AgentOSWorkerUpload"
        body_parts = []
        # Part 1: metadata JSON
        body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"; filename=\"metadata.json\"\r\nContent-Type: application/json\r\n\r\n{_json.dumps(metadata)}")
        # Part 2: worker script
        body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"index.js\"; filename=\"index.js\"\r\nContent-Type: application/javascript+module\r\n\r\n{template_code}")
        body_parts.append(f"--{boundary}--")
        multipart_body = "\r\n".join(body_parts)

        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/workers/dispatch/namespaces/{namespace}/scripts/{worker_name}"
        )
        resp = await client.put(
            url,
            content=multipart_body.encode(),
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        data = resp.json()
        return {
            "deployed": resp.is_success,
            "worker_name": worker_name,
            "namespace": namespace,
            "status_code": resp.status_code,
            "result": data.get("result", data.get("errors", [])),
        }

    async def undeploy_customer_worker(
        self,
        org_slug: str,
        agent_name: str,
    ) -> dict[str, Any]:
        """Remove a customer worker from the dispatch namespace."""
        worker_name = self._worker_name(org_slug, agent_name)
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
        api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
        namespace = os.environ.get("DISPATCH_NAMESPACE", "agentos-production")

        if not account_id or not api_token:
            return {"error": "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set", "removed": False}

        client = await self._get_client()
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/workers/dispatch/namespaces/{namespace}/scripts/{worker_name}"
        )
        resp = await client.delete(url, headers={"Authorization": f"Bearer {api_token}"})
        return {
            "removed": resp.is_success,
            "worker_name": worker_name,
            "status_code": resp.status_code,
        }

    async def list_customer_workers(
        self,
        org_slug: str = "",
    ) -> list[dict[str, Any]]:
        """List customer workers in the dispatch namespace. Filter by org_slug prefix."""
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
        api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
        namespace = os.environ.get("DISPATCH_NAMESPACE", "agentos-production")

        if not account_id or not api_token:
            return []

        client = await self._get_client()
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/workers/dispatch/namespaces/{namespace}/scripts"
        )
        resp = await client.get(url, headers={"Authorization": f"Bearer {api_token}"})
        if not resp.is_success:
            return []

        data = resp.json()
        scripts = data.get("result", [])

        # Filter by org prefix if specified
        prefix = f"agentos-{org_slug}-" if org_slug else "agentos-"
        return [
            {
                "worker_name": s.get("script_name", s.get("id", "")),
                "created_on": s.get("created_on", ""),
                "modified_on": s.get("modified_on", ""),
                "tags": s.get("tags", []),
            }
            for s in scripts
            if s.get("script_name", s.get("id", "")).startswith(prefix)
        ]

    # ── Lifecycle ────────────────────────────────────────────────────

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
