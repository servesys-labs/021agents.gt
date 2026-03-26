/**
 * Sandbox management commands
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface Sandbox {
  id: string;
  status: string;
  created_at: string;
  timeout: number;
}

export const sandboxCommand = {
  async create(options: { timeout?: string }): Promise<void> {
    const spinner = ora("Creating sandbox...").start();

    try {
      const result = await apiPost<{ sandbox_id: string }>("/api/v1/sandbox", {
        timeout: parseInt(options.timeout || "3600"),
      });

      spinner.succeed("Sandbox created!");
      console.log(chalk.green(`Sandbox ID: ${result.sandbox_id}`));
    } catch (error) {
      spinner.fail("Failed to create sandbox");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async list(): Promise<void> {
    try {
      const sandboxes = await apiGet<Sandbox[]>("/api/v1/sandbox");

      if (sandboxes.length === 0) {
        console.log(chalk.yellow("No active sandboxes."));
        return;
      }

      console.log(chalk.blue(`\n${sandboxes.length} active sandbox(es):\n`));
      console.log("ID".padEnd(20) + "Status".padEnd(12) + "Created");
      console.log(chalk.gray("─".repeat(60)));

      for (const sb of sandboxes) {
        const statusColor = sb.status === "running" ? chalk.green : chalk.gray;
        console.log(
          sb.id.padEnd(20) +
          statusColor(sb.status.padEnd(12)) +
          new Date(sb.created_at).toLocaleString()
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list sandboxes:"), error);
      process.exit(1);
    }
  },

  async exec(id: string, command: string): Promise<void> {
    const spinner = ora(`Executing in sandbox ${id}...`).start();

    try {
      const result = await apiPost<{ stdout?: string; stderr?: string; exit_code?: number }>(
        `/api/v1/sandbox/${id}/exec`,
        { command }
      );

      spinner.stop();

      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.error(chalk.red(result.stderr));
      }
      if (result.exit_code !== 0) {
        process.exit(result.exit_code || 1);
      }
    } catch (error) {
      spinner.fail("Command failed");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async kill(id: string): Promise<void> {
    const spinner = ora(`Killing sandbox ${id}...`).start();

    try {
      await apiDelete(`/api/v1/sandbox/${id}`);
      spinner.succeed("Sandbox killed");
    } catch (error) {
      spinner.fail("Failed to kill sandbox");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },
};
