/**
 * Interactive chat command — tree-rendered agent execution
 *
 * Enhanced REPL with streaming event rendering, cost tracking,
 * and tool result formatting.
 */
import chalk from "chalk";
import readline from "readline";
import { apiStream } from "../lib/api.js";
import { createSessionState, renderEvent, type SessionState } from "../lib/render.js";

interface ChatOptions {
  system?: string;
  verbose?: boolean;
}

export async function chatCommand(agentName: string, options: ChatOptions): Promise<void> {
  console.log(chalk.bold.blue(`⚡ ${agentName}`));
  console.log(chalk.gray(`Type 'exit' to quit, '/cost' for session cost, '/clear' to reset\n`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let sessionCost = 0;
  let sessionTurns = 0;
  let sessionTokens = 0;
  const history: Array<{ role: string; content: string }> = [];

  const askQuestion = () => {
    rl.question(chalk.green.bold("❯ "), async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { askQuestion(); return; }

      // Built-in commands
      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "/quit") {
        console.log(chalk.gray(`\nSession: ${sessionTurns} turns, $${sessionCost.toFixed(4)}`));
        rl.close();
        return;
      }
      if (trimmed === "/cost") {
        console.log(chalk.yellow(`Cost: $${sessionCost.toFixed(4)} | Turns: ${sessionTurns} | Tokens: ${sessionTokens}`));
        askQuestion(); return;
      }
      if (trimmed === "/clear") {
        history.length = 0;
        sessionCost = 0; sessionTurns = 0; sessionTokens = 0;
        console.log(chalk.gray("Context cleared.\n"));
        askQuestion(); return;
      }

      history.push({ role: "user", content: trimmed });

      try {
        const state = createSessionState(agentName);
        const stream = apiStream(`/api/v1/runtime-proxy/agent/run`, {
          agent_name: agentName,
          input: trimmed,
          stream: true,
          system_prompt: options.system,
          history,
        });

        let buffer = "";
        let inTokenStream = false;
        let assistantResponse = "";

        for await (const chunk of stream) {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const t = line.trim();
            if (!t || t === "data: [DONE]") continue;

            let event: any;
            try {
              const data = t.startsWith("data: ") ? t.slice(6) : t;
              event = JSON.parse(data);
            } catch {
              if (inTokenStream) process.stdout.write(t);
              continue;
            }

            if (event.type === "token") {
              if (!inTokenStream) { inTokenStream = true; process.stdout.write("\n  "); }
              process.stdout.write(event.content || "");
              assistantResponse += event.content || "";
              continue;
            }

            if (inTokenStream && event.type !== "token") {
              inTokenStream = false;
              process.stdout.write("\n");
            }

            // In chat mode, only show tool calls, results, and errors (not full tree)
            if (["tool_call", "tool_result", "warning", "error", "file_change"].includes(event.type)) {
              const rendered = renderEvent(event, state);
              if (rendered) console.log(rendered);
            }

            if (event.type === "done") {
              sessionCost += state.totalCost;
              sessionTurns++;
              sessionTokens += state.totalTokens;
              assistantResponse = assistantResponse || event.output || "";
            }
          }
        }

        if (inTokenStream) process.stdout.write("\n");

        // Track conversation
        if (assistantResponse) {
          history.push({ role: "assistant", content: assistantResponse.slice(0, 4000) });
        }

        // Inline cost for verbose mode
        if (options.verbose && state.totalCost > 0) {
          console.log(chalk.gray(`  ${state.totalCost.toFixed(4)} • ${state.totalTokens} tokens`));
        }

        console.log(); // spacing
      } catch (error) {
        console.error(chalk.red("Error:"), error);
      }

      askQuestion();
    });
  };

  askQuestion();
}
