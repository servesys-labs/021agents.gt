/**
 * Connectors command - Manage integrations
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface Connector {
  id: string;
  name: string;
  type: string;
  status: string;
  config?: Record<string, unknown>;
}

export const connectorsCommand = {
  async list(): Promise<void> {
    try {
      const connectors = await apiGet<Connector[]>("/api/v1/connectors");

      console.log(chalk.blue(`\n${connectors.length} connector(s):\n`));
      console.log("ID".padEnd(24) + "Name".padEnd(20) + "Type".padEnd(15) + "Status");
      console.log(chalk.gray("─".repeat(80)));

      for (const c of connectors) {
        const statusColor = c.status === "connected" ? chalk.green :
                           c.status === "error" ? chalk.red : chalk.yellow;
        console.log(
          c.id.slice(0, 22).padEnd(24) +
          c.name.slice(0, 18).padEnd(20) +
          c.type.padEnd(15) +
          statusColor(c.status)
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list connectors:"), error);
      process.exit(1);
    }
  },

  async show(connectorId: string): Promise<void> {
    try {
      const c = await apiGet<Connector>(`/api/v1/connectors/${connectorId}`);

      console.log(chalk.blue(`\nConnector: ${c.name}\n`));
      console.log(`ID: ${c.id}`);
      console.log(`Type: ${c.type}`);
      console.log(`Status: ${c.status}`);

      if (c.config) {
        console.log(chalk.gray("\nConfiguration:"));
        for (const [key, value] of Object.entries(c.config)) {
          if (key.toLowerCase().includes("secret") || key.toLowerCase().includes("key")) {
            console.log(`  ${key}: ****`);
          } else {
            console.log(`  ${key}: ${value}`);
          }
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get connector:"), error);
      process.exit(1);
    }
  },

  async create(name: string, type: string, options: {
    config?: string;
  }): Promise<void> {
    try {
      let config = {};
      if (options.config) {
        config = JSON.parse(options.config);
      }

      const result = await apiPost<{ id: string }>("/api/v1/connectors", {
        name,
        type,
        config,
      });

      console.log(chalk.green(`✓ Connector created: ${result.id}`));
    } catch (error) {
      console.error(chalk.red("Failed to create connector:"), error);
      process.exit(1);
    }
  },

  async delete(connectorId: string): Promise<void> {
    try {
      await apiDelete(`/api/v1/connectors/${connectorId}`);
      console.log(chalk.green(`✓ Connector ${connectorId} deleted`));
    } catch (error) {
      console.error(chalk.red("Failed to delete connector:"), error);
      process.exit(1);
    }
  },

  async test(connectorId: string): Promise<void> {
    const spinner = ora("Testing connection...").start();
    try {
      await apiPost(`/api/v1/connectors/${connectorId}/test`, {});
      spinner.succeed("Connection successful!");
    } catch (error) {
      spinner.fail("Connection failed");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },
};
