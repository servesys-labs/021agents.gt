/**
 * Deploy agent command
 */
import chalk from "chalk";
import ora from "ora";
import { apiPost } from "../lib/api.js";

interface DeployOptions {
  env?: string;
  canary?: string;
}

export async function deployCommand(
  agentName: string,
  options: DeployOptions
): Promise<void> {
  const spinner = ora(`Deploying ${agentName}...`).start();

  try {
    const result = await apiPost<{
      deployment_id?: string;
      url?: string;
      status?: string;
    }>("/api/v1/deploy", {
      agent_name: agentName,
      environment: options.env,
      canary_percentage: parseInt(options.canary || "0"),
    });

    spinner.succeed("Deployment initiated!");

    console.log(chalk.green(`\n✓ Agent deployed successfully`));
    if (result.url) {
      console.log(chalk.blue(`URL: ${result.url}`));
    }
    if (result.deployment_id) {
      console.log(chalk.gray(`Deployment ID: ${result.deployment_id}`));
    }
    console.log(chalk.gray(`Environment: ${options.env}`));
    if (parseInt(options.canary || "0") > 0) {
      console.log(chalk.gray(`Canary: ${options.canary}%`));
    }

  } catch (error) {
    spinner.fail("Deployment failed");
    console.error(chalk.red(error));
    process.exit(1);
  }
}
