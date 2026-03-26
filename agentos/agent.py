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

from agentos.defaults import DEFAULT_MODEL
from agentos.env import load_dotenv_if_present

logger = logging.getLogger(__name__)


def _resolve_agents_dir() -> Path:
    """Resolve the agents directory — cwd/agents/ first, then package root.

    Called dynamically (not cached at import time) so that tests and
    commands that change cwd after import still find the right directory.
    """
    cwd_agents = Path.cwd() / "agents"
    if cwd_agents.is_dir():
        return cwd_agents
    # Fall back to package-level agents dir (for development)
    pkg_agents = Path(__file__).resolve().parent.parent / "agents"
    if pkg_agents.is_dir():
        return pkg_agents
    return cwd_agents  # Default: will be created on save


# Kept as a module-level alias for backward compatibility.
# New code should call _resolve_agents_dir() for a fresh lookup.
AGENTS_DIR = _resolve_agents_dir()


@dataclass
class AgentConfig:
    """The complete definition of an agent — loadable from YAML or dict."""

    name: str
    description: str = ""
    version: str = "0.1.0"

    # Identity — agent_id is immutable, generated once at init
    agent_id: str = ""
    system_prompt: str = "You are a helpful AI assistant."
    personality: str = ""

    # LLM settings
    model: str = DEFAULT_MODEL
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

    # Plan — selects LLM routing tier (basic/standard/premium/code/dedicated/private)
    plan: str = "standard"

    # Harness config — controls middleware, skills, memory, retries
    harness: dict[str, Any] = field(default_factory=lambda: {
        "runtime_mode": "graph",  # graph is active runtime; legacy "harness" values are ignored
        "enable_loop_detection": True,
        "enable_summarization": True,
        "enable_skills": True,
        "enable_async_memory": False,
        "enable_checkpoints": False,
        "require_human_approval": False,
        "max_context_tokens": 100_000,
        "retry_on_tool_failure": True,
        "max_retries": 3,
    })

    # Metadata
    tags: list[str] = field(default_factory=list)
    author: str = ""
    built_with: str = ""  # "stub" | "anthropic" | "openai" | "" — how create built this agent

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict (for YAML/JSON output)."""
        d: dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "agent_id": self.agent_id,
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
            "plan": self.plan,
            "harness": self.harness,
            "tags": self.tags,
            "author": self.author,
        }
        if self.built_with:
            d["built_with"] = self.built_with
        return d

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


def save_agent_config(
    config: AgentConfig,
    path: str | Path | None = None,
    org_id: str = "",
    project_id: str = "",
    created_by: str = "",
) -> Path:
    """Save an agent definition — dual-write to DB + filesystem."""
    # 1. Write to DB (primary, works across pods)
    save_agent_to_db(config, org_id=org_id, project_id=project_id, created_by=created_by)

    # 2. Write to filesystem (backward compat, local dev)
    if path is None:
        agents_dir = _resolve_agents_dir()
        agents_dir.mkdir(parents=True, exist_ok=True)
        path = agents_dir / f"{config.name}.json"
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
    """Discover all agent definitions — DB first, filesystem fallback."""
    db_agents = _list_agents_from_db()
    if db_agents is not None:
        # Merge: DB is authoritative, but include filesystem-only agents
        db_names = {a.name for a in db_agents}
        fs_agents = _list_agents_from_fs(directory)
        for a in fs_agents:
            if a.name not in db_names:
                db_agents.append(a)
        return db_agents
    return _list_agents_from_fs(directory)


def _list_agents_from_fs(directory: str | Path | None = None) -> list[AgentConfig]:
    """Discover agent definitions from filesystem."""
    directory = Path(directory) if directory else _resolve_agents_dir()
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


# ── DB-backed agent registry ─────────────────────────────────────────

def _get_registry_db():
    """Get DB for agent registry, or None if unavailable."""
    try:
        from agentos.core.db_config import get_db, initialize_db
        initialize_db()
        return get_db()
    except Exception:
        return None


def save_agent_to_db(
    config: AgentConfig,
    org_id: str = "",
    project_id: str = "",
    created_by: str = "",
) -> bool:
    """Persist an agent config to the agents table. Returns True on success.

    Delegates to AgentDB.upsert_agent() which handles race-safe upsert
    on the (org_id, project_id, name) unique index.
    """
    db = _get_registry_db()
    if db is None:
        return False
    try:
        db.upsert_agent(
            org_id=org_id,
            project_id=project_id,
            name=config.name,
            config_dict=config.to_dict(),
            created_by=created_by,
            agent_id=config.agent_id or "",
            version=config.version,
        )
        return True
    except Exception as exc:
        logger.warning("Failed to save agent '%s' to DB: %s", config.name, exc)
        return False


def get_agent_from_db(name: str, org_id: str = "", project_id: str = "") -> AgentConfig | None:
    """Load an agent config from the DB by name. Returns None if not found.

    If org_id/project_id are provided, scopes the lookup. Otherwise falls
    back to name-only search (for CLI / single-tenant compat).
    """
    db = _get_registry_db()
    if db is None:
        return None
    try:
        if org_id:
            row = db.get_agent(org_id, project_id or "", name)
        else:
            row = db.get_agent_by_name(name)
        if not row:
            return None
        data = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else row["config_json"]
        return AgentConfig.from_dict(data)
    except Exception as exc:
        logger.warning("Failed to load agent '%s' from DB: %s", name, exc)
        return None


def _list_agents_from_db(org_id: str = "") -> list[AgentConfig] | None:
    """List active agents from DB. Returns None if DB unavailable.

    If org_id is provided, scopes to that org. Otherwise lists all.
    """
    db = _get_registry_db()
    if db is None:
        return None
    try:
        if org_id:
            rows = db.list_agents_for_org(org_id)
        else:
            rows = db.conn.execute(
                "SELECT config_json FROM agents WHERE is_active = 1 ORDER BY name"
            ).fetchall()
            rows = [dict(r) for r in rows]
        agents = []
        for row in rows:
            try:
                data = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else row["config_json"]
                agents.append(AgentConfig.from_dict(data))
            except Exception as exc:
                logger.warning("Skipping malformed DB agent: %s", exc)
        return agents
    except Exception as exc:
        logger.warning("Failed to list agents from DB: %s", exc)
        return None


def delete_agent_from_db(name: str, org_id: str = "", project_id: str = "") -> bool:
    """Soft-delete an agent from the DB. Returns True on success.

    Scoping:
      - org_id + project_id → exact match on all three
      - org_id only         → matches name within org (any project)
      - neither             → matches by name globally (legacy compat)
    """
    db = _get_registry_db()
    if db is None:
        return False
    try:
        import time as _time
        now = _time.time()
        if org_id and project_id:
            return db.delete_agent(org_id, project_id, name)
        elif org_id:
            cur = db.conn.execute(
                "UPDATE agents SET is_active = 0, updated_at = ? "
                "WHERE org_id = ? AND name = ? AND is_active = 1",
                (now, org_id, name),
            )
            db.conn.commit()
            return (cur.rowcount or 0) > 0
        else:
            cur = db.conn.execute(
                "UPDATE agents SET is_active = 0, updated_at = ? WHERE name = ? AND is_active = 1",
                (now, name),
            )
            db.conn.commit()
            return (cur.rowcount or 0) > 0
    except Exception as exc:
        logger.warning("Failed to delete agent '%s' from DB: %s", name, exc)
        return False


def seed_agents_to_db() -> int:
    """Seed filesystem agents into the DB (idempotent). Returns count seeded."""
    db = _get_registry_db()
    if db is None:
        return 0
    count = 0
    for config in _list_agents_from_fs():
        try:
            db.upsert_agent(
                org_id="", project_id="", name=config.name,
                config_dict=config.to_dict(), created_by="auto-seed",
                agent_id=config.agent_id or "", version=config.version,
            )
            count += 1
        except Exception as exc:
            logger.warning("Failed to seed agent '%s': %s", config.name, exc)
    return count


class Agent:
    """A runnable agent instance built from an AgentConfig.

    This is the primary user-facing class. Config loading, identity,
    and persistence are handled here. Execution is delegated to the
    TypeScript control-plane runtime (deploy/src/runtime/).

    The Python harness, LLM router, and graph adapter have been removed.
    Use ``agentos deploy`` to push agents to the TS runtime, then call
    the control-plane API to run them.
    """

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        load_dotenv_if_present()
        self._apply_project_defaults()
        self._observer = None
        self._tracer = None
        self._runtime_context: dict[str, str] = {}
        self._init_db()

    def _apply_project_defaults(self) -> None:
        """Apply project-level defaults from agentos.yaml (if present).

        This runs automatically on construction so every code path
        (run, chat, eval, evolve) inherits project settings without
        each CLI command needing to call it separately.
        """
        config_path = Path.cwd() / "agentos.yaml"
        if not config_path.exists():
            return
        try:
            try:
                import yaml
                data = yaml.safe_load(config_path.read_text()) or {}
            except ImportError:
                data = {}
            defaults = data.get("defaults", {}) if isinstance(data, dict) else {}
            if not defaults:
                return
            from agentos.defaults import DEFAULT_MODEL
            if defaults.get("model") and self.config.model == DEFAULT_MODEL:
                self.config.model = defaults["model"]
            budget = defaults.get("budget_limit_usd")
            if budget and self.config.governance.get("budget_limit_usd") == 10.0:
                self.config.governance["budget_limit_usd"] = budget
        except Exception:
            pass

    def _init_db(self) -> None:
        """Open the SQLite database if data/ dir exists.

        Called before _build_harness so memory classes can use the DB.
        """
        self._db = None
        try:
            from agentos.core.db_config import get_db, initialize_db
            initialize_db()
            self._db = get_db()
        except Exception as exc:
            logger.warning("Could not open configured database backend: %s", exc)
            self._db = None

    def set_runtime_context(self, *, org_id: str = "", project_id: str = "", user_id: str = "") -> None:
        """Set per-request tenancy context."""
        self._runtime_context = {
            "org_id": org_id or "",
            "project_id": project_id or "",
            "user_id": user_id or "",
        }

    @property
    def db(self):
        """The agent's SQLite database (None if no data/ dir)."""
        return self._db

    def apply_overrides(
        self,
        *,
        turns: int | None = None,
        timeout: float | None = None,
        budget: float | None = None,
        model: str | None = None,
    ) -> None:
        """Apply runtime overrides to the agent config."""
        if turns is not None:
            self.config.max_turns = turns
        if timeout is not None:
            self.config.timeout_seconds = timeout
        if budget is not None:
            self.config.governance["budget_limit_usd"] = budget
        if model is not None:
            self.config.model = model

    async def run(self, user_input: str) -> list:
        """Execute the agent on a user task.

        The Python harness runtime has been removed. Deploy the agent
        via ``agentos deploy`` and call the TS control-plane API instead.
        """
        raise NotImplementedError(
            "Python runtime removed. Use 'agentos deploy' to push this agent "
            "to the TS control-plane, then call the API to run it.\n"
            "See: deploy/src/runtime/engine.ts"
        )

    @classmethod
    def from_file(cls, path: str | Path) -> Agent:
        """Load an agent from a YAML/JSON definition file."""
        return cls(load_agent_config(path))

    @classmethod
    def from_name(cls, name: str, directory: str | Path | None = None) -> Agent:
        """Load a named agent — DB first, filesystem fallback."""
        # Try DB registry first (works across pods, no filesystem needed)
        db_config = get_agent_from_db(name)
        if db_config is not None:
            return cls(db_config)

        # Filesystem fallback (local dev, legacy agents)
        directory = Path(directory) if directory else _resolve_agents_dir()
        for ext in (".yaml", ".yml", ".json"):
            p = directory / f"{name}{ext}"
            if p.exists():
                return cls.from_file(p)
        raise FileNotFoundError(f"No agent definition found for '{name}'")
