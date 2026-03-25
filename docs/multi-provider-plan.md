# AgentOS Multi-Provider LLM + GPU Infrastructure Plan

## Goal
Replace single-provider dependency (GMI Cloud) with a tiered multi-provider
architecture using CF AI Gateway, Workers AI, OpenRouter, and enterprise GPU
providers. Eliminate rate limiting, reduce latency, and give enterprise
customers the ability to bring their own compute.

## Current State (Problems)
- Single provider: GMI Cloud for all LLM + multimodal
- GPT-5.x rate-limited (429), Sonnet intermittently down (500)
- 3-5s latency for simple chat (network hop to GMI)
- Multimodal on separate API endpoint (requestqueue)
- No provider fallback — if GMI is down, everything stops
- No way for enterprise customers to use their own models/GPUs

## Target Architecture

```
Agent Request
    │
    ▼
CF AI Gateway (free — caching, rate limits, analytics, unified logging)
    │
    ├──► Tier 1: Workers AI (edge, <1s, free/cheap)
    │      For: embeddings, simple chat, classification, guard, ASR, TTS, images
    │      Models: GPT-OSS 120B, Kimi K2.5, Llama 4 Scout, Nemotron 3,
    │              Whisper, FLUX 2, Deepgram Aura, BGE embeddings
    │
    ├──► Tier 2: OpenRouter (400+ models, auto-fallback)
    │      For: complex reasoning, coding, tool use, premium quality
    │      Models: Claude Opus/Sonnet, GPT-5.x, Gemini Pro, DeepSeek
    │      Fallback: if Claude down → auto-route to GPT → Gemini
    │
    ├──► Tier 3: Together AI (cheapest open-source inference)
    │      For: high-volume, cost-sensitive, fine-tuned models
    │      Models: Llama 70B at $0.27/M, batch API at 50% off
    │
    └──► Tier 4: Customer GPU (enterprise BYOC)
           For: private models, compliance, data sovereignty
           Providers: RunPod, Modal, CoreWeave, NVIDIA NIM, Lambda
           Customer provides endpoint URL + API key
```

## Implementation Phases

### Phase 1: AI Gateway + Workers AI (2 days)

**Goal**: Sub-second responses for simple tasks, free tier for embeddings/ASR.

1. Create AI Gateway in CF dashboard
   - Name: `agentos-gateway`
   - Enable: caching (semantic), rate limiting, analytics

2. Update worker to use Workers AI for fast-path models:
   - `@cf/openai/gpt-oss-120b` → general.simple (replaces DeepSeek for simple)
   - `@cf/meta/llama-3.3-70b-instruct-fp8-fast` → coding.implementer
   - `@cf/moonshot/kimi-k2.5` → complex tasks with 256K context
   - `@cf/baai/bge-base-en-v1.5` → embeddings (already done)
   - `@cf/openai/whisper` → STT (already done)
   - `@cf/deepgram/aura-2-en` → TTS (replaces ElevenLabs for basic)
   - `@cf/bfl/flux-2-klein-4b` → image gen (replaces Seedream for fast)

3. Update `HttpProvider` to detect `@cf/` models and use `env.AI.run()` instead of HTTP

4. Test: simple chat via Workers AI should be <1 second

**Files to modify:**
- `deploy/src/index.ts` — add Workers AI model calls in `/cf/tool/exec`
- `agentos/llm/provider.py` — add `WorkersAIProvider` class
- `config/default.json` — update plan tiers with Workers AI models

### Phase 2: OpenRouter Integration (2 days)

**Goal**: 400+ models with automatic fallback, replace GMI for premium models.

1. Sign up for OpenRouter, get API key
2. Add OpenRouter as provider in `HttpProvider`:
   ```python
   # OpenRouter is OpenAI-compatible — just change base_url
   provider = HttpProvider(
       model_id="anthropic/claude-sonnet-4.6",
       api_base="https://openrouter.ai/api/v1",
       api_key=OPENROUTER_API_KEY,
   )
   ```

3. Configure AI Gateway custom provider for OpenRouter:
   ```
   Gateway URL: gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-openrouter/
   ```
   This gives us: caching, rate limiting, analytics on all OpenRouter calls

4. Update `_make_provider()` in `agent.py`:
   - Provider priority: `workers-ai` → `openrouter` → `gmi` → `direct`
   - If model starts with `@cf/` → Workers AI
   - If `OPENROUTER_API_KEY` set → OpenRouter (via AI Gateway)
   - If `GMI_API_KEY` set → GMI (fallback)
   - If `ANTHROPIC_API_KEY` set → direct Anthropic

5. Add model fallback in OpenRouter requests:
   ```json
   {
     "model": "anthropic/claude-sonnet-4.6",
     "models": ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-pro"],
     "route": "fallback"
   }
   ```

**Files to modify:**
- `agentos/llm/provider.py` — add OpenRouter support + fallback models
- `agentos/agent.py` — update `_make_provider()` priority chain
- `config/default.json` — add `openrouter` provider to plans
- `deploy/wrangler.jsonc` — add AI Gateway config

### Phase 3: Together AI for Cost Optimization (1 day)

**Goal**: Cheapest open-source inference for high-volume/batch workloads.

1. Add Together AI as provider:
   ```python
   provider = HttpProvider(
       model_id="meta-llama/Llama-3.3-70B-Instruct-Turbo",
       api_base="https://api.together.xyz/v1",
       api_key=TOGETHER_API_KEY,
   )
   ```

2. Use for:
   - `basic` plan (all tiers) — cheapest models
   - Batch eval runs — 50% discount via batch API
   - Fine-tuned model hosting

