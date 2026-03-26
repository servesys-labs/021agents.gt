/**
 * Jobs command - Background job management
 */
import chalk from "chalk";
import { apiGet } from "../lib/api.js";

interface Job {
  job_id: string;
  type: string;
  status: string;
  agent_name?: string;
  created_at: string;
  completed_at?: string;
  result?: Record<string, unknown>;
}

export const jobsCommand = {
  async list(options: { status?: string; limit?: number }): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (options.status) params.set("status", options.status);
      if (options.limit) params.set("limit", String(options.limit));

      const jobs = await apiGet<Job[]>(`/api/v1/jobs?${params}`);

      console.log(chalk.blue(`\n${jobs.length} job(s):\n`));
      console.log(
        "ID".padEnd(24) +
        "Type".padEnd(20) +
        "Status".padEnd(12) +
        "Agent".padEnd(15) +
        "Created"
      );
      console.log(chalk.gray("─".repeat(90)));

      for (const job of jobs) {
        const statusColor = job.status === "completed" ? chalk.green :
                           job.status === "failed" ? chalk.red :
                           job.status === "running" ? chalk.blue : chalk.gray;

        console.log(
          job.job_id.slice(0, 22).padEnd(24) +
          job.type.slice(0, 18).padEnd(20) +
          statusColor(job.status.padEnd(12)) +
          (job.agent_name || "-").slice(0, 13).padEnd(15) +
          new Date(job.created_at).toLocaleDateString()
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list jobs:"), error);
      process.exit(1);
    }
  },

  async show(jobId: string): Promise<void> {
    try {
      const job = await apiGet<Job>(`/api/v1/jobs/${jobId}`);

      console.log(chalk.blue(`\nJob: ${job.job_id}\n`));
      console.log(`Type: ${job.type}`);
      console.log(`Status: ${job.status}`);
      if (job.agent_name) console.log(`Agent: ${job.agent_name}`);
      console.log(`Created: ${new Date(job.created_at).toLocaleString()}`);

      if (job.completed_at) {
        console.log(`Completed: ${new Date(job.completed_at).toLocaleString()}`);
      }

      if (job.result) {
        console.log(chalk.gray("\nResult:"));
        console.log(JSON.stringify(job.result, null, 2));
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get job:"), error);
      process.exit(1);
    }
  },
};
