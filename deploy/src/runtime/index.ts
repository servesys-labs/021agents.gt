/**
 * Edge Runtime — public API.
 *
 * Primary execution: Cloudflare Workflows (workflow.ts)
 * This module exports supporting utilities used by the Workflow and legacy fallback paths.
 */

// Types
export type {
  AgentConfig,
  LLMMessage,
  LLMResponse,
  TurnResult,
  ToolResult,
  RuntimeEnv,
  RuntimeEvent,
  ToolDefinition,
} from "./types";

// DB
export {
  loadAgentConfig,
  writeSession,
  writeTurn,
  writeEvalRun,
  writeEvalTrial,
  listEvalRuns,
  getEvalRun,
  listEvalTrialsByRun,
  closeDb,
  loadRuntimeEvents,
  loadRuntimeEventsPage,
  replayOtelEventsAtCursor,
  buildRuntimeRunTree,
  writeConversationMessage,
  loadConversationHistory,
  queryUsage,
  loadAgentList,
} from "./db";
export type { TraceReplayAtCursor, UsagePage, UsageSummary, UsageSessionEntry, ConversationMessage } from "./db";

// LLM
export { callLLM } from "./llm";

// Tools
export { executeTools, getToolDefinitions, calculateInfraCost, INFRA_COSTS } from "./tools";

// Router
export { selectModel, classifyTurn, classifyComplexity, classifyCategory } from "./router";
export type { RouteClassification } from "./router";

// Memory
export {
  buildMemoryContext,
  searchFacts,
  searchEpisodes,
  findBestProcedures,
  queueFactExtraction,
  queueSessionEpisodicNote,
  memoryFreshnessNote,
} from "./memory";

// Middleware
export { detectLoop, maybeSummarize } from "./middleware";

// Connectors
export { getConnectorToken, executeConnector } from "./connectors";

// Codemode
export {
  executeCode,
  getToolTypeDefinitions,
  executeScopedCode,
  getScopedTypeDefinitions,
  executeSnippet,
  executeTransform,
  executeValidator,
  executeWebhookHandler,
  executeMiddleware,
  executeObservabilityProcessor,
  executeOrchestrator,
  executeMcpGenerator,
  executeTestRunner,
  resolveScopeConfig,
  getCodeModeStats,
  loadSnippetCached,
  invalidateSnippetCache,
  clearSnippetCache,
  CODEMODE_TEMPLATES,
} from "./codemode";
export type {
  CodemodeScope,
  CodemodeScopeConfig,
  CodemodeExecuteOptions,
  CodemodeResult,
  CodemodeSnippet,
  ValidationResult,
  WebhookHandlerResult,
  MiddlewareAction,
  ObservabilityResult,
  OrchestrationResult,
  GeneratedMcpTool,
  CodemodeTestResult,
} from "./codemode";
export { createHarnessCodeTool, getHarnessToolDefs } from "./codemode";
export { buildSandboxModules, HARNESS_MODULE_SOURCE, HARNESS_TYPE_DEFS } from "./harness-modules";

// Stream — streamRun is legacy (Workflow is the execution engine), but utility
// functions (withProgress, backpressureSend) are re-used by DO WebSocket handlers.
// export { streamRun } from "./stream";
export { withProgress, backpressureSend, createStreamBackpressure } from "./stream";
export type { StreamBackpressure } from "./stream";
export type { RuntimeEvent as ProtocolRuntimeEvent, TurnEndEvent, DoneEvent, ErrorEvent, ToolCallEvent, ToolResultEvent } from "./protocol";
export { validateEvent, serializeForSSE, serializeForWebSocket } from "./protocol";

// Structured errors — telemetry-safe error hierarchy for the entire runtime
export {
  AgentOSError, ToolError, LLMError, BudgetError,
  CircuitBreakerError, SSRFError, RefusalError,
  classifyFetchError,
} from "./errors";
export type { FetchErrorKind, ClassifiedFetchError } from "./errors";

// Abort controller hierarchy — parent→child propagation with sibling isolation
export { createChildAbortController, createSiblingGroup } from "./abort";

// Workspace
export { syncFileToR2, syncBinaryFileToR2, hydrateWorkspace, loadManifest, listWorkspaceFiles, readFileFromR2 } from "./workspace";

// Reasoning strategies
export { REASONING_STRATEGIES, selectReasoningStrategy, autoSelectStrategy, REASONING_STRATEGY_SNIPPET_CODE } from "./reasoning";
export type { ReasoningStrategy } from "./reasoning";

// Progress
export { buildProgressSummary, writeProgress, loadStartupContext } from "./progress";
export type { ProgressEntry, ProgressSummary, StartupContext } from "./progress";

// Backpressure (legacy streaming)
export {
  createBackpressureController,
  createWebSocketSendWithBackpressure,
  AdaptiveRateLimiter,
} from "./backpressure";
export type { BackpressureController, BackpressureOptions, BackpressureStats } from "./backpressure";

// Tool adapter
export {
  wrapExternalTool,
  importPythonTool,
  convertExternalTools,
  exportToolToExternalFormat,
  convertSequenceToGraph,
  autoRegisterTools,
} from "./tool-adapter";