3. Add to AI Gateway as custom provider

**Files to modify:**
- `agentos/llm/provider.py` — Together AI is OpenAI-compatible, minimal change
- `config/default.json` — `basic` plan uses Together AI models

### Phase 4: Enterprise GPU Integration (3 days)

**Goal**: Enterprise customers bring their own GPU infrastructure.

1. Add `custom_endpoint` field to org settings:
   ```json
   {
     "org_id": "acme",
     "gpu_provider": "runpod",
     "gpu_endpoint": "https://api.runpod.ai/v2/abc123/run",
     "gpu_api_key": "encrypted:...",
     "gpu_models": ["llama-70b-finetuned-acme"]
   }
   ```

2. Add `CustomEndpointProvider` in provider.py:
   - Takes any OpenAI-compatible endpoint URL + API key
   - Routes to customer's RunPod/Modal/CoreWeave/NIM deployment
   - Supports health checks and failover to OpenRouter

3. Add GPU provisioning API:
   - `POST /api/v1/gpu/provision` — spin up RunPod/Modal instance
   - `GET /api/v1/gpu/status` — check instance health
   - `DELETE /api/v1/gpu/terminate` — shut down instance
   - Integrates with RunPod API, Modal API, Lambda API

4. Add `enterprise` plan that uses customer GPU:
   ```json
   {
     "enterprise": {
       "general": {
         "simple": {"model": "@cf/openai/gpt-oss-120b", "provider": "workers-ai"},
         "complex": {"model": "llama-70b-finetuned", "provider": "custom-gpu"}
       }
     }
   }
   ```

5. NVIDIA NIM support for on-prem:
   - Customer deploys NIM container on their infrastructure
   - Provides endpoint URL to AgentOS
   - AgentOS routes via `CustomEndpointProvider`
   - Full data sovereignty — no data leaves customer's network

**Files to modify:**
- `agentos/llm/provider.py` — add `CustomEndpointProvider`
- `agentos/api/routers/gpu.py` — real GPU provisioning endpoints
- `agentos/core/database.py` — org settings for GPU config
- `config/default.json` — enterprise plan

### Phase 5: Unified Plan Config (1 day)

**Goal**: Clean config structure that supports all providers.

```json
{
  "plans": {
    "basic": {
      "general": {
        "simple":    {"model": "@cf/openai/gpt-oss-120b",       "provider": "workers-ai"},
        "moderate":  {"model": "meta-llama/Llama-3.3-70B",      "provider": "together"},
        "complex":   {"model": "deepseek-ai/DeepSeek-V3.2",     "provider": "openrouter"},
        "tool_call": {"model": "@cf/openai/gpt-oss-120b",       "provider": "workers-ai"}
      }
    },
    "standard": {
      "general": {
        "simple":    {"model": "@cf/openai/gpt-oss-120b",       "provider": "workers-ai"},
        "moderate":  {"model": "deepseek-ai/DeepSeek-V3.2",     "provider": "openrouter"},
        "complex":   {"model": "anthropic/claude-sonnet-4.6",    "provider": "openrouter"},
        "tool_call": {"model": "anthropic/claude-haiku-4.5",     "provider": "openrouter"}
      },
      "coding": {
        "implementer": {"model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "provider": "workers-ai"},
        "reviewer":    {"model": "anthropic/claude-sonnet-4.6",  "provider": "openrouter"}
      }
    },
    "premium": {
      "general": {
        "simple":    {"model": "anthropic/claude-haiku-4.5",     "provider": "openrouter"},
        "complex":   {"model": "anthropic/claude-opus-4.6",      "provider": "openrouter"}
      }
    },
    "enterprise": {
      "general": {
        "simple":    {"model": "@cf/openai/gpt-oss-120b",       "provider": "workers-ai"},
        "complex":   {"model": "custom-finetuned",               "provider": "custom-gpu"}
      }
    }
  },
  "provider_config": {
    "workers-ai": {"type": "cloudflare", "binding": "AI"},
    "openrouter": {"type": "openai-compat", "base_url": "https://openrouter.ai/api/v1", "env_key": "OPENROUTER_API_KEY"},
    "together":   {"type": "openai-compat", "base_url": "https://api.together.xyz/v1", "env_key": "TOGETHER_API_KEY"},
    "gmi":        {"type": "openai-compat", "base_url": "https://api.gmi-serving.com/v1", "env_key": "GMI_API_KEY"},
    "custom-gpu": {"type": "openai-compat", "base_url": "org.gpu_endpoint", "env_key": "org.gpu_api_key"}
  },
  "fallback_chain": ["workers-ai", "openrouter", "together", "gmi"]
}
```

## Timeline

| Phase | What | Days | Depends On |
|-------|------|------|-----------|
| 1 | AI Gateway + Workers AI | 2 | Nothing (start immediately) |
| 2 | OpenRouter | 2 | Phase 1 (gateway setup) |
| 3 | Together AI | 1 | Phase 2 (provider pattern) |
| 4 | Enterprise GPU | 3 | Phase 2 |
| 5 | Unified Config | 1 | Phase 4 |
| **Total** | | **9 days** | |

## Success Criteria

- Simple chat < 1 second (Workers AI edge)
- Complex reasoning < 3 seconds (OpenRouter → Claude/GPT)
- Zero downtime when any single provider goes down (fallback chain)
- Enterprise customers can plug in RunPod/Modal/NIM endpoint
- All requests logged in AI Gateway with unified analytics
- Cost reduction: 50-80% for basic plan (Workers AI free tier)
