/**
 * Interactive chat command
 */
import chalk from "chalk";
import readline from "readline";
import { apiStream } from "../lib/api.js";

interface ChatOptions {
  system?: string;
}

export async function chatCommand(agentName: string, options: ChatOptions): Promise<void> {
  console.log(chalk.blue(`🤖 Chat with ${agentName}`));
  console.log(chalk.gray("Type 'exit' or press Ctrl+C to quit\n"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question(chalk.green("You: "), async (input) => {
      if (input.toLowerCase() === "exit") {
        rl.close();
        return;
      }

      process.stdout.write(chalk.blue("Agent: "));

      try {
        const stream = apiStream(`/api/v1/agents/${agentName}/run`, {
          input,
          stream: true,
          system_prompt: options.system,
        });

        for await (const chunk of stream) {
          process.stdout.write(chunk);
        }
        console.log("\n");
      } catch (error) {
        console.error(chalk.red("\nError:"), error);
      }

      askQuestion();
    });
  };

  askQuestion();
}
