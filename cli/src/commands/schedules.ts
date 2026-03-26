/**
 * Schedules command - Manage cron schedules
 */
import chalk from "chalk";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface Schedule {
  id: string;
  agent_name: string;
  task: string;
  cron_expression: string;
  enabled: boolean;
  run_count: number;
  last_run_at?: string;
  next_run_at?: string;
}

export const schedulesCommand = {
  async list(options: { agent?: string }): Promise<void> {
    try {
      const params = options.agent ? `?agent_name=${options.agent}` : "";
      const schedules = await apiGet<Schedule[]>(`/api/v1/schedules${params}`);

      console.log(chalk.blue(`\n${schedules.length} schedule(s):\n`));
      console.log(
        "Agent".padEnd(20) +
        "Cron".padEnd(15) +
        "Status".padEnd(10) +
        "Runs".padEnd(8) +
        "Next Run"
      );
      console.log(chalk.gray("─".repeat(80)));

      for (const s of schedules) {
        const statusColor = s.enabled ? chalk.green : chalk.gray;
        const nextRun = s.next_run_at
          ? new Date(s.next_run_at).toLocaleDateString()
          : "-";

        console.log(
          s.agent_name.slice(0, 18).padEnd(20) +
          s.cron_expression.padEnd(15) +
          statusColor((s.enabled ? "enabled" : "disabled").padEnd(10)) +
          String(s.run_count).padEnd(8) +
          nextRun
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list schedules:"), error);
      process.exit(1);
    }
  },

  async create(agentName: string, task: string, cron: string): Promise<void> {
    try {
      const result = await apiPost<{ schedule_id: string }>("/api/v1/schedules", {
        agent_name: agentName,
        task,
        cron_expression: cron,
        enabled: true,
      });

      console.log(chalk.green(`✓ Schedule created: ${result.schedule_id}`));
      console.log(chalk.gray(`Agent: ${agentName}`));
      console.log(chalk.gray(`Task: ${task}`));
      console.log(chalk.gray(`Cron: ${cron}`));
    } catch (error) {
      console.error(chalk.red("Failed to create schedule:"), error);
      process.exit(1);
    }
  },

  async delete(scheduleId: string): Promise<void> {
    try {
      await apiDelete(`/api/v1/schedules/${scheduleId}`);
      console.log(chalk.green(`✓ Schedule ${scheduleId} deleted`));
    } catch (error) {
      console.error(chalk.red("Failed to delete schedule:"), error);
      process.exit(1);
    }
  },
};
