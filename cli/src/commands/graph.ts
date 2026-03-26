/**
 * Graph command - View and manage agent graphs
 */
import chalk from "chalk";
import { writeFileSync } from "fs";
import { apiGet, apiPost } from "../lib/api.js";

interface Graph {
  nodes: Array<{
    id: string;
    type: string;
    label?: string;
    config?: Record<string, unknown>;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label?: string;
  }>;
}

export const graphCommand = {
  async show(agentName: string): Promise<void> {
    try {
      const graph = await apiGet<Graph>(`/api/v1/graphs/${agentName}`);

      console.log(chalk.blue(`\nGraph for ${agentName}\n`));
      console.log(`Nodes: ${graph.nodes.length}`);
      console.log(`Edges: ${graph.edges.length}`);

      console.log(chalk.gray("\nNodes:"));
      for (const node of graph.nodes) {
        console.log(`  ${node.id} (${node.type})`);
        if (node.label && node.label !== node.id) {
          console.log(chalk.gray(`    Label: ${node.label}`));
        }
      }

      console.log(chalk.gray("\nEdges:"));
      for (const edge of graph.edges) {
        console.log(`  ${edge.from} → ${edge.to}${edge.label ? ` [${edge.label}]` : ""}`);
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get graph:"), error);
      process.exit(1);
    }
  },

  async export(agentName: string, options: { output?: string }): Promise<void> {
    try {
      const graph = await apiGet<Graph>(`/api/v1/graphs/${agentName}`);

      const output = JSON.stringify(graph, null, 2);

      if (options.output) {
        writeFileSync(options.output, output);
        console.log(chalk.green(`✓ Graph exported to ${options.output}`));
      } else {
        console.log(output);
      }
    } catch (error) {
      console.error(chalk.red("Failed to export graph:"), error);
      process.exit(1);
    }
  },

  async validate(agentName: string): Promise<void> {
    try {
      const result = await apiPost<{
        valid: boolean;
        errors: string[];
        warnings: string[];
      }>(`/api/v1/graphs/${agentName}/validate`, {});

      if (result.valid) {
        console.log(chalk.green("✓ Graph is valid"));
      } else {
        console.log(chalk.red("✗ Graph has errors"));
      }

      if (result.errors.length > 0) {
        console.log(chalk.red("\nErrors:"));
        for (const err of result.errors) {
          console.log(`  ✗ ${err}`);
        }
      }

      if (result.warnings.length > 0) {
        console.log(chalk.yellow("\nWarnings:"));
        for (const warn of result.warnings) {
          console.log(`  ○ ${warn}`);
        }
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to validate graph:"), error);
      process.exit(1);
    }
  },
};
