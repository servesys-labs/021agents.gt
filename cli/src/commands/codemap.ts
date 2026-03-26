/**
 * Codemap command - Generate code graphs
 */
import chalk from "chalk";
import { writeFileSync } from "fs";
import { apiPost } from "../lib/api.js";

interface CodemapOptions {
  output?: string;
  json?: boolean;
}

export async function codemapCommand(options: CodemapOptions): Promise<void> {
  try {
    console.log(chalk.blue("🔍 Analyzing codebase..."));

    const result = await apiPost<{
      nodes: Array<{ id: string; type: string; label: string }>;
      edges: Array<{ from: string; to: string; label?: string }>;
    }>("/api/v1/codemap", {
      path: process.cwd(),
    });

    if (options.json) {
      const output = JSON.stringify(result, null, 2);
      if (options.output) {
        writeFileSync(options.output, output);
        console.log(chalk.green(`✓ Codemap saved to ${options.output}`));
      } else {
        console.log(output);
      }
    } else {
      // Text summary
      console.log(chalk.blue(`\nFound ${result.nodes.length} nodes and ${result.edges.length} edges\n`));

      const byType: Record<string, number> = {};
      for (const node of result.nodes) {
        byType[node.type] = (byType[node.type] || 0) + 1;
      }

      console.log(chalk.gray("By type:"));
      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${count}`);
      }

      if (options.output) {
        writeFileSync(options.output, JSON.stringify(result, null, 2));
        console.log(chalk.green(`\n✓ Full codemap saved to ${options.output}`));
      }
    }
  } catch (error) {
    console.error(chalk.red("Failed to generate codemap:"), error);
    process.exit(1);
  }
}
