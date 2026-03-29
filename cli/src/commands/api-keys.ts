/**
 * API Keys command - Manage API keys
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rate_limit_rpm: number;
  rate_limit_rpd: number;
  last_used_at?: string;
  is_active: boolean;
}

interface CreateKeyResult {
  id: string;
  name: string;
  key: string;
  prefix: string;
  scopes: string[];
}

interface RotateKeyResult {
  id: string;
  key: string;
  prefix: string;
}

export const apiKeysCommand = {
  async list(): Promise<void> {
    const spinner = ora("Loading API keys...").start();
    try {
      const data = await apiGet<{ keys: ApiKey[] }>("/api/v1/api-keys");
      spinner.stop();

      if (data.keys.length === 0) {
        console.log(chalk.yellow("No API keys found."));
        return;
      }

      console.log(chalk.blue(`\n${data.keys.length} API key(s):\n`));
      console.log(
        "Name".padEnd(20) +
        "Prefix".padEnd(14) +
        "Scopes".padEnd(22) +
        "RPM".padEnd(8) +
        "RPD".padEnd(10) +
        "Last Used".padEnd(14) +
        "Active"
      );
      console.log(chalk.gray("─".repeat(95)));

      for (const k of data.keys) {
        const lastUsed = k.last_used_at
          ? new Date(k.last_used_at).toLocaleDateString()
          : chalk.gray("never");

        console.log(
          k.name.slice(0, 18).padEnd(20) +
          chalk.gray(k.prefix).padEnd(14 + 10) + // +10 for chalk escape codes
          (k.scopes.length > 0 ? k.scopes.join(",").slice(0, 20) : chalk.gray("all")).padEnd(22) +
          String(k.rate_limit_rpm).padEnd(8) +
          String(k.rate_limit_rpd).padEnd(10) +
          lastUsed.padEnd(14) +
          (k.is_active ? chalk.green("yes") : chalk.red("no"))
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load API keys");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async create(options: {
    name?: string;
    scopes?: string;
    rpm?: number;
    rpd?: number;
    agents?: string;
    ips?: string;
    expiry?: number;
  }): Promise<void> {
    const spinner = ora("Creating API key...").start();
    try {
      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.scopes) body.scopes = options.scopes.split(",").map((s) => s.trim());
      if (options.rpm) body.rate_limit_rpm = options.rpm;
      if (options.rpd) body.rate_limit_rpd = options.rpd;
      if (options.agents) body.allowed_agents = options.agents.split(",").map((s) => s.trim());
      if (options.ips) body.ip_allowlist = options.ips.split(",").map((s) => s.trim());
      if (options.expiry) body.expires_in_days = options.expiry;

      const result = await apiPost<CreateKeyResult>("/api/v1/api-keys", body);
      spinner.succeed("API key created!");

      console.log();
      console.log(`Name:   ${result.name}`);
      console.log(`ID:     ${result.id}`);
      console.log(`Prefix: ${result.prefix}`);
      console.log(`Scopes: ${result.scopes.join(", ") || "all"}`);
      console.log();
      console.log(chalk.yellow.bold("API Key (shown once, copy it now):"));
      console.log(chalk.green.bold(`  ${result.key}`));
      console.log();
      console.log(chalk.gray("Store this key securely. It will not be shown again."));
      console.log();
    } catch (error) {
      spinner.fail("Failed to create API key");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async revoke(keyId: string): Promise<void> {
    const spinner = ora(`Revoking API key ${keyId}...`).start();
    try {
      await apiDelete(`/api/v1/api-keys/${encodeURIComponent(keyId)}`);
      spinner.succeed(`API key "${keyId}" revoked.`);
    } catch (error) {
      spinner.fail("Failed to revoke API key");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async rotate(keyId: string): Promise<void> {
    const spinner = ora(`Rotating API key ${keyId}...`).start();
    try {
      const result = await apiPost<RotateKeyResult>(
        `/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`,
        {}
      );
      spinner.succeed("API key rotated!");

      console.log();
      console.log(`ID:     ${result.id}`);
      console.log(`Prefix: ${result.prefix}`);
      console.log();
      console.log(chalk.yellow.bold("New API Key (shown once, copy it now):"));
      console.log(chalk.green.bold(`  ${result.key}`));
      console.log();
      console.log(chalk.gray("The previous key is now invalid. Store this key securely."));
      console.log();
    } catch (error) {
      spinner.fail("Failed to rotate API key");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },
};
