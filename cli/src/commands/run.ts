/**
 * Run agent command
 */
import chalk from "chalk";
import { apiStream, APIError } from "../lib/api.js";

interface RunOptions {
  stream?: boolean;
  verbose?: boolean;
}

export async function runCommand(
  agentName: string,
  task: string,
  options: RunOptions
): Promise<void> {
  try {
    console.log(chalk.blue(`Running agent: ${agentName}`));
    console.log(chalk.gray(`Task: ${task}\n`));

    if (options.stream) {
      // Stream the response
      const stream = apiStream(`/api/v1/agents/${agentName}/run`, {
        input: task,
        stream: true,
      });

      for await (const chunk of stream) {
        process.stdout.write(chunk);
      }
      console.log(); // newline after stream
    } else {
      // Non-streaming response
      const { apiPost } = await import("../lib/api.js");
      const result = await apiPost<{ output?: string; error?: string }>(
        `/api/v1/agents/${agentName}/run`,
        { input: task }
      );

      if (result.error) {
        console.error(chalk.red("Error:"), result.error);
        process.exit(1);
      }

      console.log(result.output || "(No output)");
    }
  } catch (error) {
    if (error instanceof APIError) {
      if (error.status === 404) {
        console.error(chalk.red(`Agent not found: ${agentName}`));
        console.log(chalk.gray("Run 'agentos list' to see available agents."));
      } else {
        console.error(chalk.red(`API Error (${error.status}):`), error.message);
      }
    } else {
      console.error(chalk.red("Failed to run agent:"), error);
    }
    process.exit(1);
  }
}
