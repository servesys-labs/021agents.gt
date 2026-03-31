/**
 * CLI Rendering Library — Tree-based agent execution display
 *
 * Inspired by Claude Code's AgentProgressLine, ShellProgressMessage,
 * and per-tool UI.tsx patterns. Renders hierarchical agent execution
 * with live cost/token tracking and tool-specific formatting.
 */
import chalk from "chalk";

// ── Tree Characters ─────────────────────────────────────────────
const TREE = {
  branch: "├─",
  last: "└─",
  pipe: "│ ",
  space: "  ",
} as const;

// ── Session State ───────────────────────────────────────────────
export interface SessionState {
  agentName: string;
  sessionId: string;
  traceId: string;
  turn: number;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  startTime: number;
  model: string;
  currentTools: string[];
  errors: string[];
}

export function createSessionState(agentName: string): SessionState {
  return {
    agentName,
    sessionId: "",
    traceId: "",
    turn: 0,
    totalCost: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    startTime: Date.now(),
    model: "",
    currentTools: [],
    errors: [],
  };
}

// ── Status Line ─────────────────────────────────────────────────
export function renderStatusLine(state: SessionState): string {
  const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
  const cost = state.totalCost > 0 ? chalk.yellow(`$${state.totalCost.toFixed(4)}`) : chalk.gray("$0.00");
  const tokens = state.totalTokens > 0
    ? chalk.cyan(`${formatTokens(state.inputTokens)}↑ ${formatTokens(state.outputTokens)}↓`)
    : chalk.gray("0 tokens");
  const turns = state.turn > 0 ? chalk.white(`T${state.turn}`) : "";
  const model = state.model ? chalk.gray(state.model.split("/").pop() || state.model) : "";

  return `  ${chalk.gray("─")} ${cost} ${chalk.gray("│")} ${tokens} ${chalk.gray("│")} ${elapsed}s ${turns ? chalk.gray("│") + " " + turns : ""} ${model ? chalk.gray("│") + " " + model : ""}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Event Rendering ─────────────────────────────────────────────

export function renderSessionStart(event: any, state: SessionState): string {
  state.sessionId = event.session_id || "";
  state.traceId = event.trace_id || "";
  const agentLabel = chalk.bold.blue(state.agentName);
  const sid = chalk.gray(`session:${state.sessionId.slice(0, 8)}`);
  return `\n${chalk.bold("⚡")} ${agentLabel} ${sid}\n`;
}

export function renderTurnStart(event: any, state: SessionState): string {
  state.turn = event.turn || state.turn + 1;
  state.model = event.model || state.model;
  state.currentTools = [];
  return `${TREE.branch} ${chalk.bold.white(`Turn ${state.turn}`)} ${chalk.gray(state.model.split("/").pop() || "")}`;
}

export function renderToolCall(event: any, state: SessionState): string {
  state.toolCalls++;
  state.currentTools.push(event.name);
  const toolName = chalk.cyan(event.name);
  const preview = event.args_preview ? chalk.gray(` ${truncate(event.args_preview, 60)}`) : "";
  return `${TREE.pipe}${TREE.branch} ${chalk.gray("tool")} ${toolName}${preview}`;
}

export function renderToolResult(event: any, state: SessionState): string {
  state.totalCost += event.cost_usd || 0;
  const name = event.name || "";
  const latency = event.latency_ms ? chalk.gray(`${event.latency_ms}ms`) : "";
  const cost = event.cost_usd ? chalk.yellow(`$${event.cost_usd.toFixed(4)}`) : "";

  if (event.error) {
    return `${TREE.pipe}${TREE.last} ${chalk.red("✗")} ${chalk.red(name)} ${latency} ${chalk.red(truncate(event.error, 80))}`;
  }

  // Tool-specific formatting
  const formatted = formatToolResult(name, event.result || "");
  return `${TREE.pipe}${TREE.last} ${chalk.green("✓")} ${chalk.green(name)} ${latency} ${cost}\n${indentResult(formatted)}`;
}

export function renderTurnEnd(event: any, state: SessionState): string {
  state.totalCost += event.cost_usd || 0;
  state.totalTokens += event.tokens || 0;
  if (event.done) {
    return ""; // Final answer will be rendered separately
  }
  return `${TREE.pipe}`;
}

export function renderToken(event: any): string {
  return event.content || "";
}

export function renderThinking(event: any): string {
  const preview = truncate(event.content || "", 120);
  return `${TREE.pipe}${chalk.gray.italic(`  💭 ${preview}`)}`;
}

export function renderWarning(event: any): string {
  return `${TREE.pipe}${chalk.yellow(`  ⚠ ${event.message || ""}`)}`;
}

export function renderError(event: any, state: SessionState): string {
  state.errors.push(event.message || "Unknown error");
  return `${chalk.red(`  ✗ ${event.message || "Unknown error"}`)}`;
}

export function renderDone(event: any, state: SessionState): string {
  const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
  const cost = chalk.yellow(`$${state.totalCost.toFixed(4)}`);
  const tools = state.toolCalls > 0 ? `${state.toolCalls} tool calls` : "no tools";

  return [
    "",
    `${TREE.last} ${chalk.bold.green("Done")} ${chalk.gray(`${elapsed}s • ${tools} • ${cost}`)}`,
    renderStatusLine(state),
  ].join("\n");
}

export function renderFileChange(event: any): string {
  const path = event.path || "";
  const changeType = event.change_type || "modify";
  const icon = changeType === "create" ? chalk.green("+") : chalk.yellow("~");
  const lang = event.language ? chalk.gray(`[${event.language}]`) : "";
  return `${TREE.pipe}${TREE.pipe}  ${icon} ${chalk.underline(path)} ${lang}`;
}

export function renderSystem(event: any): string {
  return `${TREE.pipe}${chalk.gray(`  ℹ ${event.content || ""}`)}`;
}

export function renderReasoning(event: any): string {
  return `${TREE.branch} ${chalk.magenta("Strategy:")} ${chalk.gray(event.strategy || "auto")}`;
}

// ── Tool-Specific Result Formatting ─────────────────────────────

function formatToolResult(toolName: string, result: string): string {
  if (!result || result.length === 0) return chalk.gray("(no output)");

  switch (toolName) {
    case "grep":
    case "search-file":
      return formatSearchResult(result);
    case "bash":
    case "python-exec":
      return formatShellResult(result);
    case "write-file":
    case "edit-file":
      return formatFileResult(result);
    case "web-search":
      return formatSearchResult(result);
    case "read-file":
    case "view-file":
      return formatReadResult(result);
    default:
      return truncate(result, 200);
  }
}

function formatSearchResult(result: string): string {
  const lines = result.split("\n").filter(l => l.trim());
  const matchLine = lines.find(l => /\d+ match/.test(l));
  if (matchLine) {
    return chalk.gray(truncate(matchLine, 100));
  }
  return chalk.gray(`${lines.length} lines`);
}

function formatShellResult(result: string): string {
  try {
    const parsed = JSON.parse(result);
    const code = parsed.exit_code ?? 0;
    const stdout = parsed.stdout || "";
    const stderr = parsed.stderr || "";
    const icon = code === 0 ? chalk.green("exit 0") : chalk.red(`exit ${code}`);
    const lines = (stdout || stderr).split("\n").length;
    return `${icon} ${chalk.gray(`${lines} lines`)}`;
  } catch {
    return chalk.gray(truncate(result, 100));
  }
}

function formatFileResult(result: string): string {
  // Show diff-like output for edits
  if (result.includes("Written ")) return chalk.green(truncate(result, 100));
  if (result.includes("Edited ")) return chalk.yellow(truncate(result, 100));
  if (result.includes("REJECTED")) return chalk.red(truncate(result, 100));
  return chalk.gray(truncate(result, 100));
}

function formatReadResult(result: string): string {
  const lines = result.split("\n");
  const header = lines.find(l => l.startsWith("[Showing"));
  if (header) return chalk.gray(header);
  return chalk.gray(`${lines.length} lines`);
}

// ── Helpers ─────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function indentResult(text: string): string {
  return text.split("\n").map(l => `${TREE.pipe}${TREE.space}  ${l}`).join("\n");
}

// ── Permission Prompt ───────────────────────────────────────────

export interface PermissionRequest {
  toolName: string;
  action: string;
  risk: string;
}

export function formatPermissionPrompt(req: PermissionRequest): string {
  return [
    "",
    chalk.yellow.bold("⚠ Permission Required"),
    `  Tool: ${chalk.cyan(req.toolName)}`,
    `  Action: ${req.action}`,
    `  Risk: ${chalk.red(req.risk)}`,
    "",
    chalk.gray("  Allow this action? (y/N)"),
  ].join("\n");
}

// ── Animated Spinner (Claude Code pattern) ──────────────────────
// Cycle through braille spinner frames during tool execution.
// Call startSpinner() before tool execution, stopSpinner() after.

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

export function startSpinner(label: string): void {
  stopSpinner();
  spinnerFrame = 0;
  spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    process.stderr.write(`\r${chalk.cyan(frame)} ${chalk.gray(label)}`);
    spinnerFrame++;
  }, 80);
}

export function stopSpinner(): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stderr.write("\r\x1b[K"); // clear line
  }
}

// ── Context Window Indicator ────────────────────────────────────
// Shows context usage as a visual bar, warns when approaching limit.
// Inspired by Claude Code's TokenWarning + ContextVisualization.

export function renderContextBar(inputTokens: number, outputTokens: number, windowSize: number = 200_000): string {
  const used = inputTokens + outputTokens;
  const pct = Math.min(100, Math.round((used / windowSize) * 100));
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;

  let color: typeof chalk.green;
  let label: string;
  if (pct < 50) {
    color = chalk.green;
    label = "";
  } else if (pct < 80) {
    color = chalk.yellow;
    label = "";
  } else {
    color = chalk.red;
    label = " ⚠ context pressure";
  }

  const bar = color("█".repeat(filled)) + chalk.gray("░".repeat(empty));
  return `  context [${bar}] ${pct}% (${formatTokens(used)}/${formatTokens(windowSize)})${label}`;
}

// ── Error Recovery Suggestions ──────────────────────────────────
// Maps error codes to actionable recovery steps.
// Inspired by Claude Code's errorUtils.ts pattern.

export function getErrorRecovery(status: number, message: string): string | null {
  if (status === 401) {
    return chalk.gray("  → Run 'oneshots login' to re-authenticate");
  }
  if (status === 429) {
    const retryMatch = message.match(/retry.after.*?(\d+)/i);
    const wait = retryMatch ? retryMatch[1] : "60";
    return chalk.gray(`  → Rate limited. Wait ${wait}s or upgrade your plan.`);
  }
  if (status === 402) {
    return chalk.gray("  → Insufficient credits. Run 'oneshots billing' to check balance.");
  }
  if (status === 503 || status === 502) {
    return chalk.gray("  → Service temporarily unavailable. Retrying automatically...");
  }
  if (status === 413) {
    return chalk.gray("  → Input too large. Try a shorter task or split into steps.");
  }
  if (message.includes("budget")) {
    return chalk.gray("  → Budget exhausted. Increase with 'oneshots config set budget_limit_usd <amount>'");
  }
  if (message.includes("circuit breaker") || message.includes("OPEN")) {
    return chalk.gray("  → Tool temporarily disabled due to failures. Will auto-recover in 30s.");
  }
  if (message.includes("loop detected")) {
    return chalk.gray("  → Agent got stuck in a loop. Try rephrasing or use a different agent.");
  }
  return null;
}

// ── Tool Progress (for long-running tools) ──────────────────────
// Shows live progress for tools that take >5s.

export function renderToolProgress(event: any): string {
  const elapsed = Math.round((event.elapsed_ms || 0) / 1000);
  const tool = event.tool || "tool";
  return `\r${chalk.cyan("⠸")} ${chalk.gray(`${tool} running... ${elapsed}s`)}`;
}

// ── Persistent Status Footer ────────────────────────────────────
// Writes to stderr so it doesn't interfere with stdout piping.
// Updates in-place using \r carriage return.

export function updateStatusFooter(state: SessionState): void {
  const line = renderStatusLine(state);
  process.stderr.write(`\r${line}\x1b[K`);
}

// ── Event Dispatcher ────────────────────────────────────────────

/**
 * Parse and render a streaming event. Returns the formatted string
 * to display, or null if the event should be suppressed.
 */
export function renderEvent(event: any, state: SessionState): string | null {
  switch (event.type) {
    case "session_start":
      return renderSessionStart(event, state);
    case "turn_start":
      return renderTurnStart(event, state);
    case "tool_call":
      return renderToolCall(event, state);
    case "tool_result":
      return renderToolResult(event, state);
    case "turn_end":
      return renderTurnEnd(event, state);
    case "token":
      return renderToken(event);
    case "thinking":
      return renderThinking(event);
    case "warning":
      return renderWarning(event);
    case "error":
      return renderError(event, state);
    case "done":
      return renderDone(event, state);
    case "file_change":
      return renderFileChange(event);
    case "system":
      return renderSystem(event);
    case "reasoning":
      return renderReasoning(event);
    case "heartbeat":
      return null; // Suppress heartbeats
    case "tool_progress":
      return null; // Suppress intermediate progress
    default:
      return null;
  }
}
