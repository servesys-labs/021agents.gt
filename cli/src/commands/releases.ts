/**
 * Releases command - Manage agent releases
 */
import chalk from "chalk";
import { apiGet, apiPost } from "../lib/api.js";

interface Release {
  release_id: string;
  agent_name: string;
  version: string;
  channel: string;
  status: string;
  traffic_percentage: number;
  created_at: string;
}

export const releasesCommand = {
  async list(agentName: string): Promise<void> {
    try {
      const releases = await apiGet<Release[]>(`/api/v1/releases?agent_name=${agentName}`);

      if (releases.length === 0) {
        console.log(chalk.yellow(`No releases found for ${agentName}.`));
        return;
      }

      console.log(chalk.blue(`\n${releases.length} release(s) for ${agentName}:\n`));
      console.log(
        "Version".padEnd(15) +
        "Channel".padEnd(15) +
        "Status".padEnd(12) +
        "Traffic".padEnd(10) +
        "Created"
      );
      console.log(chalk.gray("─".repeat(80)));

      for (const r of releases) {
        const statusColor = r.status === "active" ? chalk.green :
                           r.status === "rolling_back" ? chalk.yellow : chalk.gray;

        console.log(
          r.version.padEnd(15) +
          r.channel.padEnd(15) +
          statusColor(r.status.padEnd(12)) +
          `${r.traffic_percentage}%`.padEnd(10) +
          new Date(r.created_at).toLocaleDateString()
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list releases:"), error);
      process.exit(1);
    }
  },

  async promote(agentName: string, version: string, options: {
    channel?: string;
    traffic?: number;
  }): Promise<void> {
    try {
      await apiPost("/api/v1/releases/promote", {
        agent_name: agentName,
        version,
        channel: options.channel || "production",
        traffic_percentage: options.traffic || 100,
      });

      console.log(chalk.green(`✓ ${agentName}@${version} promoted to ${options.channel || "production"}`));
      if (options.traffic && options.traffic < 100) {
        console.log(chalk.gray(`Traffic: ${options.traffic}%`));
      }
    } catch (error) {
      console.error(chalk.red("Failed to promote release:"), error);
      process.exit(1);
    }
  },

  async rollback(agentName: string): Promise<void> {
    try {
      await apiPost("/api/v1/releases/rollback", {
        agent_name: agentName,
      });

      console.log(chalk.yellow(`✓ ${agentName} rolled back to previous version`));
    } catch (error) {
      console.error(chalk.red("Failed to rollback:"), error);
      process.exit(1);
    }
  },
};
