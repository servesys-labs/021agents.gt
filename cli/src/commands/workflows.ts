/**
 * Workflows command - Manage multi-agent workflows
 */
import chalk from "chalk";
import { writeFileSync, readFileSync } from "fs";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface Workflow {
  workflow_id: string;
  name: string;
  description?: string;
  status: string;
  step_count: number;
  created_at: string;
}

export const workflowsCommand = {
  async list(): Promise<void> {
    try {
      const workflows = await apiGet<Workflow[]>("/api/v1/workflows");

      console.log(chalk.blue(`\n${workflows.length} workflow(s):\n`));
      console.log("ID".padEnd(24) + "Name".padEnd(25) + "Status".padEnd(12) + "Steps");
      console.log(chalk.gray("─".repeat(80)));

      for (const w of workflows) {
        const statusColor = w.status === "active" ? chalk.green :
                           w.status === "paused" ? chalk.yellow : chalk.gray;
        console.log(
          w.workflow_id.slice(0, 22).padEnd(24) +
          w.name.slice(0, 23).padEnd(25) +
          statusColor(w.status.padEnd(12)) +
          w.step_count
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list workflows:"), error);
      process.exit(1);
    }
  },

  async show(workflowId: string): Promise<void> {
    try {
      const workflow = await apiGet<Workflow & {
        steps: Array<{
          id: string;
          agent_name: string;
          depends_on: string[];
        }>;
      }>(`/api/v1/workflows/${workflowId}`);

      console.log(chalk.blue(`\nWorkflow: ${workflow.name}\n`));
      console.log(`ID: ${workflow.workflow_id}`);
      console.log(`Status: ${workflow.status}`);
      if (workflow.description) {
        console.log(chalk.gray(`\n${workflow.description}`));
      }

      console.log(chalk.gray("\nSteps:"));
      for (const step of workflow.steps) {
        const deps = step.depends_on.length > 0
          ? chalk.gray(` (depends on: ${step.depends_on.join(", ")})`)
          : "";
        console.log(`  ${step.id}: ${step.agent_name}${deps}`);
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get workflow:"), error);
      process.exit(1);
    }
  },

  async create(name: string, options: { file?: string }): Promise<void> {
    try {
      let definition;
      if (options.file) {
        definition = JSON.parse(readFileSync(options.file, "utf-8"));
      } else {
        // Create minimal workflow
        definition = {
          name,
          steps: [],
        };
      }

      const result = await apiPost<{ workflow_id: string }>("/api/v1/workflows", definition);
      console.log(chalk.green(`✓ Workflow created: ${result.workflow_id}`));
    } catch (error) {
      console.error(chalk.red("Failed to create workflow:"), error);
      process.exit(1);
    }
  },

  async delete(workflowId: string): Promise<void> {
    try {
      await apiDelete(`/api/v1/workflows/${workflowId}`);
      console.log(chalk.green(`✓ Workflow ${workflowId} deleted`));
    } catch (error) {
      console.error(chalk.red("Failed to delete workflow:"), error);
      process.exit(1);
    }
  },
};
