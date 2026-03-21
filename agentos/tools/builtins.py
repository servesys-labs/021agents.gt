"""Built-in tool handlers for AgentOS bundled tools.

These provide real implementations for the tools shipped in the tools/ directory.
When a tool JSON has no Python handler, these are used as fallbacks.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web using DuckDuckGo's HTML interface.

    Returns a formatted string of search results.
    """
    import httpx

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={"User-Agent": "AgentOS/0.1.0"},
                timeout=15.0,
            )
            resp.raise_for_status()
    except Exception as exc:
        return f"Search failed: {exc}"

    # Parse results from the HTML response
    html = resp.text
    results = []
    # Extract result snippets from DuckDuckGo HTML
    import re
    # Find result links and snippets
    links = re.findall(
        r'<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)</a>',
        html,
    )
    snippets = re.findall(
        r'<a class="result__snippet"[^>]*>(.*?)</a>',
        html,
        re.DOTALL,
    )

    for i, (url, title) in enumerate(links[:max_results]):
        # Clean HTML tags from title and snippet
        clean_title = re.sub(r"<[^>]+>", "", title).strip()
        snippet = ""
        if i < len(snippets):
            snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip()
        results.append(f"{i+1}. {clean_title}\n   {url}\n   {snippet}")

    if not results:
        return f"No results found for: {query}"

    return "\n\n".join(results)


async def store_knowledge(key: str, content: str, tags: list[str] | None = None) -> str:
    """Store knowledge in the agent's semantic memory.

    This is a pass-through — the actual storage happens via the memory manager
    which is wired at a higher level. This handler returns a confirmation.
    """
    # In a real deployment, this would write to a vector DB.
    # For local use, we store in a simple JSON file.
    import os
    from pathlib import Path

    store_path = Path.cwd() / "data" / "knowledge.jsonl"
    store_path.parent.mkdir(parents=True, exist_ok=True)

    entry = {
        "key": key,
        "content": content,
        "tags": tags or [],
        "timestamp": time.time(),
    }

    with open(store_path, "a") as f:
        f.write(json.dumps(entry) + "\n")

    return f"Stored knowledge: '{key}' ({len(content)} chars)"


async def knowledge_search(query: str, top_k: int = 5) -> str:
    """Search the local knowledge store for relevant information."""
    from pathlib import Path

    store_path = Path.cwd() / "data" / "knowledge.jsonl"
    if not store_path.exists():
        return "Knowledge store is empty. Use store_knowledge to add entries."

    # Load all entries
    entries = []
    for line in store_path.read_text().strip().split("\n"):
        if line.strip():
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not entries:
        return "Knowledge store is empty."

    # Simple keyword matching
    query_words = set(query.lower().split())
    scored = []
    for entry in entries:
        text = f"{entry['key']} {entry['content']}".lower()
        score = sum(1 for w in query_words if w in text)
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:top_k]

    if not top:
        return f"No relevant knowledge found for: {query}"

    results = []
    for score, entry in top:
        results.append(f"[{entry['key']}] {entry['content'][:200]}")

    return "\n\n".join(results)


# Registry of built-in handlers keyed by tool name
BUILTIN_HANDLERS: dict[str, Any] = {
    "web-search": web_search,
    "store-knowledge": store_knowledge,
    "knowledge-search": knowledge_search,
}
