/**
 * Tools command - List and inspect tools
 */
import chalk from "chalk";
import { apiGet, apiPost } from "../lib/api.js";

interface Tool {
  name: string;
  description: string;
  has_handler: boolean;
  source: string;
  input_schema?: Record<string, unknown>;
}

export const toolsCommand = {
  async list(options: {
    search?: string;
    source?: string;
  }): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (options.search) params.set("search", options.search);
      if (options.source) params.set("source", options.source);

      const tools = await apiGet<Tool[]>(`/api/v1/tools?${params}`);

      console.log(chalk.blue(`\n${tools.length} tool(s):\n`));
      console.log("Name".padEnd(25) + "Source".padEnd(20) + "Handler");
      console.log(chalk.gray("─".repeat(60)));

      for (const tool of tools) {
        const handlerColor = tool.has_handler ? chalk.green : chalk.gray;
        console.log(
          tool.name.slice(0, 23).padEnd(25) +
          tool.source.slice(0, 18).padEnd(20) +
          handlerColor(tool.has_handler ? "✓" : "✗")
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list tools:"), error);
      process.exit(1);
    }
  },

  async show(name: string): Promise<void> {
    try {
      const tool = await apiGet<Tool>(`/api/v1/tools/${name}`);

      console.log(chalk.blue(`\nTool: ${tool.name}\n`));
      console.log(`Source: ${tool.source}`);
      console.log(`Handler: ${tool.has_handler ? chalk.green("available") : chalk.gray("not available")}`);

      if (tool.description) {
        console.log(chalk.gray(`\n${tool.description}`));
      }

      if (tool.input_schema) {
        console.log(chalk.gray("\nInput Schema:"));
        console.log(JSON.stringify(tool.input_schema, null, 2));
      }

      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get tool:"), error);
      process.exit(1);
    }
  },

  async reload(): Promise<void> {
    try {
      await apiPost("/api/v1/tools/reload", {});
      console.log(chalk.green("✓ Tool registry reloaded"));
    } catch (error) {
      console.error(chalk.red("Failed to reload tools:"), error);
      process.exit(1);
    }
  },
};
