# AgentOS Architecture Review

**Date:** 2026-03-22
**Overall Grade:** A- — Solid foundation, minor gaps in peripheral features, excellent test coverage.

---

## Overview

AgentOS is a well-architected Python framework for building, running, and deploying autonomous AI agents. It follows a modular "harness" architecture that cleanly separates concerns.

---

## ✅ What's Done Well

### 1. Clean Architecture

- **Modular subsystem design:** Agent, Builder, CLI, Core Harness, LLM Routing, Tools (MCP-based), Memory (4-tier), RAG, Voice, Eval Gym
- **Clear separation:** The `AgentHarness` orchestrates while `GovernanceLayer` handles safety
- **Event-driven:** Uses `EventBus` for loose coupling between components

### 2. Good Abstractions

- `AgentConfig` as the declarative definition (JSON/YAML)
- `Agent` class as the runtime instance
- `LLMProvider` protocol allows easy swapping (Stub, Http/Anthropic, Http/OpenAI)
- MCP (Model Context Protocol) for tool integration

### 3. Comprehensive Testing (375 tests, all passing)

- Unit tests for each module
- Integration tests for full workflows
- Critical path tests (budget exhaustion, max turns, tool failures)
- Bug fix regression tests

### 4. Production-Ready Features

- **Governance:** Budget tracking, tool blocking, destructive action confirmation
- **Observability:** SQLite persistence, session tracking, span tracing
- **Evaluation:** EvalGym with pass@k metrics, parallel execution, perturbation testing
- **Evolution:** Self-improvement loop with human-in-the-loop review
- **Auth:** JWT-based with OAuth (GitHub/Google) device flow
- **Sandbox:** E2B integration with local fallback (securely disabled in API mode)

### 5. Developer Experience

- CLI with many commands: `init`, `create`, `run`, `chat`, `eval`, `evolve`, `ingest`, `serve`, `deploy`
- `--one-shot` flag for quick agent creation
- JSON output mode for scripting
- FastAPI server with auto-generated endpoints

---

## ⚠️ Areas for Improvement

### 1. Known Bugs (from WORKFLOW_ANALYSIS.md)

| Bug | Severity | Status |
|-----|----------|--------|
| `eval_agent` builtin handler processes `TurnResult` incorrectly | HIGH | ✅ Fixed (test confirms) |
| RAG data not persistent across runs | HIGH | ✅ Partially fixed (loading works, but see below) |
| Dashboard directory doesn't exist | LOW | Still present |
| Cost tracking across turns is misleading | MEDIUM | Known limitation |
| Complexity enum mismatch | LOW | Config misalignment |
| Sandbox instantiation at import time | MEDIUM | In `api/app.py` |
| Evolution observer doubly attached | LOW | Wasteful but harmless |

### 2. RAG Implementation Gap

The RAG pipeline ingests documents but stores only metadata to disk. The actual indexed chunks/embeddings are in-memory and lost on process exit. The `_build_harness` method now re-indexes from source files on agent startup, which is a workaround but not efficient for large document sets.

### 3. Dashboard Not Implemented

The `/dashboard` endpoint in the API returns an error message. No actual dashboard SPA exists.

### 4. LLM Router Complexity Mismatch

- `router.py` defines: `SIMPLE`, `MODERATE`, `COMPLEX`
- `config/default.json` uses: `simple`, `moderate`, `complex`, `frontier`
- The config's routing section isn't actually parsed — all tiers get the same provider

### 5. Python 3.14 Deprecation Warnings

Tests use `asyncio.iscoroutinefunction()` which is deprecated in Python 3.14 (slated for removal in 3.16). Should use `inspect.iscoroutinefunction()`.

### 6. Documentation Gaps

- Missing docstrings in some modules (e.g., `rag/retriever.py`)
- `AGENTS.md` is empty — no agent-focused guidance

---

## 🔍 Code Quality Observations

| Aspect | Rating | Notes |
|--------|--------|-------|
| Modularity | ⭐⭐⭐⭐⭐ | Excellent separation |
| Test Coverage | ⭐⭐⭐⭐⭐ | 375 tests, all passing |
| Type Hints | ⭐⭐⭐⭐☆ | Good use of modern Python types |
| Docstrings | ⭐⭐⭐☆☆ | Core modules documented, some gaps |
| Error Handling | ⭐⭐⭐⭐☆ | Graceful degradation, could be more specific |
| Config Management | ⭐⭐⭐☆☆ | Some drift between config and code |

---

## 📊 Architecture Strengths

1. **Harness Pattern:** The `AgentHarness` is the central orchestrator that wires together all subsystems. This makes it easy to test components in isolation.
2. **Memory Tiers:** Working, Episodic, Semantic, and Procedural memory each have clear responsibilities.
3. **Event Bus:** All major operations emit events that can be observed for logging, tracing, or evolution.
4. **Provider Abstraction:** Easy to add new LLM backends by implementing the `LLMProvider` protocol.
5. **Eval-First Design:** The `EvalGym` is sophisticated with pass@k calculation, perturbation testing, and cost tracking.

---

## 🎯 Recommendations

1. **Fix RAG Persistence:** Store embeddings to disk (SQLite or numpy files) and load on startup
2. **Implement Dashboard:** Either build the SPA or remove the endpoint advertisement
3. **Align Complexity Config:** Make the router actually use the config's tier definitions
4. **Add Documentation:** Fill out `AGENTS.md` with architecture decisions and coding standards
5. **Python 3.14+ Compatibility:** Fix deprecation warnings
6. **Cost Tracking:** Accumulate costs in `TurnResult` across all turns for accuracy

---

## Summary

This is a well-engineered framework with thoughtful architecture and excellent test coverage. The main issues are known and documented in `WORKFLOW_ANALYSIS.md`. Most critical bugs have been fixed (as evidenced by passing tests). The codebase is production-ready for basic use, though the RAG persistence and dashboard features need completion for full feature parity with the documentation.
