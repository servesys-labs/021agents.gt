/**
 * Billing command - View usage and costs
 */
import chalk from "chalk";
import { apiGet } from "../lib/api.js";

interface Invoice {
  id: string;
  period_start: string;
  period_end: string;
  amount_due: number;
  status: string;
}

export const billingCommand = {
  async usage(options: { days?: number }): Promise<void> {
    try {
      const days = options.days || 30;
      const usage = await apiGet<{
        total_cost: number;
        by_agent: Record<string, number>;
        by_model: Record<string, number>;
        requests: number;
        tokens: { input: number; output: number };
      }>(`/api/v1/billing/usage?days=${days}`);

      console.log(chalk.blue(`\nUsage (Last ${days} days)\n`));
      console.log(`Total Cost: ${chalk.yellow(`$${usage.total_cost.toFixed(4)}`)}`);
      console.log(`Requests: ${usage.requests.toLocaleString()}`);
      console.log(`Tokens: ${usage.tokens.input.toLocaleString()} in / ${usage.tokens.output.toLocaleString()} out`);

      if (Object.keys(usage.by_agent).length > 0) {
        console.log(chalk.gray("\nBy Agent:"));
        const sorted = Object.entries(usage.by_agent).sort((a, b) => b[1] - a[1]);
        for (const [agent, cost] of sorted.slice(0, 10)) {
          console.log(`  ${agent}: $${cost.toFixed(4)}`);
        }
      }

      if (Object.keys(usage.by_model).length > 0) {
        console.log(chalk.gray("\nBy Model:"));
        for (const [model, cost] of Object.entries(usage.by_model)) {
          console.log(`  ${model}: $${cost.toFixed(4)}`);
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get usage:"), error);
      process.exit(1);
    }
  },

  async invoices(): Promise<void> {
    try {
      const invoices = await apiGet<Invoice[]>("/api/v1/billing/invoices");

      console.log(chalk.blue(`\n${invoices.length} invoice(s):\n`));
      console.log(
        "Period".padEnd(25) +
        "Amount".padEnd(12) +
        "Status"
      );
      console.log(chalk.gray("─".repeat(60)));

      for (const inv of invoices) {
        const period = `${new Date(inv.period_start).toLocaleDateString()} - ${new Date(inv.period_end).toLocaleDateString()}`;
        const statusColor = inv.status === "paid" ? chalk.green :
                           inv.status === "pending" ? chalk.yellow : chalk.red;

        console.log(
          period.padEnd(25) +
          `$${inv.amount_due.toFixed(2)}`.padEnd(12) +
          statusColor(inv.status)
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get invoices:"), error);
      process.exit(1);
    }
  },

  async limits(): Promise<void> {
    try {
      const limits = await apiGet<{
        tier: string;
        monthly_budget: number;
        used_this_month: number;
        remaining: number;
      }>("/api/v1/billing/limits");

      console.log(chalk.blue("\nBilling Limits\n"));
      console.log(`Tier: ${limits.tier}`);
      console.log(`Monthly Budget: $${limits.monthly_budget}`);
      console.log(`Used: $${limits.used_this_month.toFixed(4)}`);

      const percentUsed = (limits.used_this_month / limits.monthly_budget) * 100;
      const color = percentUsed > 90 ? chalk.red : percentUsed > 70 ? chalk.yellow : chalk.green;
      console.log(`Remaining: ${color(`$${limits.remaining.toFixed(4)} (${percentUsed.toFixed(1)}%)`)}`);
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get limits:"), error);
      process.exit(1);
    }
  },
};
