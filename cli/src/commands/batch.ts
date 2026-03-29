/**
 * Batch command - Submit and manage batch processing jobs
 */
import chalk from "chalk";
import { readFileSync } from "fs";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface BatchJob {
  batch_id: string;
  agent: string;
  status: string;
  total_tasks: number;
  completed: number;
  failed: number;
  created_at: string;
  callback_url?: string;
}

interface BatchSubmitResponse {
  batch_id: string;
  total_tasks: number;
}

interface BatchStatus {
  batch_id: string;
  agent: string;
  status: string;
  total_tasks: number;
  completed: number;
  failed: number;
  created_at: string;
  completed_at: string | null;
  results: BatchTaskResult[];
}

interface BatchTaskResult {
  task_index: number;
  status: string;
  output?: string;
  error?: string;
}

export const batchCommand = {
  async submit(
    agentName: string,
    options: { file?: string; input?: string[]; callback?: string }
  ): Promise<void> {
    try {
      let tasks: unknown[];

      if (options.file) {
        const raw = readFileSync(options.file, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          tasks = parsed;
        } else if (parsed.tasks && Array.isArray(parsed.tasks)) {
          tasks = parsed.tasks;
        } else {
          console.error(
            chalk.red("Invalid file format: expected an array or { tasks: [...] }")
          );
          process.exit(1);
        }
      } else if (options.input && options.input.length > 0) {
        tasks = options.input.map((i) => ({ input: i }));
      } else {
        console.error(
          chalk.red("Provide --file <path> or --input <text> to submit a batch.")
        );
        process.exit(1);
      }

      const body: Record<string, unknown> = { tasks };
      if (options.callback) {
        body.callback_url = options.callback;
      }

      const result = await apiPost<BatchSubmitResponse>(
        `/v1/agents/${agentName}/run/batch`,
        body
      );

      console.log(chalk.green("\n✓ Batch submitted\n"));
      console.log(`Batch ID:    ${result.batch_id}`);
      console.log(`Agent:       ${agentName}`);
      console.log(`Total Tasks: ${result.total_tasks}`);
      if (options.callback) {
        console.log(`Callback:    ${options.callback}`);
      }
      console.log(
        chalk.gray(`\nCheck status with: agentos batch status ${agentName} ${result.batch_id}`)
      );
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to submit batch:"), error);
      process.exit(1);
    }
  },

  async status(agentName: string, batchId: string): Promise<void> {
    try {
      const batch = await apiGet<BatchStatus>(
        `/v1/agents/${agentName}/batches/${batchId}`
      );

      const statusColor =
        batch.status === "completed" ? chalk.green :
        batch.status === "running" ? chalk.blue :
        batch.status === "failed" ? chalk.red :
        batch.status === "cancelled" ? chalk.gray :
        chalk.yellow;

      console.log(chalk.blue(`\nBatch: ${batch.batch_id}\n`));
      console.log(`Agent:     ${batch.agent}`);
      console.log(`Status:    ${statusColor(batch.status)}`);
      console.log(`Progress:  ${batch.completed}/${batch.total_tasks} completed, ${batch.failed} failed`);
      console.log(`Created:   ${new Date(batch.created_at).toLocaleString()}`);
      if (batch.completed_at) {
        console.log(`Completed: ${new Date(batch.completed_at).toLocaleString()}`);
      }

      if (batch.results && batch.results.length > 0) {
        console.log(chalk.gray("\nTask Results:"));
        console.log(
          "  " + "#".padEnd(8) + "Status".padEnd(14) + "Output"
        );
        console.log(chalk.gray("  " + "─".repeat(70)));

        for (const task of batch.results) {
          const taskStatusColor =
            task.status === "completed" ? chalk.green :
            task.status === "failed" ? chalk.red : chalk.yellow;

          const output = task.error
            ? chalk.red(task.error.slice(0, 50))
            : (task.output || "-").slice(0, 50);

          console.log(
            "  " +
            String(task.task_index).padEnd(8) +
            taskStatusColor(task.status.padEnd(14)) +
            output
          );
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get batch status:"), error);
      process.exit(1);
    }
  },

  async list(agentName: string, options: { limit?: number }): Promise<void> {
    try {
      const limit = options.limit || 20;
      const batches = await apiGet<BatchJob[]>(
        `/v1/agents/${agentName}/batches?limit=${limit}`
      );

      if (batches.length === 0) {
        console.log(chalk.yellow(`No batches found for agent "${agentName}".`));
        return;
      }

      console.log(chalk.blue(`\n${batches.length} batch(es) for ${agentName}:\n`));

      console.log(
        "Batch ID".padEnd(28) +
        "Status".padEnd(14) +
        "Progress".padEnd(16) +
        "Created"
      );
      console.log(chalk.gray("─".repeat(80)));

      for (const b of batches) {
        const statusColor =
          b.status === "completed" ? chalk.green :
          b.status === "running" ? chalk.blue :
          b.status === "failed" ? chalk.red :
          b.status === "cancelled" ? chalk.gray :
          chalk.yellow;

        const progress = `${b.completed}/${b.total_tasks}` +
          (b.failed > 0 ? chalk.red(` (${b.failed} err)`) : "");

        console.log(
          b.batch_id.slice(0, 26).padEnd(28) +
          statusColor(b.status.padEnd(14)) +
          progress.padEnd(16) +
          chalk.gray(new Date(b.created_at).toLocaleDateString())
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list batches:"), error);
      process.exit(1);
    }
  },

  async cancel(agentName: string, batchId: string): Promise<void> {
    try {
      await apiDelete(`/v1/agents/${agentName}/batches/${batchId}`);
      console.log(chalk.green(`✓ Batch ${batchId} cancelled`));
    } catch (error) {
      console.error(chalk.red("Failed to cancel batch:"), error);
      process.exit(1);
    }
  },
};
