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
        "enable_loop_detection": True,
        "enable_summarization": True,
        "enable_skills": True,
        "enable_async_memory": False,
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


def save_agent_config(config: AgentConfig, path: str | Path | None = None) -> Path:
    """Save an agent definition to a YAML or JSON file."""
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
    """Discover all agent definitions in a directory."""
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

        # Validate GMI models at startup (cached per process)
        _gmi_available_models: set[str] | None = None
        def _validate_gmi_model(model_id: str) -> bool:
            nonlocal _gmi_available_models
            gmi_key = os.environ.get("GMI_API_KEY", "")
            if not gmi_key:
                return False
            if _gmi_available_models is None:
                try:
                    import httpx
                    resp = httpx.get(
                        "https://api.gmi-serving.com/v1/models",
                        headers={"Authorization": f"Bearer {gmi_key}"},
                        timeout=10,
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        _gmi_available_models = {m["id"] for m in data.get("data", [])}
                        logger.info("GMI: %d models available", len(_gmi_available_models))
                    else:
                        _gmi_available_models = set()
                        logger.warning("GMI model validation failed: %s", resp.status_code)
                except Exception as exc:
                    _gmi_available_models = set()
                    logger.warning("GMI model validation failed: %s", exc)
            if model_id in _gmi_available_models:
                return True
            logger.warning("GMI: model '%s' not found in available models", model_id)
            return False

        def _make_provider(tier_model: str, tier_provider: str) -> HttpProvider | None:
            """Create an LLM provider for a specific model and provider combo."""
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

        # Register providers per complexity tier — supports mixed providers
        for tier in Complexity:
            tier_cfg = routing_config.get(tier.value, {})
            tier_model = tier_cfg.get("model", model)
            tier_provider_name = tier_cfg.get("provider", "")
            tier_max_tokens = tier_cfg.get("max_tokens", self.config.max_tokens)

            provider = _make_provider(tier_model, tier_provider_name)

            # Fallback: if configured provider unavailable, try in order:
            # 1. GMI (if key exists — works with any model)
            # 2. Anthropic (with Claude model)
            # 3. OpenAI (with GPT model)
            gmi_key = os.environ.get("GMI_API_KEY", "")
            if provider is None and gmi_key:
                # Use the agent's own model for GMI fallback (it's likely a valid GMI model ID)
                gmi_model = model if tier_provider_name != "gmi" else tier_model
                provider = _make_provider(gmi_model, "gmi")
            if provider is None and anthropic_key:
                fallback_model = model if "claude" in model else "claude-sonnet-4-6-20250627"
                provider = _make_provider(fallback_model, "anthropic")
            if provider is None and openai_key:
                provider = _make_provider("gpt-5.4-mini", "openai")

            if provider is not None:
                llm_router.register(tier, provider, max_tokens=tier_max_tokens)

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

                from agentos.observability.analytics import ConversationAnalytics
                analytics = ConversationAnalytics()
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
            if report.status == "critical":
                logger.warning(
                    "COMPLIANCE CRITICAL: Agent '%s' has critical config drift from gold image '%s' (%d drifts)",
                    self.config.name, report.image_name, report.total_drifts,
                )
            elif report.status == "drifted":
                logger.info(
                    "Compliance drift: Agent '%s' has %d config drifts from gold image '%s'",
                    self.config.name, report.total_drifts, report.image_name,
                )
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
        from agentos.core.tracing import Tracer

        results = await self._harness.run(user_input)

        # Persist spans to DB if available
        if self._db and self._tracer and self._tracer.span_count > 0:
            try:
                session_id = ""
                if self._observer and self._observer.records:
                    session_id = self._observer.records[-1].session_id
                self._db.insert_spans(self._tracer.export(), session_id=session_id)
                self._tracer.clear()
            except Exception as exc:
                logger.warning("Failed to persist spans: %s", exc)

        return results

    @classmethod
    def from_file(cls, path: str | Path) -> Agent:
        """Load an agent from a YAML/JSON definition file."""
        return cls(load_agent_config(path))

    @classmethod
    def from_name(cls, name: str, directory: str | Path | None = None) -> Agent:
        """Load a named agent from the agents directory."""
        directory = Path(directory) if directory else _resolve_agents_dir()
        for ext in (".yaml", ".yml", ".json"):
            p = directory / f"{name}{ext}"
            if p.exists():
                return cls.from_file(p)
        raise FileNotFoundError(f"No agent definition found for '{name}' in {directory}")
