/**
 * Evolve command - Agent evolution and improvement
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost } from "../lib/api.js";

interface Proposal {
  id: string;
  title: string;
  description: string;
  confidence: number;
  category: string;
  status: "pending" | "approved" | "rejected" | "applied";
}

export const evolveCommand = {
  async analyze(agentName: string, options: { days?: number }): Promise<void> {
    const spinner = ora(`Analyzing ${agentName}...`).start();

    try {
      const result = await apiPost<{
        report_id: string;
        summary: string;
        proposals_generated: number;
      }>(`/api/v1/evolve/${agentName}/analyze`, {
        days: options.days || 7,
      });

      spinner.succeed("Analysis complete!");
      console.log(chalk.green(`\n✓ Generated ${result.proposals_generated} proposals`));
      console.log(chalk.gray(result.summary));
      console.log(chalk.gray(`\nView proposals: agentos evolve proposals ${agentName}`));
    } catch (error) {
      spinner.fail("Analysis failed");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async proposals(agentName: string): Promise<void> {
    try {
      const data = await apiGet<{
        proposals: Proposal[];
      }>(`/api/v1/evolve/${agentName}/proposals`);

      if (data.proposals.length === 0) {
        console.log(chalk.yellow("No proposals found."));
        console.log(chalk.gray(`Run 'agentos evolve analyze ${agentName}' to generate proposals.`));
        return;
      }

      console.log(chalk.blue(`\n${data.proposals.length} proposal(s) for ${agentName}:\n`));

      for (const p of data.proposals) {
        const statusColor = p.status === "applied" ? chalk.green :
                           p.status === "approved" ? chalk.blue :
                           p.status === "rejected" ? chalk.gray : chalk.yellow;

        console.log(`${chalk.bold(p.title)} ${statusColor(`[${p.status}]`)}`);
        console.log(chalk.gray(`  ${p.description.slice(0, 80)}${p.description.length > 80 ? "..." : ""}`));
        console.log(chalk.gray(`  Confidence: ${(p.confidence * 100).toFixed(0)}% | Category: ${p.category}`));
        console.log();
      }

      console.log(chalk.gray("Actions:"));
      console.log(chalk.gray(`  agentos evolve approve ${agentName} <id>`));
      console.log(chalk.gray(`  agentos evolve reject ${agentName} <id>`));
      console.log(chalk.gray(`  agentos evolve apply ${agentName} <id>`));
    } catch (error) {
      console.error(chalk.red("Failed to get proposals:"), error);
      process.exit(1);
    }
  },

  async approve(agentName: string, proposalId: string): Promise<void> {
    const spinner = ora("Approving proposal...").start();
    try {
      await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/approve`, {});
      spinner.succeed("Proposal approved!");
    } catch (error) {
      spinner.fail("Failed to approve");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async reject(agentName: string, proposalId: string, options: { reason?: string }): Promise<void> {
    const spinner = ora("Rejecting proposal...").start();
    try {
      await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/reject`, {
        reason: options.reason || "",
      });
      spinner.succeed("Proposal rejected");
    } catch (error) {
      spinner.fail("Failed to reject");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async apply(agentName: string, proposalId: string): Promise<void> {
    const spinner = ora("Applying proposal...").start();
    try {
      await apiPost(`/api/v1/evolve/${agentName}/proposals/${proposalId}/apply`, {});
      spinner.succeed("Proposal applied! Agent updated.");
    } catch (error) {
      spinner.fail("Failed to apply");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async ledger(agentName: string): Promise<void> {
    try {
      const entries = await apiGet<Array<{
        timestamp: string;
        action: string;
        details: string;
      }>>(`/api/v1/evolve/${agentName}/ledger`);

      console.log(chalk.blue(`\nEvolution History for ${agentName}:\n`));
      for (const entry of entries.slice(0, 20)) {
        const date = new Date(entry.timestamp).toLocaleDateString();
        console.log(`${chalk.gray(date)} ${entry.action}`);
        console.log(`  ${entry.details}`);
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get ledger:"), error);
      process.exit(1);
    }
  },
};
