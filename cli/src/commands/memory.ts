/**
 * Memory command - View agent memory
 */
import chalk from "chalk";
import { apiGet } from "../lib/api.js";

export const memoryCommand = {
  async working(agentName: string): Promise<void> {
    try {
      const items = await apiGet<Array<{
        key: string;
        value: unknown;
        timestamp: string;
      }>>(`/api/v1/memory/${agentName}/working`);

      console.log(chalk.blue(`\nWorking Memory for ${agentName}\n`));
      console.log(`${items.length} item(s)\n`);

      for (const item of items) {
        console.log(chalk.bold(item.key));
        console.log(chalk.gray(`  ${JSON.stringify(item.value).slice(0, 100)}`));
        console.log(chalk.gray(`  ${new Date(item.timestamp).toLocaleString()}`));
        console.log();
      }
    } catch (error) {
      console.error(chalk.red("Failed to get working memory:"), error);
      process.exit(1);
    }
  },

  async episodic(agentName: string, options: { limit?: number }): Promise<void> {
    try {
      const episodes = await apiGet<Array<{
        id: string;
        summary: string;
        timestamp: string;
        importance?: number;
      }>>(`/api/v1/memory/${agentName}/episodic?limit=${options.limit || 20}`);

      console.log(chalk.blue(`\nEpisodic Memory for ${agentName}\n`));

      for (const ep of episodes) {
        const importance = ep.importance ? ` (${(ep.importance * 100).toFixed(0)}%)` : "";
        console.log(chalk.gray(new Date(ep.timestamp).toLocaleDateString()) + importance);
        console.log(`  ${ep.summary.slice(0, 100)}${ep.summary.length > 100 ? "..." : ""}`);
        console.log();
      }
    } catch (error) {
      console.error(chalk.red("Failed to get episodic memory:"), error);
      process.exit(1);
    }
  },

  async semantic(agentName: string, options: { query?: string }): Promise<void> {
    try {
      const params = options.query ? `?query=${encodeURIComponent(options.query)}` : "";
      const facts = await apiGet<Array<{
        fact: string;
        confidence: number;
        source?: string;
      }>>(`/api/v1/memory/${agentName}/semantic${params}`);

      console.log(chalk.blue(`\nSemantic Memory for ${agentName}\n`));

      for (const fact of facts) {
        const confColor = fact.confidence > 0.8 ? chalk.green :
                         fact.confidence > 0.5 ? chalk.yellow : chalk.gray;
        console.log(`${confColor(`${(fact.confidence * 100).toFixed(0)}%`)} ${fact.fact}`);
        if (fact.source) {
          console.log(chalk.gray(`  Source: ${fact.source}`));
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get semantic memory:"), error);
      process.exit(1);
    }
  },
};
