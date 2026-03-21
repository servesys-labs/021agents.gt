"""Tool plugin registry — discover and load tools from the plugins directory."""

from __future__ import annotations

import importlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from agentos.tools.mcp import MCPServer, MCPTool

logger = logging.getLogger(__name__)

# Default plugins directory at project root
PLUGINS_DIR = Path(__file__).resolve().parent.parent.parent / "tools"


@dataclass
class ToolPlugin:
    """A discovered tool plugin with metadata and optional handler."""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    handler: Callable | None = None
    source_path: Path | None = None

    def to_mcp_tool(self) -> MCPTool:
        return MCPTool(
            name=self.name,
            description=self.description,
            input_schema=self.input_schema,
        )

    def to_mcp_server(self) -> MCPServer:
        return MCPServer(name=self.name, tools=[self.to_mcp_tool()])


class ToolRegistry:
    """Discovers and manages tool plugins.

    Tools can be registered:
    1. From JSON files in the tools/ directory (declarative)
    2. From Python modules in the tools/ directory (with handlers)
    3. Programmatically via register()
    """

    def __init__(self, plugins_dir: str | Path | None = None) -> None:
        self._plugins_dir = Path(plugins_dir) if plugins_dir else PLUGINS_DIR
        self._tools: dict[str, ToolPlugin] = {}
        self._discovered = False

    def _discover(self) -> None:
        """Scan the plugins directory for tool definitions."""
        if self._discovered:
            return
        self._discovered = True

        if not self._plugins_dir.exists():
            return

        # Load JSON tool definitions
        for p in sorted(self._plugins_dir.glob("*.json")):
            try:
                data = json.loads(p.read_text())
                tools = data if isinstance(data, list) else [data]
                for t in tools:
                    plugin = ToolPlugin(
                        name=t["name"],
                        description=t.get("description", ""),
                        input_schema=t.get("input_schema", {}),
                        source_path=p,
                    )
                    self._tools[plugin.name] = plugin
            except Exception as exc:
                logger.warning("Failed to load tool from %s: %s", p, exc)

        # Load Python tool modules
        for p in sorted(self._plugins_dir.glob("*.py")):
            if p.name.startswith("_"):
                continue
            try:
                spec = importlib.util.spec_from_file_location(p.stem, p)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)

                    # Look for TOOLS list or register() function
                    if hasattr(module, "TOOLS"):
                        for t in module.TOOLS:
                            plugin = ToolPlugin(
                                name=t["name"],
                                description=t.get("description", ""),
                                input_schema=t.get("input_schema", {}),
                                handler=t.get("handler"),
                                source_path=p,
                            )
                            self._tools[plugin.name] = plugin
                    elif hasattr(module, "register"):
                        result = module.register()
                        if isinstance(result, dict):
                            plugin = ToolPlugin(
                                name=result["name"],
                                description=result.get("description", ""),
                                input_schema=result.get("input_schema", {}),
                                handler=result.get("handler"),
                                source_path=p,
                            )
                            self._tools[plugin.name] = plugin
            except Exception as exc:
                logger.warning("Failed to load tool module %s: %s", p, exc)

    def register(self, plugin: ToolPlugin) -> None:
        """Register a tool plugin programmatically."""
        self._tools[plugin.name] = plugin

    def get(self, name: str) -> ToolPlugin | None:
        """Get a tool plugin by name."""
        self._discover()
        return self._tools.get(name)

    def list_all(self) -> list[ToolPlugin]:
        """List all discovered tool plugins."""
        self._discover()
        return list(self._tools.values())

    def names(self) -> list[str]:
        """List all tool names."""
        self._discover()
        return list(self._tools.keys())

    def to_mcp_client(self):
        """Create an MCPClient pre-loaded with all discovered tools."""
        from agentos.tools.mcp import MCPClient
        self._discover()
        client = MCPClient()
        for plugin in self._tools.values():
            client.register_server(plugin.to_mcp_server())
            if plugin.handler:
                client.register_handler(plugin.name, plugin.handler)
        return client
