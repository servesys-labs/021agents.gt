/**
 * Init command - Scaffold new agent projects
 */
import chalk from "chalk";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import ora from "ora";

const TEMPLATES: Record<string, object> = {
  orchestrator: {
    name: "orchestrator",
    description: "Multi-step task orchestration agent",
    model: "claude-sonnet-4-20250514",
    tools: ["web_search", "sandbox_exec"],
  },
  blank: {
    name: "blank",
    description: "Minimal starting template",
    model: "claude-sonnet-4-20250514",
    tools: [],
  },
  research: {
    name: "research",
    description: "Research and analysis agent",
    model: "claude-sonnet-4-20250514",
    tools: ["web_search", "web_crawl", "store_knowledge"],
  },
  support: {
    name: "support",
    description: "Customer support agent",
    model: "claude-sonnet-4-20250514",
    tools: ["web_search", "http_request"],
  },
  "code-review": {
    name: "code-review",
    description: "Code review and analysis agent",
    model: "claude-sonnet-4-20250514",
    tools: ["sandbox_exec", "web_search"],
  },
  "data-analyst": {
    name: "data-analyst",
    description: "Data analysis and visualization agent",
    model: "claude-sonnet-4-20250514",
    tools: ["sandbox_exec", "file_read"],
  },
  devops: {
    name: "devops",
    description: "DevOps automation agent",
    model: "claude-sonnet-4-20250514",
    tools: ["sandbox_exec", "http_request"],
  },
  "content-writer": {
    name: "content-writer",
    description: "Content creation and editing agent",
    model: "claude-sonnet-4-20250514",
    tools: ["web_search"],
  },
  "project-manager": {
    name: "project-manager",
    description: "Project management agent",
    model: "claude-sonnet-4-20250514",
    tools: ["web_search", "http_request"],
  },
};

interface InitOptions {
  name?: string;
  template: string;
  remote?: string;
  git?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export async function initCommand(
  directory: string = ".",
  options: InitOptions
): Promise<void> {
  const targetDir = join(process.cwd(), directory);
  const projectName = options.name || basename(targetDir);

  // Validate template
  if (!TEMPLATES[options.template]) {
    console.error(chalk.red(`Unknown template: ${options.template}`));
    console.log(chalk.gray("Available templates: " + Object.keys(TEMPLATES).join(", ")));
    process.exit(1);
  }

  // Check if directory exists
  if (existsSync(targetDir)) {
    const files = require("fs").readdirSync(targetDir);
    if (files.length > 0 && !options.force) {
      console.error(chalk.red(`Directory ${directory} is not empty. Use --force to overwrite.`));
      process.exit(1);
    }
  }

  const spinner = ora("Scaffolding project...").start();

  try {
    // Create directory
    if (!options.dryRun) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Create subdirectories
    const dirs = ["agents", "tools", "knowledge"];
    for (const dir of dirs) {
      const dirPath = join(targetDir, dir);
      if (options.dryRun) {
        console.log(chalk.gray(`Would create: ${dirPath}`));
      } else {
        mkdirSync(dirPath, { recursive: true });
      }
    }

    // Create agent config from template
    const template = TEMPLATES[options.template];
    const agentConfig = {
      ...template,
      name: projectName,
      version: "0.1.0",
      system_prompt: `You are ${projectName}, an AI agent.`,
      memory: {
        working: { max_items: 100 },
        episodic: { max_episodes: 1000, ttl_days: 30 },
      },
      governance: {
        budget_limit_usd: 10,
        require_confirmation_for_destructive: true,
      },
    };

    const agentPath = join(targetDir, "agents", `${projectName}.json`);
    if (options.dryRun) {
      console.log(chalk.gray(`Would create: ${agentPath}`));
    } else {
      writeFileSync(agentPath, JSON.stringify(agentConfig, null, 2));
    }

    // Create README
    const readme = `# ${projectName}

AgentOS project scaffolded with the \`${options.template}\` template.

## Quick Start

\`\`\`bash
# Run the agent
agentos run ${projectName} "Your task here"

# Interactive chat
agentos chat ${projectName}

# Deploy to production
agentos deploy ${projectName}
\`\`\`

## Project Structure

- \`agents/\` - Agent definitions (JSON)
- \`tools/\` - Custom tool implementations
- \`knowledge/\` - Knowledge base documents

## Documentation

- [AgentOS Docs](https://docs.agentos.dev)
- [Templates](https://docs.agentos.dev/templates)
`;

    const readmePath = join(targetDir, "README.md");
    if (options.dryRun) {
      console.log(chalk.gray(`Would create: ${readmePath}`));
    } else {
      writeFileSync(readmePath, readme);
    }

    // Create .gitignore
    const gitignore = `# AgentOS
.env
.env.local
.DS_Store
*.log

# Build outputs
dist/
build/

# IDE
.vscode/
.idea/
*.swp
*.swo
`;

    const gitignorePath = join(targetDir, ".gitignore");
    if (options.dryRun) {
      console.log(chalk.gray(`Would create: ${gitignorePath}`));
    } else {
      writeFileSync(gitignorePath, gitignore);
    }

    spinner.succeed("Project scaffolded!");

    if (options.dryRun) {
      console.log(chalk.yellow("\nDry run complete. No files were created."));
      return;
    }

    // Initialize git
    if (options.git !== false) {
      try {
        execSync("git init", { cwd: targetDir, stdio: "ignore" });
        execSync("git add .", { cwd: targetDir, stdio: "ignore" });
        execSync('git commit -m "Initial commit"', { cwd: targetDir, stdio: "ignore" });
        console.log(chalk.green("✓ Git repository initialized"));

        if (options.remote) {
          execSync(`git remote add origin ${options.remote}`, { cwd: targetDir, stdio: "ignore" });
          console.log(chalk.green(`✓ Remote added: ${options.remote}`));
        }
      } catch {
        console.log(chalk.yellow("⚠ Git initialization skipped (git not available)"));
      }
    }

    console.log(chalk.blue("\n✨ Project created successfully!"));
    console.log(chalk.gray(`\nNext steps:`));
    if (directory !== ".") {
      console.log(chalk.gray(`  cd ${directory}`));
    }
    console.log(chalk.gray(`  agentos run ${projectName} "Hello world"`));
    console.log(chalk.gray(`  agentos chat ${projectName}`));
    console.log();

  } catch (error) {
    spinner.fail("Failed to scaffold project");
    console.error(chalk.red(error));
    process.exit(1);
  }
}
