/**
 * Eval command - Run evaluations and view results
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost } from "../lib/api.js";

interface EvalRun {
  run_id: number;
  agent_name: string;
  pass_rate: number;
  avg_score: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  total_tasks: number;
  total_trials: number;
}

export const evalCommand = {
  async list(options: { agent?: string; limit?: number }): Promise<void> {
    const spinner = ora("Loading eval runs...").start();
    try {
      const params = new URLSearchParams();
      if (options.agent) params.set("agent_name", options.agent);
      if (options.limit) params.set("limit", String(options.limit));

      const runs = await apiGet<EvalRun[]>(`/api/v1/eval/runs?${params}`);
      spinner.stop();

      if (runs.length === 0) {
        console.log(chalk.yellow("No eval runs found."));
        console.log(chalk.gray("Run 'agentos eval run <agent>' to start an evaluation."));
        return;
      }

      console.log(chalk.blue(`\n${runs.length} eval run(s):\n`));
      console.log(
        "ID".padEnd(8) +
        "Agent".padEnd(20) +
        "Pass Rate".padEnd(12) +
        "Avg Score".padEnd(12) +
        "Cost".padEnd(10) +
        "Tasks"
      );
      console.log(chalk.gray("─".repeat(80)));

      for (const run of runs) {
        const passColor = run.pass_rate >= 0.8 ? chalk.green :
                         run.pass_rate >= 0.5 ? chalk.yellow : chalk.red;

        console.log(
          String(run.run_id).padEnd(8) +
          run.agent_name.slice(0, 18).padEnd(20) +
          passColor(`${(run.pass_rate * 100).toFixed(1)}%`.padEnd(12)) +
          run.avg_score.toFixed(2).padEnd(12) +
          `$${run.total_cost_usd.toFixed(4)}`.padEnd(10) +
          `${run.total_tasks}/${run.total_trials}`
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load eval runs");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async run(agentName: string, options: {
    tasks?: string;
    trials?: number;
    stream?: boolean;
  }): Promise<void> {
    const spinner = ora(`Starting eval for ${agentName}...`).start();

    try {
      const result = await apiPost<{
        run_id: number;
        status: string;
        message?: string;
      }>("/api/v1/eval/run", {
        agent_name: agentName,
        tasks_json_path: options.tasks,
        num_trials: options.trials || 3,
        stream: options.stream !== false,
      });

      if (result.status === "queued") {
        spinner.succeed("Eval queued!");
        console.log(chalk.blue(`Run ID: ${result.run_id}`));
        console.log(chalk.gray("Check status with: agentos eval status " + result.run_id));
      } else {
        spinner.succeed("Eval completed!");
        console.log(chalk.green(`✓ Run ID: ${result.run_id}`));
      }
    } catch (error) {
      spinner.fail("Eval failed");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async status(runId: string): Promise<void> {
    try {
      const run = await apiGet<{
        id: number;
        agent_name: string;
        status: string;
        pass_rate?: number;
        avg_score?: number;
        total_tasks?: number;
        completed_tasks?: number;
      }>(`/api/v1/eval/runs/${runId}`);

      console.log(chalk.blue(`\nEval Run #${run.id}\n`));
      console.log(`Agent: ${run.agent_name}`);
      console.log(`Status: ${run.status}`);

      if (run.pass_rate !== undefined) {
        const passColor = run.pass_rate >= 0.8 ? chalk.green :
                         run.pass_rate >= 0.5 ? chalk.yellow : chalk.red;
        console.log(`Pass Rate: ${passColor(`${(run.pass_rate * 100).toFixed(1)}%`)}`);
      }
      if (run.avg_score !== undefined) {
        console.log(`Avg Score: ${run.avg_score.toFixed(2)}`);
      }
      if (run.completed_tasks !== undefined && run.total_tasks !== undefined) {
        console.log(`Progress: ${run.completed_tasks}/${run.total_tasks} tasks`);
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get eval status:"), error);
      process.exit(1);
    }
  },

  async datasets(): Promise<void> {
    try {
      const datasets = await apiGet<Array<{
        name: string;
        task_count: number;
        description?: string;
      }>>("/api/v1/eval/datasets");

      console.log(chalk.blue(`\n${datasets.length} dataset(s):\n`));
      for (const ds of datasets) {
        console.log(chalk.bold(ds.name));
        console.log(chalk.gray(`  ${ds.task_count} tasks`));
        if (ds.description) {
          console.log(chalk.gray(`  ${ds.description}`));
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list datasets:"), error);
      process.exit(1);
    }
  },
};
