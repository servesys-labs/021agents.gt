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

# Module-level GMI model cache — ONE HTTP call per process, not per agent.
_gmi_model_cache: set[str] | None = None

def _gmi_validate_cached(model_id: str) -> bool:
    """Check if a model exists on GMI. Skipped — GMI removed from provider chain."""
    return False


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

    This is the primary user-facing class. It wires up the harness,
    tools, memory, governance, and observability from a single config.

    Observability is automatic: every ``run()`` call is traced and
    recorded to SQLite (if data/ exists). No manual setup needed.
    """

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        # Allow programmatic usage without manual shell exports.
        load_dotenv_if_present()
        self._apply_project_defaults()
        self._observer = None
        self._tracer = None
        self._runtime_context: dict[str, str] = {}
        self._init_db()
        self._harness = self._build_harness()
        self._attach_observability()

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

        # Harness config — propagate ALL fields from agent config
        h = self.config.harness if isinstance(self.config.harness, dict) else {}
        harness_cfg = HarnessConfig(
            max_turns=self.config.max_turns,
            timeout_seconds=self.config.timeout_seconds,
            enable_loop_detection=h.get("enable_loop_detection", True),
            enable_summarization=h.get("enable_summarization", True),
            enable_skills=h.get("enable_skills", True),
            enable_async_memory=h.get("enable_async_memory", False),
            enable_checkpoints=h.get("enable_checkpoints", False),
            require_human_approval=h.get("require_human_approval", False),
            max_context_tokens=h.get("max_context_tokens", 100_000),
            retry_on_tool_failure=h.get("retry_on_tool_failure", True),
            max_retries=h.get("max_retries", 3),
        )

        # LLM Router — configure per-tier models with mixed provider support
        llm_router = LLMRouter()
        anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
        openai_key = os.environ.get("OPENAI_API_KEY", "")
        cf_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        cf_account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        model = self.config.model

        # Load per-tier routing config from config/default.json
        # If agent specifies a plan, use plan-specific routing; else use default routing
        routing_config: dict[str, dict[str, Any]] = {}
        default_config_path = Path(__file__).resolve().parent.parent / "config" / "default.json"
        if default_config_path.exists():
            try:
                import json as _json
                raw = _json.loads(default_config_path.read_text())
                llm_config = raw.get("llm", {})
                # Check if agent has a plan and it exists in plans config
                agent_plan = getattr(self.config, "plan", "")
                plans = llm_config.get("plans", {})
                if agent_plan and agent_plan in plans:
                    plan_cfg = plans[agent_plan]
                    # Filter out metadata keys (start with _)
                    routing_config = {k: v for k, v in plan_cfg.items() if not k.startswith("_")}
                    logger.info("Using plan '%s' for LLM routing", agent_plan)
                else:
                    routing_config = llm_config.get("routing", {})
            except Exception:
                pass

        # Validate GMI models (uses module-level cache — one HTTP call per process)
        def _validate_gmi_model(model_id: str) -> bool:
            return _gmi_validate_cached(model_id)

        def _make_provider(tier_model: str, tier_provider: str) -> HttpProvider | None:
            """Create an LLM provider for a specific model and provider combo."""
            # Workers AI — edge inference, sub-second, no API key needed
            if tier_provider == "workers-ai" or (not tier_provider and tier_model.startswith("@cf/")):
                from agentos.llm.provider import WorkersAIProvider
                return WorkersAIProvider(model_id=tier_model)

            # OpenRouter — 400+ models, auto-fallback between providers
            if tier_provider == "openrouter":
                or_key = os.environ.get("OPENROUTER_API_KEY", "")
                if not or_key:
                    return None
                return HttpProvider(
                    model_id=tier_model,
                    api_base="https://openrouter.ai/api/v1",
                    api_key=or_key,
                )

            if tier_provider == "anthropic" or (not tier_provider and "claude" in tier_model):
                if not anthropic_key:
                    return None
                return HttpProvider(
                    model_id=tier_model,
                    api_base="https://api.anthropic.com",
                    api_key=anthropic_key,
                    headers={"anthropic-version": "2023-06-01"},
                )
            elif tier_provider == "openai" or (not tier_provider and "gpt" in tier_model):
                if not openai_key:
                    return None
                return HttpProvider(
                    model_id=tier_model,
                    api_base="https://api.openai.com",
                    api_key=openai_key,
                )
            elif tier_provider == "cloudflare" or (not tier_provider and "@cf/" in tier_model):
                if not cf_token or not cf_account:
                    return None
                return HttpProvider(
                    model_id=tier_model,
                    api_base=f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/ai",
                    api_key=cf_token,
                )
            elif tier_provider == "gmi":
                gmi_key = os.environ.get("GMI_API_KEY", "")
                gmi_base = os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
                if not gmi_key:
                    return None
                # Validate model exists on GMI
                if not _validate_gmi_model(tier_model):
                    logger.warning("Skipping GMI model '%s' — not available on your account", tier_model)
                    return None
                return HttpProvider(
                    model_id=tier_model,
                    api_base=gmi_base,
                    api_key=gmi_key,
                )
            elif tier_provider == "local":
                local_base = os.environ.get("LOCAL_LLM_BASE", "http://localhost:11434/v1")
                return HttpProvider(
                    model_id=tier_model,
                    api_base=local_base,
                    api_key=os.environ.get("LOCAL_LLM_KEY", "not-needed"),
                )
            return None

        # Multimodal tiers — no text-model fallback for these
        _multimodal_tiers = {Complexity.IMAGE_GEN, Complexity.TTS, Complexity.STT}

        def _register_role(category: str, role: str, role_cfg: dict) -> None:
            """Register a single category/role provider on the router."""
            role_model = role_cfg.get("model", model)
            role_provider_name = role_cfg.get("provider", "")
            role_max_tokens = role_cfg.get("max_tokens", self.config.max_tokens)

            prov = _make_provider(role_model, role_provider_name)
            # Fallback chain for text models
            if prov is None and role_provider_name not in ("gmi-requestqueue", "cloudflare"):
                gmi_key = os.environ.get("GMI_API_KEY", "")
                if gmi_key:
                    prov = _make_provider(role_model, "gmi")
                if prov is None and anthropic_key:
                    prov = _make_provider(model if "claude" in model else "anthropic/claude-sonnet-4.6", "anthropic")
                if prov is None and openai_key:
                    prov = _make_provider("openai/gpt-5.4-mini", "openai")

            if prov is not None:
                llm_router.register_category(category, role, prov, max_tokens=role_max_tokens)

        # Register category routes from plan config (new structure)
        # Plan config has: { general: {...}, coding: {...}, research: {...}, ... }
        for category, roles in routing_config.items():
            if category.startswith("_") or not isinstance(roles, dict):
                continue
            # Check if this is a category (nested dict) or a flat tier (has "model" key)
            first_val = next(iter(roles.values()), None)
            if isinstance(first_val, dict) and "model" in first_val:
                # Category with roles: { "planner": {"model": ...}, "implementer": {...} }
                for role, role_cfg in roles.items():
                    if isinstance(role_cfg, dict) and "model" in role_cfg:
                        _register_role(category, role, role_cfg)
            elif "model" in roles:
                # Flat tier (backward compat): { "model": "...", "provider": "..." }
                tier_name = category
                tier_cfg = roles
                tier_model = tier_cfg.get("model", model)
                tier_provider_name = tier_cfg.get("provider", "")
                tier_max_tokens = tier_cfg.get("max_tokens", self.config.max_tokens)

                prov = _make_provider(tier_model, tier_provider_name)
                if prov is None and tier_name not in ("image_gen", "tts", "stt"):
                    gmi_key = os.environ.get("GMI_API_KEY", "")
                    if prov is None and gmi_key:
                        prov = _make_provider(tier_model, "gmi")
                    if prov is None and anthropic_key:
                        prov = _make_provider(model if "claude" in model else "anthropic/claude-sonnet-4.6", "anthropic")
                    if prov is None and openai_key:
                        prov = _make_provider("openai/gpt-5.4-mini", "openai")

                # Map flat tier to Complexity enum for backward compat
                tier_map = {t.value: t for t in Complexity}
                if tier_name in tier_map and prov is not None:
                    llm_router.register(tier_map[tier_name], prov, max_tokens=tier_max_tokens)
                # Also register as general.{tier_name} for the new router
                if prov is not None:
                    llm_router.register_category("general", tier_name, prov, max_tokens=tier_max_tokens)

        # Governance
        gov_data = self.config.governance
        gov_policy = GovernancePolicy(
            budget_limit_usd=gov_data.get("budget_limit_usd", 10.0),
            blocked_tools=gov_data.get("blocked_tools", []),
            require_confirmation_for_destructive=gov_data.get(
                "require_confirmation_for_destructive", True
            ),
        )

        # Memory — pass DB for persistence when available
        mem_cfg = self.config.memory
        working = WorkingMemory(max_items=mem_cfg.get("working", {}).get("max_items", 100))
        episodic = EpisodicMemory(
            max_episodes=mem_cfg.get("episodic", {}).get("max_episodes", 10000),
            ttl_days=mem_cfg.get("episodic", {}).get("ttl_days", 90),
            db=self._db,
        )
        procedural = ProceduralMemory(
            max_procedures=mem_cfg.get("procedural", {}).get("max_procedures", 500),
            db=self._db,
        )
        # RAG — load pipeline from persisted chunks (fast) or re-index from source files (fallback)
        rag_pipeline = None
        rag_chunks_db = Path.cwd() / "data" / "rag_chunks.db"
        rag_index_path = Path.cwd() / "data" / "rag_index.json"
        try:
            from agentos.rag.pipeline import RAGPipeline

            # Try loading persisted chunks from SQLite first (fast path)
            if rag_chunks_db.exists():
                import json as _json
                chunk_size = 512
                if rag_index_path.exists():
                    rag_data = _json.loads(rag_index_path.read_text())
                    chunk_size = rag_data.get("chunk_size", 512)
                rag_pipeline = RAGPipeline.load_from_db(rag_chunks_db, chunk_size=chunk_size)

            # Fallback: re-index from source files listed in rag_index.json
            if rag_pipeline is None and rag_index_path.exists():
                import json as _json
                rag_data = _json.loads(rag_index_path.read_text())
                source_files = rag_data.get("source_files", [])
                if source_files:
                    rag_pipeline = RAGPipeline(
                        chunk_size=rag_data.get("chunk_size", 512),
                    )
                    docs = []
                    metas = []
                    for src in source_files:
                        p = Path(src)
                        if p.exists():
                            try:
                                text = p.read_text(errors="replace")
                                if text.strip():
                                    docs.append(text)
                                    metas.append({"source": src, "filename": p.name})
                            except Exception:
                                pass
                    if docs:
                        rag_pipeline.ingest(docs, metas)
                    else:
                        rag_pipeline = None
        except Exception as exc:
            logger.warning("Could not load RAG index: %s", exc)

        memory_manager = MemoryManager(
            working=working, episodic=episodic, procedural=procedural,
            rag=rag_pipeline,
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

    def _attach_observability(self) -> None:
        """Auto-attach observer, tracer, and DB if data/ dir exists.

        This makes every ``run()`` call automatically observed and
        persisted — no manual setup in CLI commands needed.
        """
        from agentos.core.tracing import Tracer
        from agentos.evolution.observer import Observer

        self._tracer = Tracer()

        # Attach observer to the harness event bus
        self._observer = Observer(
            event_bus=self._harness.event_bus,
            db=self._db,
        )
        cfg_with_scope = {
            **self.config.to_dict(),
            "_org_id": self._runtime_context.get("org_id", ""),
            "_project_id": self._runtime_context.get("project_id", ""),
            "_user_id": self._runtime_context.get("user_id", ""),
        }
        self._observer.attach(
            agent_name=self.config.name,
            agent_config=cfg_with_scope,
        )

        # Auto-score sessions for conversation intelligence
        self._attach_conversation_scoring()

        # Run compliance check against gold images (non-blocking)
        self._check_compliance_on_start()

    def _attach_conversation_scoring(self) -> None:
        """Auto-score sessions on SESSION_END for conversation intelligence."""
        from agentos.core.events import EventType, Event

        async def _on_session_end(event: Event) -> None:
            try:
                if not self._db or not self._observer:
                    return
                records = self._observer.records
                if not records:
                    return
                last_record = records[-1]
                session_id = getattr(last_record, "session_id", "")
                if not session_id:
                    return

                # Load turns from DB
                turns = self._db.get_turns(session_id)
                if not turns:
                    return

                import os
                from agentos.observability.analytics import ConversationAnalytics
                use_llm = bool(os.environ.get("ANTHROPIC_API_KEY", ""))
                analytics = ConversationAnalytics(use_llm=use_llm)
                result = analytics.score_session(
                    session_id=session_id,
                    turns=turns,
                    input_text=getattr(last_record, "input_text", ""),
                    agent_name=self.config.name,
                    db=self._db,
                )

                # Emit scored event
                await self._harness.event_bus.emit(Event(
                    type=EventType.CONVERSATION_SCORED,
                    data={
                        "session_id": session_id,
                        "avg_quality": result.get("avg_quality", 0),
                        "avg_sentiment": result.get("avg_sentiment_score", 0),
                        "dominant_sentiment": result.get("dominant_sentiment", "neutral"),
                        "topics": result.get("topics", []),
                    },
                    source="conversation_intelligence",
                ))

                # Auto-detect issues from scored session
                try:
                    session_data = last_record.to_dict() if hasattr(last_record, "to_dict") else {}
                    scores = self._db.query_conversation_scores(session_id=session_id)
                    from agentos.issues.detector import IssueDetector
                    from agentos.issues.remediation import RemediationEngine
                    detector = IssueDetector(db=self._db)
                    issues = detector.detect_from_session(
                        session_id=session_id,
                        agent_name=self.config.name,
                        org_id=self._runtime_context.get("org_id", ""),
                        session_data=session_data,
                        scores=scores,
                    )
                    if issues:
                        engine = RemediationEngine()
                        for issue in issues:
                            fix = engine.suggest_fix(issue)
                            self._db.update_issue(issue["issue_id"], suggested_fix=fix)
                        await self._harness.event_bus.emit(Event(
                            type=EventType.ISSUE_CREATED,
                            data={"session_id": session_id, "count": len(issues)},
                            source="issue_detector",
                        ))
                except Exception as exc:
                    logger.debug("Issue detection failed for session %s: %s", session_id, exc)

            except Exception:
                pass  # Don't let scoring failures break the session

        self._harness.event_bus.on(EventType.SESSION_END, _on_session_end)

    def _check_compliance_on_start(self) -> None:
        """Non-blocking compliance check at agent startup. Logs warnings for drift."""
        if not self._db:
            return
        try:
            from agentos.config.compliance import ComplianceChecker
            checker = ComplianceChecker(self._db)
            report = checker.check_agent(
                agent_name=self.config.name,
                agent_config=self.config.to_dict(),
            )
            # Only warn for agents that have a matching gold image
            # Skip silently for: no_gold_images, no_matching_gold_image
            if report.status == "critical":
                logger.warning(
                    "Compliance drift: Agent '%s' has %d critical drifts from gold image '%s'",
                    self.config.name, report.total_drifts, report.image_name,
                )
            elif report.status == "drifted":
                logger.debug(
                    "Compliance drift: Agent '%s' has %d config drifts from gold image '%s'",
                    self.config.name, report.total_drifts, report.image_name,
                )
            # no_gold_images, no_matching_gold_image, compliant — all silent
        except Exception:
            pass  # Compliance check is best-effort

    def set_runtime_context(self, *, org_id: str = "", project_id: str = "", user_id: str = "") -> None:
        """Set per-request tenancy context used for observability persistence."""
        self._runtime_context = {
            "org_id": org_id or "",
            "project_id": project_id or "",
            "user_id": user_id or "",
        }
        # Update observer config in-place for the current request lifecycle.
        if self._observer is not None:
            cfg_with_scope = {
                **self.config.to_dict(),
                "_org_id": self._runtime_context.get("org_id", ""),
                "_project_id": self._runtime_context.get("project_id", ""),
                "_user_id": self._runtime_context.get("user_id", ""),
            }
            self._observer.attach(agent_name=self.config.name, agent_config=cfg_with_scope)

    @property
    def db(self):
        """The agent's SQLite database (None if no data/ dir)."""
        return self._db

    @property
    def tracer(self):
        """The agent's span tracer."""
        return self._tracer

    @property
    def observer(self):
        """The agent's session observer."""
        return self._observer

    @property
    def uses_stub_provider(self) -> bool:
        """True if any LLM route uses the stub provider (no API key)."""
        from agentos.llm.provider import StubProvider
        return any(
            isinstance(route.provider, StubProvider)
            for route in self._harness.llm_router._routes.values()
        )

    def apply_overrides(
        self,
        *,
        turns: int | None = None,
        timeout: float | None = None,
        budget: float | None = None,
        model: str | None = None,
    ) -> None:
        """Apply runtime overrides and rebuild the harness.

        This is the safe way to change agent settings at runtime —
        modifies the config and rebuilds the harness so all subsystems
        pick up the changes (governance budget, LLM router, etc.).
        """
        changed = False
        if turns is not None:
            self.config.max_turns = turns
            changed = True
        if timeout is not None:
            self.config.timeout_seconds = timeout
            changed = True
        if budget is not None:
            self.config.governance["budget_limit_usd"] = budget
            changed = True
        if model is not None:
            self.config.model = model
            changed = True
        if changed:
            self._harness = self._build_harness()
            self._attach_observability()

    async def run(self, user_input: str) -> list:
        """Execute the agent on a user task.

        Every run is automatically:
        - Traced (span-based tracing with parent-child hierarchy)
        - Observed (SessionRecord built from EventBus events)
        - Persisted (to SQLite if data/ dir exists)
        """
        from agentos.graph.adapter import run_with_graph_runtime
        results = await run_with_graph_runtime(self._harness, user_input)

        # Persist spans to DB if available (classic tracer + graph node spans).
        if self._db:
            try:
                session_id = ""
                if self._observer and self._observer.records:
                    session_id = self._observer.records[-1].session_id
                if self._tracer and self._tracer.span_count > 0:
                    self._db.insert_spans(self._tracer.export(), session_id=session_id)
                    self._tracer.clear()
                graph_node_spans = getattr(self._harness, "_graph_node_spans", [])
                if graph_node_spans:
                    self._db.insert_spans(graph_node_spans, session_id=session_id)
                    self._harness._graph_node_spans = []
            except Exception as exc:
                logger.warning("Failed to persist spans: %s", exc)

        return results

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
