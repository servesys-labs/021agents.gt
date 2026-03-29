/**
 * Tokens command - End-user token management for multi-tenant SaaS
 */
import chalk from "chalk";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface EndUserToken {
  id: string;
  end_user_id: string;
  token_prefix: string;
  expires_at: string | null;
  allowed_agents: string[];
  rate_limit_rpm: number | null;
  rate_limit_rpd: number | null;
  created_at: string;
}

interface TokenCreateResponse {
  id: string;
  token: string;
}

interface TokenUsage {
  end_user_id: string;
  total_requests: number;
  total_cost: number;
  by_agent: Record<string, { requests: number; cost: number }>;
}

export const tokensCommand = {
  async list(): Promise<void> {
    try {
      const tokens = await apiGet<EndUserToken[]>("/api/v1/end-user-tokens");

      if (tokens.length === 0) {
        console.log(chalk.yellow("No end-user tokens found."));
        console.log(chalk.gray("Create one with: agentos tokens create --user-id <id>"));
        return;
      }

      console.log(chalk.blue(`\n${tokens.length} end-user token(s):\n`));

      console.log(
        "End User ID".padEnd(24) +
        "Token Prefix".padEnd(18) +
        "Expires".padEnd(22) +
        "Agents".padEnd(20) +
        "Rate Limits"
      );
      console.log(chalk.gray("─".repeat(100)));

      for (const t of tokens) {
        const expires = t.expires_at
          ? new Date(t.expires_at).toLocaleDateString()
          : chalk.gray("never");
        const agents = t.allowed_agents.length > 0
          ? t.allowed_agents.slice(0, 3).join(", ") + (t.allowed_agents.length > 3 ? "..." : "")
          : chalk.gray("all");
        const limits = [
          t.rate_limit_rpm ? `${t.rate_limit_rpm} rpm` : null,
          t.rate_limit_rpd ? `${t.rate_limit_rpd} rpd` : null,
        ].filter(Boolean).join(", ") || chalk.gray("none");

        console.log(
          t.end_user_id.slice(0, 22).padEnd(24) +
          chalk.gray(t.token_prefix.padEnd(18)) +
          expires.padEnd(22) +
          agents.padEnd(20) +
          limits
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list tokens:"), error);
      process.exit(1);
    }
  },

  async create(options: {
    userId: string;
    agents?: string;
    rpm?: number;
    rpd?: number;
    expiry?: number;
  }): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        end_user_id: options.userId,
      };

      if (options.agents) {
        body.allowed_agents = options.agents.split(",").map((a) => a.trim());
      }

      if (options.expiry) {
        body.expires_in_seconds = options.expiry;
      }

      if (options.rpm) {
        body.rate_limit_rpm = options.rpm;
      }

      if (options.rpd) {
        body.rate_limit_rpd = options.rpd;
      }

      const result = await apiPost<TokenCreateResponse>(
        "/api/v1/end-user-tokens",
        body
      );

      console.log(chalk.green("\n✓ End-user token created\n"));
      console.log(`Token ID: ${result.id}`);
      console.log(`User ID:  ${options.userId}`);
      console.log();
      console.log(chalk.yellow("Token: ") + chalk.bold(result.token));
      console.log();
      console.log(
        chalk.red("⚠  Save this token now — it will not be shown again.")
      );
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to create token:"), error);
      process.exit(1);
    }
  },

  async revoke(tokenId: string): Promise<void> {
    try {
      await apiDelete(`/api/v1/end-user-tokens/${tokenId}`);
      console.log(chalk.green(`✓ Token ${tokenId} revoked`));
    } catch (error) {
      console.error(chalk.red("Failed to revoke token:"), error);
      process.exit(1);
    }
  },

  async usage(userId: string): Promise<void> {
    try {
      const usage = await apiGet<TokenUsage>(
        `/api/v1/end-user-tokens/usage/${userId}`
      );

      console.log(chalk.blue(`\nUsage for user: ${usage.end_user_id}\n`));
      console.log(`Total Requests: ${usage.total_requests.toLocaleString()}`);
      console.log(`Total Cost:     ${chalk.yellow(`$${(usage.total_cost ?? 0).toFixed(4)}`)}`);

      const agentEntries = Object.entries(usage.by_agent);
      if (agentEntries.length > 0) {
        console.log(chalk.gray("\nBreakdown by Agent:"));
        console.log(
          "  " + "Agent".padEnd(30) + "Requests".padEnd(14) + "Cost"
        );
        console.log(chalk.gray("  " + "─".repeat(55)));

        const sorted = agentEntries.sort((a, b) => b[1].cost - a[1].cost);
        for (const [agent, data] of sorted) {
          console.log(
            "  " +
            agent.padEnd(30) +
            data.requests.toLocaleString().padEnd(14) +
            `$${data.cost.toFixed(4)}`
          );
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get token usage:"), error);
      process.exit(1);
    }
  },
};
