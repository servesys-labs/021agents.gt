/**
 * Compliance command - GDPR data export and account deletion
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost } from "../lib/api.js";

interface DataExport {
  export_id: string;
  status: string;
  requested_at: string;
  download_url?: string;
  size_bytes?: number;
}

interface DeletionRequest {
  request_id: string;
  user_id: string;
  reason?: string;
  status: string;
  requested_at: string;
  rows_deleted?: number;
  tables_purged?: number;
}

async function readLineInput(prompt: string): Promise<string> {
  const { createInterface } = await import("readline");

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export const complianceCommand = {
  async exportData(): Promise<void> {
    const spinner = ora("Requesting data export...").start();
    try {
      const result = await apiPost<{
        export_id: string;
        status: string;
      }>("/api/v1/compliance/data-export", {});

      spinner.succeed("Data export requested!");
      console.log(`Export ID: ${chalk.bold(result.export_id)}`);
      console.log(`Status:    ${chalk.yellow(result.status)}`);
      console.log(chalk.gray(`\nCheck status: agentos compliance export-status ${result.export_id}`));
      console.log();
    } catch (error) {
      spinner.fail("Failed to request data export");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async exportStatus(exportId: string): Promise<void> {
    const spinner = ora("Checking export status...").start();
    try {
      const data = await apiGet<DataExport>(
        `/api/v1/compliance/data-export/${encodeURIComponent(exportId)}`
      );
      spinner.stop();

      const statusColor =
        data.status === "completed" ? chalk.green :
        data.status === "processing" ? chalk.yellow :
        data.status === "failed" ? chalk.red : chalk.gray;

      console.log(chalk.blue("\nExport Status\n"));
      console.log(`Export ID:  ${data.export_id}`);
      console.log(`Status:     ${statusColor(data.status)}`);
      console.log(`Requested:  ${new Date(data.requested_at).toLocaleString()}`);

      if (data.size_bytes) {
        const sizeMB = (data.size_bytes / (1024 * 1024)).toFixed(2);
        console.log(`Size:       ${sizeMB} MB`);
      }

      if (data.download_url) {
        console.log(`Download:   ${chalk.underline(data.download_url)}`);
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to check export status");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async exports(): Promise<void> {
    const spinner = ora("Loading export requests...").start();
    try {
      const data = await apiGet<{ exports: DataExport[] }>(
        "/api/v1/compliance/data-export"
      );
      spinner.stop();

      if (data.exports.length === 0) {
        console.log(chalk.yellow("No data export requests found."));
        return;
      }

      console.log(chalk.blue(`\n${data.exports.length} export request(s):\n`));
      console.log(
        "Export ID".padEnd(14) +
        "Status".padEnd(14) +
        "Requested".padEnd(22) +
        "Size"
      );
      console.log(chalk.gray("─".repeat(60)));

      for (const e of data.exports) {
        const statusColor =
          e.status === "completed" ? chalk.green :
          e.status === "processing" ? chalk.yellow :
          e.status === "failed" ? chalk.red : chalk.gray;

        const size = e.size_bytes
          ? `${(e.size_bytes / (1024 * 1024)).toFixed(2)} MB`
          : chalk.gray("--");

        console.log(
          e.export_id.slice(0, 12).padEnd(14) +
          statusColor(e.status.padEnd(14)) +
          new Date(e.requested_at).toLocaleDateString().padEnd(22) +
          size
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load export requests");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async deleteAccount(userId: string, options: { reason?: string }): Promise<void> {
    console.log(chalk.red.bold("\nDANGER: Account Deletion\n"));
    console.log(`This will permanently delete all data for user: ${chalk.bold(userId)}`);
    console.log(chalk.gray("This action cannot be undone.\n"));

    const confirmation = await readLineInput(
      'Type DELETE to confirm: '
    );

    if (confirmation.trim() !== "DELETE") {
      console.log(chalk.yellow("Aborted. No data was deleted."));
      return;
    }

    const spinner = ora("Processing account deletion...").start();
    try {
      const result = await apiPost<{
        request_id: string;
        rows_deleted: number;
        tables_purged: number;
      }>("/api/v1/compliance/account", {
        user_id: userId,
        reason: options.reason || "user_request",
      });

      spinner.succeed("Account deletion processed.");
      console.log(`Request ID:    ${chalk.bold(result.request_id)}`);
      console.log(`Rows Deleted:  ${result.rows_deleted}`);
      console.log(`Tables Purged: ${result.tables_purged}`);
      console.log();
    } catch (error) {
      spinner.fail("Failed to delete account");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async deletions(): Promise<void> {
    const spinner = ora("Loading deletion requests...").start();
    try {
      const data = await apiGet<{ requests: DeletionRequest[] }>(
        "/api/v1/compliance/deletion-requests"
      );
      spinner.stop();

      if (data.requests.length === 0) {
        console.log(chalk.yellow("No deletion requests found."));
        return;
      }

      console.log(chalk.blue(`\n${data.requests.length} deletion request(s):\n`));
      console.log(
        "Request ID".padEnd(14) +
        "User ID".padEnd(20) +
        "Status".padEnd(14) +
        "Requested".padEnd(14) +
        "Rows"
      );
      console.log(chalk.gray("─".repeat(75)));

      for (const r of data.requests) {
        const statusColor =
          r.status === "completed" ? chalk.green :
          r.status === "processing" ? chalk.yellow :
          r.status === "failed" ? chalk.red : chalk.gray;

        console.log(
          r.request_id.slice(0, 12).padEnd(14) +
          r.user_id.slice(0, 18).padEnd(20) +
          statusColor(r.status.padEnd(14)) +
          new Date(r.requested_at).toLocaleDateString().padEnd(14) +
          (r.rows_deleted != null ? String(r.rows_deleted) : chalk.gray("--"))
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load deletion requests");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },
};
