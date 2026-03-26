/**
 * List agents command
 */
import chalk from "chalk";
import { apiGet } from "../lib/api.js";

interface Agent {
  name: string;
  description?: string;
  status?: string;
  model?: string;
  version?: string;
  updated_at?: string;
}

export async function listCommand(options: { all?: boolean }): Promise<void> {
  try {
    const agents = await apiGet<Agent[]>("/api/v1/agents");

    if (agents.length === 0) {
      console.log(chalk.yellow("No agents found."));
      console.log(chalk.gray("Create your first agent with: agentos create"));
      return;
    }

    console.log(chalk.blue(`\nFound ${agents.length} agent(s):\n`));

    const maxNameLen = Math.max(...agents.map(a => a.name.length), 10);

    // Header
    console.log(
      chalk.bold("Name".padEnd(maxNameLen + 2)) +
      chalk.bold("Status".padEnd(12)) +
      chalk.bold("Model".padEnd(25)) +
      chalk.bold("Version")
    );
    console.log(chalk.gray("─".repeat(maxNameLen + 60)));

    for (const agent of agents) {
      const status = agent.status || "draft";
      const statusColor = status === "live" ? chalk.green :
                         status === "draft" ? chalk.gray :
                         status === "error" ? chalk.red :
                         chalk.yellow;

      console.log(
        agent.name.padEnd(maxNameLen + 2) +
        statusColor(status.padEnd(12)) +
        chalk.gray((agent.model || "-").padEnd(25)) +
        chalk.gray(agent.version || "-")
      );

      if (agent.description) {
        console.log(chalk.gray("  " + agent.description.slice(0, 60) + (agent.description.length > 60 ? "..." : "")));
      }
    }

    console.log();
  } catch (error) {
    console.error(chalk.red("Failed to list agents:"), error);
    process.exit(1);
  }
}
