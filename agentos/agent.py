"""First-class Agent definition — the unit users think in.

An Agent is defined by a YAML file and represents a configured, runnable
autonomous entity with its own identity, system prompt, tools, memory,
and governance settings.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

def _resolve_agents_dir() -> Path:
    """Resolve the agents directory — cwd/agents/ first, then package root."""
    cwd_agents = Path.cwd() / "agents"
    if cwd_agents.is_dir():
        return cwd_agents
    # Fall back to package-level agents dir (for development)
    pkg_agents = Path(__file__).resolve().parent.parent / "agents"
    if pkg_agents.is_dir():
        return pkg_agents
    return cwd_agents  # Default: will be created on save


AGENTS_DIR = _resolve_agents_dir()


@dataclass
class AgentConfig:
    """The complete definition of an agent — loadable from YAML or dict."""

    name: str
    description: str = ""
    version: str = "0.1.0"

    # Identity
    system_prompt: str = "You are a helpful AI assistant."
    personality: str = ""

    # LLM settings
    model: str = "claude-sonnet-4-20250514"
    max_tokens: int = 4096
    temperature: float = 0.0

    # Tools — list of tool names or tool definitions
    tools: list[str | dict[str, Any]] = field(default_factory=list)

    # Memory settings
    memory: dict[str, Any] = field(default_factory=lambda: {
        "working": {"max_items": 100},
        "episodic": {"max_episodes": 10000, "ttl_days": 90},
        "procedural": {"max_procedures": 500},
    })

    # Governance
    governance: dict[str, Any] = field(default_factory=lambda: {
        "budget_limit_usd": 10.0,
        "blocked_tools": [],
        "require_confirmation_for_destructive": True,
    })

    # Harness
    max_turns: int = 50
    timeout_seconds: float = 300.0

    # Metadata
    tags: list[str] = field(default_factory=list)
    author: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict (for YAML/JSON output)."""
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "system_prompt": self.system_prompt,
            "personality": self.personality,
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "tools": self.tools,
            "memory": self.memory,
            "governance": self.governance,
            "max_turns": self.max_turns,
            "timeout_seconds": self.timeout_seconds,
            "tags": self.tags,
            "author": self.author,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentConfig:
        """Create from a plain dict, ignoring unknown keys."""
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)


def _yaml_available() -> bool:
    try:
        import yaml  # noqa: F401
        return True
    except ImportError:
        return False


def load_agent_config(path: str | Path) -> AgentConfig:
    """Load an agent definition from a YAML or JSON file."""
    path = Path(path)
    text = path.read_text()

    if path.suffix in (".yaml", ".yml"):
        if _yaml_available():
            import yaml
            data = yaml.safe_load(text) or {}
        else:
            raise ImportError(
                "PyYAML is required for YAML agent files. "
                "Install with: pip install pyyaml"
            )
    elif path.suffix == ".json":
        data = json.loads(text)
    else:
        # Try JSON first, then YAML
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            if _yaml_available():
                import yaml
                data = yaml.safe_load(text) or {}
            else:
                raise ValueError(f"Cannot parse {path}; install pyyaml for YAML support")

    return AgentConfig.from_dict(data)


def save_agent_config(config: AgentConfig, path: str | Path | None = None) -> Path:
    """Save an agent definition to a YAML or JSON file."""
    if path is None:
        AGENTS_DIR.mkdir(parents=True, exist_ok=True)
        path = AGENTS_DIR / f"{config.name}.json"
    else:
        path = Path(path)

    path.parent.mkdir(parents=True, exist_ok=True)
    data = config.to_dict()

    if path.suffix in (".yaml", ".yml") and _yaml_available():
        import yaml
        path.write_text(yaml.dump(data, default_flow_style=False, sort_keys=False))
    else:
        if path.suffix in (".yaml", ".yml"):
            path = path.with_suffix(".json")
        path.write_text(json.dumps(data, indent=2) + "\n")

    return path


def list_agents(directory: str | Path | None = None) -> list[AgentConfig]:
    """Discover all agent definitions in a directory."""
    directory = Path(directory) if directory else AGENTS_DIR
    if not directory.exists():
        return []

    agents = []
    for p in sorted(directory.iterdir()):
        if p.suffix in (".yaml", ".yml", ".json") and not p.name.startswith("."):
            try:
                agents.append(load_agent_config(p))
            except Exception as exc:
                logger.warning("Skipping %s: %s", p, exc)
    return agents


