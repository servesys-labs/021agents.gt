/**
 * Ops command - Operational monitoring and alerting
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet } from "../lib/api.js";

interface HealthStatus {
  status: string;
  last_run_at: string;
  error_rate_1h: number;
  avg_latency_1h_ms: number;
}

interface LatencyPercentiles {
  p50_ms: number;
  p75_ms: number;
  p95_ms: number;
  p99_ms: number;
  p50?: number;
  p75?: number;
  p95?: number;
  p99?: number;
}

interface ErrorBreakdown {
  total: number;
  by_status: Record<string, number>;
  by_agent: Array<{ agent_name: string; count: number; pct: number }>;
}

interface CostBudget {
  budget: number;
  spent: number;
  pct_used: number;
  projected: number;
}

interface ConcurrentStats {
  running_sessions: number;
  unique_users_5m: number;
  agents_active: number;
}

interface Alert {
  id: string;
  name: string;
  metric: string;
  threshold: number;
  enabled: boolean;
  channel: string;
}

interface AlertFiring {
  id: string;
  alert_name: string;
  fired_at: string;
  value: number;
  resolved_at?: string;
}

export const opsCommand = {
  async health(agentName: string): Promise<void> {
    const spinner = ora(`Checking health for ${agentName}...`).start();
    try {
      const data = await apiGet<HealthStatus>(
        `/api/v1/ops/agents/${encodeURIComponent(agentName)}/health`
      );
      spinner.stop();

      const statusColor =
        data.status === "healthy" ? chalk.green :
        data.status === "degraded" ? chalk.yellow : chalk.red;

      console.log(chalk.blue(`\nHealth: ${agentName}\n`));
      console.log(`Status:       ${statusColor(data.status.toUpperCase())}`);
      console.log(`Last Run:     ${data.last_run_at ? new Date(data.last_run_at).toLocaleString() : chalk.gray("never")}`);
      console.log(`Error Rate:   ${data.error_rate_1h > 5 ? chalk.red(`${data.error_rate_1h}%`) : chalk.green(`${data.error_rate_1h}%`)} (1h)`);
      console.log(`Avg Latency:  ${data.avg_latency_1h_ms > 5000 ? chalk.yellow(`${data.avg_latency_1h_ms}ms`) : chalk.green(`${data.avg_latency_1h_ms}ms`)} (1h)`);
      console.log();
    } catch (error) {
      spinner.fail("Failed to check health");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async latency(options: { agent?: string; hours?: number }): Promise<void> {
    const spinner = ora("Loading latency percentiles...").start();
    try {
      const params = new URLSearchParams();
      params.set("since_hours", String(options.hours || 1));
      if (options.agent) params.set("agent_name", options.agent);

      const data = await apiGet<LatencyPercentiles>(
        `/api/v1/ops/latency-percentiles?${params}`
      );
      spinner.stop();

      console.log(chalk.blue("\nLatency Percentiles\n"));

      const p50 = data.p50_ms ?? data.p50 ?? 0;
      const p75 = data.p75_ms ?? data.p75 ?? 0;
      const p95 = data.p95_ms ?? data.p95 ?? 0;
      const p99 = data.p99_ms ?? data.p99 ?? 0;
      const maxVal = Math.max(p50, p75, p95, p99);
      const barWidth = 40;

      const drawBar = (label: string, value: number) => {
        const width = maxVal > 0 ? Math.round((value / maxVal) * barWidth) : 0;
        const bar = "█".repeat(width) + "░".repeat(barWidth - width);
        const color = value > 10000 ? chalk.red : value > 5000 ? chalk.yellow : chalk.green;
        console.log(`  ${label}  ${color(bar)} ${Math.round(value)}ms`);
      };

      drawBar("p50", p50);
      drawBar("p75", p75);
      drawBar("p95", p95);
      drawBar("p99", p99);
      console.log();
    } catch (error) {
      spinner.fail("Failed to load latency data");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async errors(options: { agent?: string; hours?: number }): Promise<void> {
    const spinner = ora("Loading error breakdown...").start();
    try {
      const params = new URLSearchParams();
      params.set("since_hours", String(options.hours || 1));
      if (options.agent) params.set("agent_name", options.agent);

      const data = await apiGet<ErrorBreakdown>(
        `/api/v1/ops/error-breakdown?${params}`
      );
      spinner.stop();

      console.log(chalk.blue("\nError Breakdown\n"));
      console.log(`Total Errors: ${data.total > 0 ? chalk.red(String(data.total)) : chalk.green("0")}`);

      if (Object.keys(data.by_status).length > 0) {
        console.log(chalk.gray("\nBy Status Code:"));
        for (const [status, count] of Object.entries(data.by_status)) {
          console.log(`  ${status}: ${count}`);
        }
      }

      if (data.by_agent && data.by_agent.length > 0) {
        console.log(chalk.gray("\nBy Agent:"));
        console.log(
          "  " +
          "Agent".padEnd(25) +
          "Count".padEnd(10) +
          "Pct"
        );
        console.log(chalk.gray("  " + "─".repeat(45)));

        for (const entry of data.by_agent) {
          const name = String(entry.agent_name || "unknown");
          const count = Number(entry.count || 0);
          const pct = Number(entry.pct || 0);
          console.log(
            "  " +
            name.slice(0, 23).padEnd(25) +
            String(count).padEnd(10) +
            `${pct.toFixed(1)}%`
          );
        }
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load error data");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async budget(): Promise<void> {
    const spinner = ora("Loading cost budget...").start();
    try {
      const data = await apiGet<CostBudget>("/api/v1/ops/cost-budget");
      spinner.stop();

      console.log(chalk.blue("\nCost Budget\n"));
      console.log(`Budget:     $${data.budget.toFixed(2)}`);
      console.log(`Spent:      $${data.spent.toFixed(2)}`);

      // Progress bar
      const barWidth = 30;
      const filled = Math.min(Math.round((data.pct_used / 100) * barWidth), barWidth);
      const empty = barWidth - filled;
      const barColor = data.pct_used > 90 ? chalk.red : data.pct_used > 70 ? chalk.yellow : chalk.green;
      const bar = barColor("█".repeat(filled)) + chalk.gray("░".repeat(empty));
      console.log(`Used:       ${bar} ${data.pct_used.toFixed(1)}%`);

      const projColor = data.projected > data.budget ? chalk.red : chalk.green;
      console.log(`Projected:  ${projColor(`$${data.projected.toFixed(2)}`)}`);
      if (data.projected > data.budget) {
        console.log(chalk.red(`  Warning: projected spend exceeds budget by $${(data.projected - data.budget).toFixed(2)}`));
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load budget data");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async concurrent(): Promise<void> {
    const spinner = ora("Loading concurrent stats...").start();
    try {
      const data = await apiGet<ConcurrentStats>("/api/v1/ops/concurrent");
      spinner.stop();

      console.log(chalk.blue("\nConcurrent Activity\n"));
      console.log(`Running Sessions:  ${chalk.bold(String(data.running_sessions))}`);
      console.log(`Unique Users (5m): ${chalk.bold(String(data.unique_users_5m))}`);
      console.log(`Agents Active:     ${chalk.bold(String(data.agents_active))}`);
      console.log();
    } catch (error) {
      spinner.fail("Failed to load concurrent stats");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async alerts(options: { action?: string }): Promise<void> {
    const action = options.action || "list";

    if (action === "history") {
      const spinner = ora("Loading alert history...").start();
      try {
        const data = await apiGet<{ firings: AlertFiring[] }>("/api/v1/alerts/history");
        spinner.stop();

        if (data.firings.length === 0) {
          console.log(chalk.green("No recent alert firings."));
          return;
        }

        console.log(chalk.blue(`\n${data.firings.length} alert firing(s):\n`));
        console.log(
          "Alert".padEnd(25) +
          "Fired At".padEnd(22) +
          "Value".padEnd(12) +
          "Resolved"
        );
        console.log(chalk.gray("─".repeat(75)));

        for (const f of data.firings) {
          console.log(
            f.alert_name.slice(0, 23).padEnd(25) +
            new Date(f.fired_at).toLocaleString().padEnd(22) +
            String(f.value).padEnd(12) +
            (f.resolved_at ? chalk.green(new Date(f.resolved_at).toLocaleString()) : chalk.yellow("active"))
          );
        }
        console.log();
      } catch (error) {
        spinner.fail("Failed to load alert history");
        console.error(chalk.red(error));
        process.exit(1);
      }
    } else {
      const spinner = ora("Loading alerts...").start();
      try {
        const data = await apiGet<{ alerts: Alert[] }>("/api/v1/alerts");
        spinner.stop();

        if (data.alerts.length === 0) {
          console.log(chalk.yellow("No alert configurations found."));
          return;
        }

        console.log(chalk.blue(`\n${data.alerts.length} alert(s):\n`));
        console.log(
          "Name".padEnd(22) +
          "Metric".padEnd(20) +
          "Threshold".padEnd(12) +
          "Channel".padEnd(12) +
          "Enabled"
        );
        console.log(chalk.gray("─".repeat(78)));

        for (const a of data.alerts) {
          console.log(
            a.name.slice(0, 20).padEnd(22) +
            a.metric.slice(0, 18).padEnd(20) +
            String(a.threshold).padEnd(12) +
            a.channel.slice(0, 10).padEnd(12) +
            (a.enabled ? chalk.green("yes") : chalk.red("no"))
          );
        }
        console.log();
      } catch (error) {
        spinner.fail("Failed to load alerts");
        console.error(chalk.red(error));
        process.exit(1);
      }
    }
  },
};
