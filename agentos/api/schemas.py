"""Shared Pydantic models for API request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator
from typing import Any
from typing import Literal
from pydantic import HttpUrl


# ── Pagination ──────────────────────────────────────────────────────────

class PaginationParams(BaseModel):
    offset: int = Field(0, ge=0, description="Number of items to skip")
    limit: int = Field(50, ge=1, le=200, description="Max items to return")


class PaginatedResponse(BaseModel):
    data: list[Any]
    total: int
    offset: int
    limit: int


# ── Auth ────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class SignupRequest(BaseModel):
    email: str = Field(..., min_length=1)
    password: str = Field(..., min_length=8, max_length=128)
    name: str = ""


class TokenResponse(BaseModel):
    token: str
    user_id: str
    email: str
    org_id: str = ""
    provider: str = "local"


class UserResponse(BaseModel):
    user_id: str
    email: str
    name: str
    org_id: str = ""
    role: str = "member"


# ── Orgs ────────────────────────────────────────────────────────────────

class CreateOrgRequest(BaseModel):
    name: str
    slug: str = ""


class OrgResponse(BaseModel):
    org_id: str
    name: str
    slug: str
    plan: str = "free"
    member_count: int = 0


class InviteMemberRequest(BaseModel):
    email: str
    role: Literal["owner", "admin", "member", "viewer"] = "member"


# ── API Keys ────────────────────────────────────────────────────────────

class CreateApiKeyRequest(BaseModel):
    name: str = "default"
    scopes: list[str] = ["*"]
    project_id: str = ""  # Scope to specific project (empty = org-wide)
    env: str = ""  # Scope to specific environment (empty = all envs)
    expires_in_days: int | None = None


class ApiKeyResponse(BaseModel):
    key_id: str
    name: str
    key_prefix: str
    scopes: list[str]
    project_id: str = ""
    env: str = ""
    created_at: float
    last_used_at: float | None = None
    is_active: bool = True


class ApiKeyCreatedResponse(ApiKeyResponse):
    key: str  # Full key — only shown once at creation


# ── Agents ──────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: str = ""


class AgentRunRequest(BaseModel):
    task: str = Field(..., description="Task to execute", max_length=50000)
    plan: str = Field("", description="LLM plan override")
    runtime_mode: Literal["harness", "graph"] = Field(
        "harness",
        description="Runtime mode override for this request",
    )
    stream: bool = Field(False, description="Stream response via SSE")
    model: str = Field("", description="Model override for this run")
    budget_usd: float = Field(0, description="Budget limit override (0 = use default)")
    max_turns: int = Field(0, description="Max turns override (0 = use default)")
    timeout_seconds: float = Field(0, description="Timeout override (0 = use default)")
    verbose: bool = Field(False, description="Include detailed turn data in response")


class AgentCreateRequest(BaseModel):
    name: str
    description: str = ""
    system_prompt: str = "You are a helpful AI assistant."
    model: str = ""
    tools: list[str] = []
    max_turns: int = Field(50, le=1000)
    budget_limit_usd: float = Field(10.0, le=10000)
    tags: list[str] = []


class AgentResponse(BaseModel):
    name: str
    description: str
    model: str
    tools: list[str | dict[str, Any]]
    tags: list[str]
    version: str = "0.1.0"


class RunResponse(BaseModel):
    success: bool
    output: str
    turns: int
    tool_calls: int
    cost_usd: float
    latency_ms: float
    session_id: str = ""
    trace_id: str = ""


# ── Sessions ────────────────────────────────────────────────────────────

class SessionResponse(BaseModel):
    session_id: str
    agent_name: str
    status: str
    input_text: str
    output_text: str
    step_count: int
    cost_total_usd: float
    wall_clock_seconds: float
    trace_id: str = ""
    created_at: float


class TurnResponse(BaseModel):
    turn_number: int
    model_used: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
    content: str
    cost_total_usd: float
    tool_calls: list[dict[str, Any]] = []
    execution_mode: str = "sequential"
    plan_artifact: dict[str, Any] = {}
    reflection: dict[str, Any] = {}
    started_at: float = 0
    ended_at: float = 0


# ── Webhooks ────────────────────────────────────────────────────────────

class CreateWebhookRequest(BaseModel):
    url: HttpUrl
    events: list[str] = ["*"]


class WebhookResponse(BaseModel):
    webhook_id: str
    url: str
    events: list[str]
    is_active: bool = True
    failure_count: int = 0
    last_triggered_at: float | None = None


# ── Schedules ───────────────────────────────────────────────────────────

class CreateScheduleRequest(BaseModel):
    agent_name: str
    cron: str = Field(..., min_length=9)  # shortest valid cron e.g. "* * * * *"
    task: str


class ScheduleResponse(BaseModel):
    schedule_id: str
    agent_name: str
    cron: str
    task: str
    is_enabled: bool = True
    run_count: int = 0
    last_run_at: float | None = None


# ── Billing ─────────────────────────────────────────────────────────────

class UsageResponse(BaseModel):
    total_cost_usd: float
    inference_cost_usd: float
    gpu_compute_cost_usd: float
    connector_cost_usd: float = 0.0
    total_input_tokens: int
    total_output_tokens: int
    total_billing_records: int = 0
    total_gpu_hours: float = 0.0
    by_cost_type: dict[str, float] = {}
    by_model: dict[str, float] = {}
    by_agent: dict[str, float] = {}


# ── Eval ────────────────────────────────────────────────────────────────

class RunEvalRequest(BaseModel):
    agent_name: str
    eval_file: str = Field(..., description="Eval file path (no path traversal allowed)")
    trials: int = 3

    @field_validator("eval_file")
    @classmethod
    def _no_path_traversal(cls, v: str) -> str:
        if ".." in v:
            raise ValueError("eval_file must not contain '..' (path traversal)")
        return v


class EvalRunResponse(BaseModel):
    run_id: int
    agent_name: str
    pass_rate: float
    avg_score: float
    avg_latency_ms: float
    total_cost_usd: float
    total_tasks: int
    total_trials: int


# ── Skills ─────────────────────────────────────────────────────────────

class SkillResponse(BaseModel):
    name: str
    description: str = ""
    version: str = "1.0.0"
    license: str = ""
    allowed_tools: list[str] = []
    tags: list[str] = []
    enabled: bool = True
    category: str = ""
    content_length: int = 0


class SkillUpdateRequest(BaseModel):
    enabled: bool


# ── Middleware ──────────────────────────────────────────────────────────

class MiddlewareStatusResponse(BaseModel):
    name: str
    order: int
    type: str
    stats: dict[str, Any] = {}


# ── Memory (Async) ─────────────────────────────────────────────────────

class MemoryFactResponse(BaseModel):
    id: str
    content: str
    category: str
    confidence: float
    source: str = ""
    created_at: float = 0.0


class UserMemoryResponse(BaseModel):
    work_context: str = ""
    personal_context: str = ""
    top_of_mind: str = ""
    facts: list[MemoryFactResponse] = []
    last_updated: float = 0.0


class AsyncMemoryStatsResponse(BaseModel):
    queue_size: int = 0
    total_facts: int = 0
    total_updates_queued: int = 0
    total_updates_processed: int = 0
    total_facts_extracted: int = 0
    total_facts_deduplicated: int = 0
    running: bool = False


# ── Sandbox Virtual Paths ──────────────────────────────────────────────

class PathMappingResponse(BaseModel):
    session_id: str
    workspace: str
    uploads: str
    outputs: str
    skills: str
    virtual_prefix: str = "/mnt/user-data"


# ── Conversation Intelligence ─────────────────────────────────────

class ConversationScoreResponse(BaseModel):
    id: int = 0
    session_id: str = ""
    turn_number: int = 0
    org_id: str = ""
    agent_name: str = ""
    sentiment: str = "neutral"
    sentiment_score: float = 0.0
    sentiment_confidence: float = 0.0
    relevance_score: float = 0.0
    coherence_score: float = 0.0
    helpfulness_score: float = 0.0
    safety_score: float = 1.0
    quality_overall: float = 0.0
    topic: str = ""
    intent: str = ""
    has_tool_failure: int = 0
    has_hallucination_risk: int = 0
    scorer_model: str = ""
    created_at: float = 0.0


class ConversationAnalyticsResponse(BaseModel):
    id: int = 0
    session_id: str = ""
    org_id: str = ""
    agent_name: str = ""
    avg_sentiment_score: float = 0.0
    dominant_sentiment: str = "neutral"
    sentiment_trend: str = "stable"
    avg_quality: float = 0.0
    min_quality: float = 0.0
    max_quality: float = 0.0
    topics_json: list[str] = []
    intents_json: list[str] = []
    failure_patterns_json: list[str] = []
    total_turns: int = 0
    tool_failure_count: int = 0
    hallucination_risk_count: int = 0
    task_completed: int = 0
    created_at: float = 0.0


class ConversationIntelSummaryResponse(BaseModel):
    total_scored_turns: int = 0
    avg_sentiment_score: float = 0.0
    avg_quality_score: float = 0.0
    avg_relevance: float = 0.0
    avg_coherence: float = 0.0
    avg_helpfulness: float = 0.0
    avg_safety: float = 0.0
    tool_failure_count: int = 0
    hallucination_risk_count: int = 0
    sentiment_breakdown: dict[str, int] = {}
    top_topics: list[dict[str, Any]] = []
    quality_trend: list[dict[str, Any]] = []
