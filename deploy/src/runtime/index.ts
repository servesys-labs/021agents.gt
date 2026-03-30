/**
 * Edge Runtime — public API.
 */

export { edgeRun, edgeBatch, edgeResume, computeLatencyBreakdown, writeCheckpoint, loadCheckpoint } from "./engine";
export type { RunRequest, RunResponse, BatchRequest, BatchResponse, LatencyBreakdown, CheckpointPayload } from "./engine";
export { GRAPH_HALT, runEdgeGraph, EDGE_RESUME_GRAPH_EMIT_ORDER } from "./edge_graph";
export type { EdgeGraphNode, FreshGraphCtx, ResumeGraphCtx } from "./edge_graph";
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
} from "./db";
export type { TraceReplayAtCursor, UsagePage, UsageSummary, UsageSessionEntry, ConversationMessage } from "./db";
export { callLLM } from "./llm";
export { executeTools, getToolDefinitions, calculateInfraCost, INFRA_COSTS } from "./tools";
export { selectModel, classifyTurn, classifyComplexity, classifyCategory } from "./router";
export type { RouteClassification } from "./router";
export { buildMemoryContext, searchFacts, searchEpisodes, findBestProcedures, queueFactExtraction } from "./memory";
export { detectLoop, maybeSummarize } from "./middleware";
export { pipe, mapInputs, branch, parseOutput } from "./runnable";
export { getConnectorToken, executeConnector } from "./connectors";
// Codemode — full execution system
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
// Harness code tool (createCodeTool integration)
export { createHarnessCodeTool, getHarnessToolDefs } from "./codemode";
// Harness sandbox modules
export { buildSandboxModules, HARNESS_MODULE_SOURCE, HARNESS_TYPE_DEFS } from "./harness-modules";

export { streamRun } from "./stream";
export type { RuntimeEvent as ProtocolRuntimeEvent, TurnEndEvent, DoneEvent, ErrorEvent, ToolCallEvent, ToolResultEvent } from "./protocol";
export { validateEvent, serializeForSSE, serializeForWebSocket } from "./protocol";
export { syncFileToR2, hydrateWorkspace, loadManifest, listWorkspaceFiles, readFileFromR2 } from "./workspace";

// Reasoning strategies (harness pattern: strategy injection)
export { REASONING_STRATEGIES, selectReasoningStrategy, autoSelectStrategy, REASONING_STRATEGY_SNIPPET_CODE } from "./reasoning-strategies";
export type { ReasoningStrategy } from "./reasoning-strategies";

// Cross-session progress tracking (harness pattern: cognitive anchor)
export { buildProgressSummary, writeProgress, loadStartupContext } from "./progress";
export type { ProgressEntry, ProgressSummary, StartupContext } from "./progress";

// Sub-graph support
export { 
  subgraphRegistry, 
  expandSubgraphs, 
  resolveSubgraphInputs, 
  mapSubgraphOutputs,
  validateSubgraphNode,
} from "./subgraph";
export type { SubgraphDefinition, SubgraphNodeConfig, SubgraphRegistry } from "./subgraph";

// Schema validation
export {
  schemaRegistry,
  validateDataAgainstSchema,
  validateGraphSchemas,
  generateTypeScriptTypes,
} from "./graph-schema";
export type { JsonSchema, NodeSchema, SchemaValidationResult } from "./graph-schema";

// Graph caching
export {
  graphCache,
  getCachedValidation,
  setCachedValidation,
  getCachedExpansion,
  setCachedExpansion,
  getCachedLinearPath,
  setCachedLinearPath,
  validateGraphWithCache,
  expandGraphWithCache,
  getLinearPathWithCache,
  invalidateGraphCache,
  invalidateSubgraphCache,
  clearGraphCache,
  getCacheMetrics,
} from "./graph-cache";

// Node registry
export {
  nodeRegistry,
  registerCustomNode,
  createExternalServiceNode,
  listAvailableNodes,
  validateNodeConfig,
} from "./node-registry";
export type { NodeKindDefinition, NodeHandler, NodeHandlerContext } from "./node-registry";

// Intent-based agent routing
export { classifyIntent, decomposeIntents } from "./intent-router";
export type { IntentClassification, AgentCapability } from "./intent-router";

// Backpressure
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
export {
  executeLinearDeclarativeRun,
  executeBoundedDagDeclarativeRun,
  validateLinearDeclarativeGraph,
  validateBoundedDagDeclarativeGraph,
  EDGE_FRESH_GRAPH_KIND_MAP,
} from "./linear_declarative";
export type {
  LinearGraphRunInput,
  BoundedDagRunInput,
  GraphSpec,
  GraphAgentContext,
  LinearTraceEntry,
} from "./linear_declarative";

// Unified declarative graph executor
export {
  executeDeclarativeGraph,
  buildDeclarativeGraphContext,
  prepareDeclarativeGraph,
  executeDeclarativeNode,
  subgraphRegistry as declarativeSubgraphRegistry,
  schemaRegistry as declarativeSchemaRegistry,
  nodeRegistry as declarativeNodeRegistry,
} from "./declarative-executor";
export type {
  DeclarativeGraphContext,
  DeclarativeGraphResult,
  NodeExecutionResult,
  PreparedGraph,
} from "./declarative-executor";
