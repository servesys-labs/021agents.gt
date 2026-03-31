/**
 * Run agent command — tree-based execution rendering with live cost tracking
 *
 * Inspired by Claude Code's AgentProgressLine + ShellProgressMessage patterns.
 * Streams SSE events from the runtime and renders a hierarchical execution tree.
 */
import chalk from "chalk";
import { apiStream, apiPost, APIError } from "../lib/api.js";
import {
  createSessionState,
  renderEvent,
  renderStatusLine,
  renderContextBar,
  renderToolProgress,
  startSpinner,
  stopSpinner,
  getErrorRecovery,
  updateStatusFooter,
  type SessionState,
} from "../lib/render.js";

interface RunOptions {
  stream?: boolean;
  verbose?: boolean;
  json?: boolean;
}

export async function runCommand(
  agentName: string,
  task: string,
  options: RunOptions,
): Promise<void> {
  try {
    const state = createSessionState(agentName);

    if (options.json) {
      // JSON mode: return raw result
      const result = await apiPost<any>(`/api/v1/runtime-proxy/agent/run`, {
        agent_name: agentName, task, input: task,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (options.stream !== false) {
      // Default: streaming with tree rendering
      await streamWithTreeRendering(agentName, task, state, options.verbose);
    } else {
      // Non-streaming fallback
      const result = await apiPost<{ output?: string; error?: string }>(
        `/api/v1/runtime-proxy/agent/run`,
        { agent_name: agentName, task, input: task },
      );

      if (result.error) {
        console.error(chalk.red("Error:"), result.error);
        process.exit(1);
      }

      console.log(result.output || "(No output)");
    }
  } catch (error) {
    stopSpinner(); // Ensure spinner is cleaned up on error
    if (error instanceof APIError) {
      console.error(chalk.red(`Error (${error.status}):`), error.message);
      const recovery = getErrorRecovery(error.status, error.message);
      if (recovery) console.log(recovery);
      if (error.status === 404) {
        console.log(chalk.gray("  → Run 'oneshots list' to see available agents."));
      }
    } else {
      console.error(chalk.red("Failed to run agent:"), error);
    }
    process.exit(1);
  }
}

async function streamWithTreeRendering(
  agentName: string,
  task: string,
  state: SessionState,
  verbose?: boolean,
): Promise<void> {
  const stream = apiStream(`/api/v1/runtime-proxy/agent/run`, {
    agent_name: agentName,
    task,
    input: task,
    stream: true,
  });

  let buffer = "";
  let inTokenStream = false;
  let lastStatusUpdate = 0;

  for await (const chunk of stream) {
    buffer += chunk;

    // Parse SSE events from buffer
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;

      // Try to parse as JSON event
      let event: any;
      try {
        const data = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
        event = JSON.parse(data);
      } catch {
        // Raw text chunk (non-event streaming)
        if (inTokenStream) {
          process.stdout.write(trimmed);
        }
        continue;
      }

      // Handle token streaming mode
      if (event.type === "token") {
        if (!inTokenStream) {
          inTokenStream = true;
          process.stdout.write("\n  ");
        }
        process.stdout.write(event.content || "");
        continue;
      }

      // End token stream
      if (inTokenStream && event.type !== "token") {
        inTokenStream = false;
        process.stdout.write("\n");
      }

      // Spinner: start on tool_call, stop on tool_result/turn_end/done
      if (event.type === "tool_call") {
        startSpinner(`${event.name}${event.args_preview ? " " + event.args_preview.slice(0, 40) : ""}...`);
      }
      if (["tool_result", "turn_end", "done", "error"].includes(event.type)) {
        stopSpinner();
      }

      // Tool progress: update spinner label for long-running tools
      if (event.type === "tool_progress") {
        const elapsed = Math.round((event.elapsed_ms || 0) / 1000);
        startSpinner(`${event.tool || "tool"} running... ${elapsed}s`);
        continue;
      }

      // Render structured event
      const rendered = renderEvent(event, state);
      if (rendered !== null) {
        console.log(rendered);
      }

      // Periodic status footer (every 2s during long runs)
      if (verbose && Date.now() - lastStatusUpdate > 2000 && state.turn > 0) {
        updateStatusFooter(state);
        lastStatusUpdate = Date.now();
      }
    }
  }

  // Final newline and status
  if (inTokenStream) {
    process.stdout.write("\n");
  }

  // Summary if no done event was received
  if (state.totalCost > 0 || state.toolCalls > 0) {
    const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
    if (state.errors.length > 0) {
      console.log(chalk.red(`\n${state.errors.length} error(s) during execution`));
      for (const err of state.errors) {
        const recovery = getErrorRecovery(0, err);
        if (recovery) console.log(recovery);
      }
    }
    console.log(chalk.gray(`\n${elapsed}s • ${state.turn} turns • ${state.toolCalls} tools • $${state.totalCost.toFixed(4)}`));
    // Context window indicator
    if (state.inputTokens > 0) {
      console.log(renderContextBar(state.inputTokens, state.outputTokens));
    }
  }
}
