"""Shared Pydantic models for API request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field
from typing import Any


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
    email: str
    password: str


class SignupRequest(BaseModel):
    email: str
    password: str
    name: str = ""


class TokenResponse(BaseModel):
    token: str
    user_id: str
    email: str
    org_id: str = ""


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
    role: str = "member"


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

class AgentRunRequest(BaseModel):
    task: str = Field(..., description="Task to execute")
    plan: str = Field("", description="LLM plan override")
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
    max_turns: int = 50
    budget_limit_usd: float = 10.0
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
    started_at: float = 0
    ended_at: float = 0


# ── Webhooks ────────────────────────────────────────────────────────────

class CreateWebhookRequest(BaseModel):
    url: str
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
    cron: str
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
    eval_file: str
    trials: int = 3


class EvalRunResponse(BaseModel):
    run_id: int
    agent_name: str
    pass_rate: float
    avg_score: float
    avg_latency_ms: float
    total_cost_usd: float
    total_tasks: int
    total_trials: int
