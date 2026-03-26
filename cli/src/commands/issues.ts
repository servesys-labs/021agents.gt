/**
 * Issues command - Issue tracking and remediation
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost, apiPatch } from "../lib/api.js";

interface Issue {
  issue_id: string;
  title: string;
  description?: string;
  status: string;
  severity: string;
  category?: string;
  agent_name?: string;
  created_at: string;
}

export const issuesCommand = {
  async list(options: {
    agent?: string;
    status?: string;
    severity?: string;
  }): Promise<void> {
    const spinner = ora("Loading issues...").start();
    try {
      const params = new URLSearchParams();
      if (options.agent) params.set("agent_name", options.agent);
      if (options.status) params.set("status", options.status);
      if (options.severity) params.set("severity", options.severity);

      const issues = await apiGet<Issue[]>(`/api/v1/issues?${params}`);
      spinner.stop();

      if (issues.length === 0) {
        console.log(chalk.green("No issues found! 🎉"));
        return;
      }

      console.log(chalk.blue(`\n${issues.length} issue(s):\n`));

      // Group by severity
      const bySeverity: Record<string, Issue[]> = {};
      for (const i of issues) {
        bySeverity[i.severity] = bySeverity[i.severity] || [];
        bySeverity[i.severity].push(i);
      }

      for (const sev of ["critical", "high", "medium", "low"]) {
        const list = bySeverity[sev];
        if (!list?.length) continue;

        const color = sev === "critical" ? chalk.red :
                     sev === "high" ? chalk.red :
                     sev === "medium" ? chalk.yellow : chalk.gray;
        console.log(color(`${sev.toUpperCase()} (${list.length})`));

        for (const issue of list.slice(0, 5)) {
          const statusIcon = issue.status === "open" ? "○" :
                            issue.status === "fixing" ? "◐" :
                            issue.status === "resolved" ? "✓" : "◌";
          console.log(`  ${statusIcon} ${chalk.bold(issue.title.slice(0, 50))}`);
          console.log(chalk.gray(`     ${issue.agent_name || "No agent"} | ${issue.issue_id.slice(0, 8)}`));
        }
        if (list.length > 5) {
          console.log(chalk.gray(`  ... and ${list.length - 5} more`));
        }
        console.log();
      }
    } catch (error) {
      spinner.fail("Failed to load issues");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async summary(options: { agent?: string }): Promise<void> {
    try {
      const params = options.agent ? `?agent_name=${options.agent}` : "";
      const summary = await apiGet<{
        total: number;
        by_status: Record<string, number>;
        by_severity: Record<string, number>;
      }>(`/api/v1/issues/summary${params}`);

      console.log(chalk.blue("\nIssues Summary\n"));
      console.log(`Total: ${summary.total}`);
      console.log(chalk.gray("\nBy Status:"));
      for (const [status, count] of Object.entries(summary.by_status)) {
        if (count > 0) console.log(`  ${status}: ${count}`);
      }
      console.log(chalk.gray("\nBy Severity:"));
      for (const [sev, count] of Object.entries(summary.by_severity)) {
        if (count > 0) {
          const color = sev === "critical" ? chalk.red :
                       sev === "high" ? chalk.red :
                       sev === "medium" ? chalk.yellow : chalk.gray;
          console.log(color(`  ${sev}: ${count}`));
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get summary:"), error);
      process.exit(1);
    }
  },

  async show(issueId: string): Promise<void> {
    try {
      const issue = await apiGet<Issue & {
        suggested_fix?: string;
        source_session_id?: string;
      }>(`/api/v1/issues/${issueId}`);

      console.log(chalk.blue(`\nIssue: ${issue.title}\n`));
      console.log(`ID: ${issue.issue_id}`);
      console.log(`Status: ${issue.status}`);
      console.log(`Severity: ${issue.severity}`);
      console.log(`Category: ${issue.category || "unknown"}`);
      if (issue.agent_name) console.log(`Agent: ${issue.agent_name}`);
      console.log(`Created: ${new Date(issue.created_at).toLocaleString()}`);

      if (issue.description) {
        console.log(chalk.gray(`\n${issue.description}`));
      }

      if (issue.suggested_fix) {
        console.log(chalk.green("\nSuggested Fix:"));
        console.log(issue.suggested_fix);
      }

      console.log(chalk.gray("\nActions:"));
      console.log(chalk.gray(`  agentos issues fix ${issueId}`));
      console.log(chalk.gray(`  agentos issues triage ${issueId} <severity>`));
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get issue:"), error);
      process.exit(1);
    }
  },

  async fix(issueId: string): Promise<void> {
    const spinner = ora("Attempting auto-fix...").start();
    try {
      const result = await apiPost<{
        success: boolean;
        message: string;
        applied_fix?: string;
      }>(`/api/v1/issues/${issueId}/fix`, {});

      if (result.success) {
        spinner.succeed("Issue fixed!");
        if (result.applied_fix) {
          console.log(chalk.gray(`Applied: ${result.applied_fix}`));
        }
      } else {
        spinner.fail("Could not auto-fix");
        console.log(chalk.yellow(result.message));
      }
    } catch (error) {
      spinner.fail("Fix failed");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async triage(issueId: string, severity: string): Promise<void> {
    const spinner = ora("Updating issue...").start();
    try {
      await apiPatch(`/api/v1/issues/${issueId}`, { severity });
      spinner.succeed(`Severity updated to ${severity}`);
    } catch (error) {
      spinner.fail("Failed to update");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },
};
