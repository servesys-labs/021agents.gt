/**
 * Research command - Autonomous research (autoresearch)
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost } from "../lib/api.js";

interface ResearchRun {
  id: string;
  agent_name: string;
  status: string;
  iteration: number;
  best_bpb?: number;
  total_experiments: number;
  created_at: string;
}

export const researchCommand = {
  async status(options: { workspace?: string }): Promise<void> {
    try {
      const params = options.workspace ? `?workspace=${options.workspace}` : "";
      const status = await apiGet<{
        running: boolean;
        workspace: string;
        iteration: number;
        best_bpb: number | null;
        total_experiments: number;
        kept: number;
        discarded: number;
        crashed: number;
      }>(`/api/v1/autoresearch/status${params}`);

      console.log(chalk.blue("\nAutoresearch Status\n"));

      if (status.running) {
        console.log(chalk.green("● Running"));
      } else {
        console.log(chalk.gray("○ Not running"));
      }

      console.log(`Workspace: ${status.workspace}`);
      console.log(`Iteration: ${status.iteration}`);

      if (status.best_bpb !== null) {
        console.log(`Best BPB: ${status.best_bpb.toFixed(4)}`);
      }

      console.log(chalk.gray(`\nExperiments: ${status.total_experiments}`));
      console.log(chalk.green(`  Kept: ${status.kept}`));
      console.log(chalk.yellow(`  Discarded: ${status.discarded}`));
      console.log(chalk.red(`  Crashed: ${status.crashed}`));
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get status:"), error);
      process.exit(1);
    }
  },

  async start(options: {
    workspace?: string;
    agent?: string;
  }): Promise<void> {
    const spinner = ora("Starting autoresearch...").start();
    try {
      await apiPost("/api/v1/autoresearch/start", {
        workspace: options.workspace || ".",
        agent_name: options.agent,
      });
      spinner.succeed("Autoresearch started!");
    } catch (error) {
      spinner.fail("Failed to start");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async stop(options: { workspace?: string }): Promise<void> {
    const spinner = ora("Stopping autoresearch...").start();
    try {
      await apiPost("/api/v1/autoresearch/stop", {
        workspace: options.workspace || ".",
      });
      spinner.succeed("Autoresearch stopped!");
    } catch (error) {
      spinner.fail("Failed to stop");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async results(options: {
    workspace?: string;
    last?: number;
  }): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (options.workspace) params.set("workspace", options.workspace);
      if (options.last) params.set("last", String(options.last));

      const results = await apiGet<Array<{
        iteration: number;
        bpb: number;
        config: Record<string, unknown>;
        status: string;
      }>>(`/api/v1/autoresearch/results?${params}`);

      console.log(chalk.blue(`\n${results.length} result(s):\n`));
      console.log(
        "Iteration".padEnd(12) +
        "BPB".padEnd(12) +
        "Status"
      );
      console.log(chalk.gray("─".repeat(40)));

      for (const r of results) {
        const statusColor = r.status === "kept" ? chalk.green :
                           r.status === "discarded" ? chalk.yellow : chalk.red;
        console.log(
          String(r.iteration).padEnd(12) +
          r.bpb.toFixed(4).padEnd(12) +
          statusColor(r.status)
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get results:"), error);
      process.exit(1);
    }
  },

  async runs(options: { agent?: string }): Promise<void> {
    try {
      const params = options.agent ? `?agent_name=${options.agent}` : "";
      const runs = await apiGet<ResearchRun[]>(`/api/v1/autoresearch/runs${params}`);

      console.log(chalk.blue(`\n${runs.length} research run(s):\n`));
      console.log(
        "ID".padEnd(24) +
        "Agent".padEnd(20) +
        "Status".padEnd(12) +
        "Iteration".padEnd(12) +
        "Experiments"
      );
      console.log(chalk.gray("─".repeat(80)));

      for (const r of runs) {
        const statusColor = r.status === "running" ? chalk.blue :
                           r.status === "completed" ? chalk.green : chalk.gray;
        console.log(
          r.id.slice(0, 22).padEnd(24) +
          (r.agent_name || "-").slice(0, 18).padEnd(20) +
          statusColor(r.status.padEnd(12)) +
          String(r.iteration).padEnd(12) +
          r.total_experiments
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list runs:"), error);
      process.exit(1);
    }
  },
};
