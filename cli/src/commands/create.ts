/**
 * Create agent command (conversational or one-shot)
 */
import chalk from "chalk";
import inquirer from "inquirer";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import ora from "ora";
import { apiPost } from "../lib/api.js";

interface CreateOptions {
  oneShot?: string;
  name?: string;
  output?: string;
  model?: string;
  force?: boolean;
}

export async function createCommand(options: CreateOptions): Promise<void> {
  try {
    let description: string;

    if (options.oneShot) {
      // One-shot mode
      description = options.oneShot;
    } else {
      // Conversational mode
      console.log(chalk.blue("🤖 Let's create your agent!\n"));
      
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "description",
          message: "Describe what you want your agent to do:",
          validate: (input: string) => input.length > 10 || "Please provide a longer description",
        },
        {
          type: "confirm",
          name: "useWeb",
          message: "Should the agent be able to search the web?",
          default: true,
        },
        {
          type: "confirm",
          name: "useCode",
          message: "Should the agent be able to execute code?",
          default: true,
        },
      ]);

      description = answers.description;
      if (answers.useWeb) description += " It should have web search capabilities.";
      if (answers.useCode) description += " It should be able to execute code in a sandbox.";
    }

    const spinner = ora("Creating agent...").start();

    // Call API to generate agent config
    const result = await apiPost<{
      agent?: {
        name: string;
        description: string;
        model: string;
        tools: string[];
      };
      lint_report?: { valid: boolean; errors: string[]; warnings: string[] };
    }>("/api/v1/agents/create-from-description", {
      description,
      draft_only: false,
      auto_graph: true,
    });

    spinner.succeed("Agent configuration generated!");

    if (!result.agent) {
      console.error(chalk.red("Failed to generate agent configuration"));
      process.exit(1);
    }

    const agentName = options.name || result.agent.name;
    const outputPath = options.output || join("agents", `${agentName}.json`);

    // Check if file exists
    if (existsSync(outputPath) && !options.force) {
      console.error(chalk.red(`Agent file already exists: ${outputPath}`));
      console.log(chalk.gray("Use --force to overwrite."));
      process.exit(1);
    }

    // Create agents directory if needed
    const { mkdirSync } = await import("fs");
    mkdirSync("agents", { recursive: true });

    // Write agent config
    const agentConfig = {
      ...result.agent,
      name: agentName,
      version: "0.1.0",
      memory: {
        working: { max_items: 100 },
        episodic: { max_episodes: 1000, ttl_days: 30 },
      },
      governance: {
        budget_limit_usd: 10,
        require_confirmation_for_destructive: true,
      },
    };

    writeFileSync(outputPath, JSON.stringify(agentConfig, null, 2));

    console.log(chalk.green(`\n✓ Agent saved to ${outputPath}`));
    console.log(chalk.blue(`\nAgent: ${agentName}`));
    console.log(chalk.gray(result.agent.description));
    console.log(chalk.gray(`Model: ${result.agent.model}`));
    console.log(chalk.gray(`Tools: ${result.agent.tools.join(", ") || "None"}`));

    if (result.lint_report?.warnings?.length) {
      console.log(chalk.yellow("\nWarnings:"));
      for (const warning of result.lint_report.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning}`));
      }
    }

    console.log(chalk.gray(`\nNext steps:`));
    console.log(chalk.gray(`  agentos run ${agentName} "Hello world"`));
    console.log(chalk.gray(`  agentos chat ${agentName}`));
    console.log(chalk.gray(`  agentos deploy ${agentName}`));

  } catch (error) {
    console.error(chalk.red("Failed to create agent:"), error);
    process.exit(1);
  }
}
