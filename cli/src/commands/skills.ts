/**
 * Skills command - List and manage skills
 */
import chalk from "chalk";
import { apiGet, apiPut, apiPost } from "../lib/api.js";

interface Skill {
  name: string;
  description?: string;
  enabled: boolean;
  version?: string;
  category?: string;
}

export const skillsCommand = {
  async list(): Promise<void> {
    try {
      const skills = await apiGet<Skill[]>("/api/v1/skills");

      console.log(chalk.blue(`\n${skills.length} skill(s):\n`));
      console.log("Name".padEnd(25) + "Status".padEnd(12) + "Category");
      console.log(chalk.gray("─".repeat(60)));

      for (const skill of skills) {
        const statusColor = skill.enabled ? chalk.green : chalk.gray;
        console.log(
          skill.name.padEnd(25) +
          statusColor(skill.enabled ? "enabled".padEnd(12) : "disabled".padEnd(12)) +
          (skill.category || "-")
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list skills:"), error);
      process.exit(1);
    }
  },

  async show(name: string): Promise<void> {
    try {
      const skill = await apiGet<Skill & {
        description?: string;
        tools?: string[];
        config_schema?: Record<string, unknown>;
      }>(`/api/v1/skills/${name}`);

      console.log(chalk.blue(`\nSkill: ${skill.name}\n`));
      console.log(`Status: ${skill.enabled ? chalk.green("enabled") : chalk.gray("disabled")}`);
      if (skill.version) console.log(`Version: ${skill.version}`);
      if (skill.category) console.log(`Category: ${skill.category}`);
      if (skill.description) {
        console.log(chalk.gray(`\n${skill.description}`));
      }
      if (skill.tools && skill.tools.length > 0) {
        console.log(chalk.gray(`\nTools: ${skill.tools.join(", ")}`));
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to get skill:"), error);
      process.exit(1);
    }
  },

  async enable(name: string): Promise<void> {
    try {
      await apiPut(`/api/v1/skills/${name}`, { enabled: true });
      console.log(chalk.green(`✓ Skill '${name}' enabled`));
    } catch (error) {
      console.error(chalk.red("Failed to enable skill:"), error);
      process.exit(1);
    }
  },

  async disable(name: string): Promise<void> {
    try {
      await apiPut(`/api/v1/skills/${name}`, { enabled: false });
      console.log(chalk.yellow(`✓ Skill '${name}' disabled`));
    } catch (error) {
      console.error(chalk.red("Failed to disable skill:"), error);
      process.exit(1);
    }
  },

  async reload(): Promise<void> {
    try {
      const result = await apiPost<{
        total: number;
        enabled: number;
        skills: string[];
      }>("/api/v1/skills/reload", {});

      console.log(chalk.green(`✓ Reloaded ${result.total} skills (${result.enabled} enabled)`));
    } catch (error) {
      console.error(chalk.red("Failed to reload skills:"), error);
      process.exit(1);
    }
  },
};