class Agent:
    """A runnable agent instance built from an AgentConfig.

    This is the primary user-facing class. It wires up the harness,
    tools, memory, and governance from a single config object.
    """

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self._harness = self._build_harness()

    def _build_harness(self):
        """Wire up all subsystems from the agent config."""
        import os

        from agentos.core.governance import GovernanceLayer, GovernancePolicy
        from agentos.core.harness import AgentHarness, HarnessConfig
        from agentos.llm.router import Complexity, LLMRouter
        from agentos.llm.provider import HttpProvider, StubProvider
        from agentos.memory.manager import MemoryManager
        from agentos.memory.working import WorkingMemory
        from agentos.memory.episodic import EpisodicMemory
        from agentos.memory.procedural import ProceduralMemory
        from agentos.tools.executor import ToolExecutor
        from agentos.tools.mcp import MCPClient
        from agentos.tools.registry import ToolRegistry

        # Harness config
        harness_cfg = HarnessConfig(
            max_turns=self.config.max_turns,
            timeout_seconds=self.config.timeout_seconds,
        )

        # LLM Router — configure from agent model + env API keys
        llm_router = LLMRouter()
        anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
        openai_key = os.environ.get("OPENAI_API_KEY", "")
        model = self.config.model

        if anthropic_key and ("claude" in model or not openai_key):
            provider = HttpProvider(
                model_id=model,
                api_base="https://api.anthropic.com",
                api_key=anthropic_key,
                headers={"anthropic-version": "2023-06-01"},
            )
            for tier in Complexity:
                llm_router.register(tier, provider, max_tokens=self.config.max_tokens)
        elif openai_key:
            provider = HttpProvider(
                model_id=model if "gpt" in model else "gpt-4o",
                api_base="https://api.openai.com",
                api_key=openai_key,
            )
            for tier in Complexity:
                llm_router.register(tier, provider, max_tokens=self.config.max_tokens)

        # Governance
        gov_data = self.config.governance
        gov_policy = GovernancePolicy(
            budget_limit_usd=gov_data.get("budget_limit_usd", 10.0),
            blocked_tools=gov_data.get("blocked_tools", []),
            require_confirmation_for_destructive=gov_data.get(
                "require_confirmation_for_destructive", True
            ),
        )

        # Memory
        mem_cfg = self.config.memory
        working = WorkingMemory(max_items=mem_cfg.get("working", {}).get("max_items", 100))
        episodic = EpisodicMemory(
            max_episodes=mem_cfg.get("episodic", {}).get("max_episodes", 10000),
            ttl_days=mem_cfg.get("episodic", {}).get("ttl_days", 90),
        )
        procedural = ProceduralMemory(
            max_procedures=mem_cfg.get("procedural", {}).get("max_procedures", 500),
        )
        memory_manager = MemoryManager(
            working=working, episodic=episodic, procedural=procedural
        )

        # Tools — load from registry + inline definitions
        mcp_client = MCPClient()
        registry = ToolRegistry()
        for tool_ref in self.config.tools:
            if isinstance(tool_ref, str):
                # Load from plugin registry
                plugin = registry.get(tool_ref)
                if plugin:
                    mcp_client.register_server(plugin.to_mcp_server())
                    if plugin.handler:
                        mcp_client.register_handler(plugin.name, plugin.handler)
                else:
                    logger.warning("Tool '%s' not found in registry — skipping", tool_ref)
            elif isinstance(tool_ref, dict):
                # Inline tool definition
                from agentos.tools.mcp import MCPServer, MCPTool
                tool = MCPTool(
                    name=tool_ref["name"],
                    description=tool_ref.get("description", ""),
                    input_schema=tool_ref.get("input_schema", {}),
                )
                mcp_client.register_server(
                    MCPServer(name=tool_ref["name"], tools=[tool])
                )

        harness = AgentHarness(
            config=harness_cfg,
            llm_router=llm_router,
            tool_executor=ToolExecutor(mcp_client=mcp_client),
            memory_manager=memory_manager,
            governance=GovernanceLayer(gov_policy),
        )

        # Set the agent's system prompt (used as the LLM system message)
        harness.system_prompt = self.config.system_prompt or ""
        if self.config.personality:
            harness.system_prompt += f"\n\nPersonality: {self.config.personality}"

        return harness

    async def run(self, user_input: str) -> list:
        """Execute the agent on a user task."""
        return await self._harness.run(user_input)

    @classmethod
    def from_file(cls, path: str | Path) -> Agent:
        """Load an agent from a YAML/JSON definition file."""
        return cls(load_agent_config(path))

    @classmethod
    def from_name(cls, name: str, directory: str | Path | None = None) -> Agent:
        """Load a named agent from the agents directory."""
        directory = Path(directory) if directory else AGENTS_DIR
        for ext in (".yaml", ".yml", ".json"):
            p = directory / f"{name}{ext}"
            if p.exists():
                return cls.from_file(p)
        raise FileNotFoundError(f"No agent definition found for '{name}' in {directory}")
