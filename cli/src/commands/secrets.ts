/**
 * Secrets command - Manage encrypted secrets
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface Secret {
  name: string;
  last_four: string;
  created_at: string;
}

interface Rotation {
  id: string;
  rotated_at: string;
  rotated_by: string;
  secrets_reencrypted: number;
}

async function readMaskedInput(prompt: string): Promise<string> {
  const { createInterface } = await import("readline");

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo by writing prompt manually and reading raw
    process.stdout.write(prompt);
    let value = "";

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (key: Buffer) => {
      const ch = key.toString();
      if (ch === "\r" || ch === "\n") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(value);
      } else if (ch === "\u0003") {
        // Ctrl+C
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        rl.close();
        process.exit(1);
      } else if (ch === "\u007f" || ch === "\b") {
        // Backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        value += ch;
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
  });
}

async function readLineInput(prompt: string): Promise<string> {
  const { createInterface } = await import("readline");

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export const secretsCommand = {
  async list(): Promise<void> {
    const spinner = ora("Loading secrets...").start();
    try {
      const data = await apiGet<{ secrets: Secret[] }>("/api/v1/secrets");
      spinner.stop();

      if (data.secrets.length === 0) {
        console.log(chalk.yellow("No secrets found."));
        return;
      }

      console.log(chalk.blue(`\n${data.secrets.length} secret(s):\n`));
      console.log(
        "Name".padEnd(30) +
        "Hint".padEnd(12) +
        "Created"
      );
      console.log(chalk.gray("─".repeat(60)));

      for (const s of data.secrets) {
        console.log(
          s.name.slice(0, 28).padEnd(30) +
          chalk.gray(`****${s.last_four}`).padEnd(12 + 10) + // +10 for chalk escape codes
          new Date(s.created_at).toLocaleDateString()
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load secrets");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async create(name: string, options: { value?: string }): Promise<void> {
    try {
      let value = options.value;

      if (!value) {
        value = await readMaskedInput("Secret value: ");
        if (!value || value.trim().length === 0) {
          console.error(chalk.red("Secret value cannot be empty."));
          process.exit(1);
        }
      }

      const spinner = ora(`Creating secret ${name}...`).start();
      const result = await apiPost<{ name: string; created: boolean }>(
        "/api/v1/secrets",
        { name, value }
      );
      spinner.succeed(`Secret "${result.name}" created.`);
    } catch (error) {
      console.error(chalk.red("Failed to create secret:"), error);
      process.exit(1);
    }
  },

  async delete(name: string): Promise<void> {
    const spinner = ora(`Deleting secret ${name}...`).start();
    try {
      await apiDelete(`/api/v1/secrets/${encodeURIComponent(name)}`);
      spinner.succeed(`Secret "${name}" deleted.`);
    } catch (error) {
      spinner.fail("Failed to delete secret");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async rotate(): Promise<void> {
    try {
      const newKey = await readMaskedInput("New encryption key: ");
      if (!newKey || newKey.trim().length === 0) {
        console.error(chalk.red("Encryption key cannot be empty."));
        process.exit(1);
      }

      const spinner = ora("Rotating encryption key...").start();
      const result = await apiPost<{
        rotated: boolean;
        secrets_reencrypted: number;
      }>("/api/v1/secrets-rotation/rotate", { new_key: newKey });

      spinner.succeed("Encryption key rotated!");
      console.log(`Secrets re-encrypted: ${chalk.bold(String(result.secrets_reencrypted))}`);
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to rotate key:"), error);
      process.exit(1);
    }
  },

  async rotations(): Promise<void> {
    const spinner = ora("Loading rotation history...").start();
    try {
      const data = await apiGet<{ rotations: Rotation[] }>(
        "/api/v1/secrets-rotation/rotations"
      );
      spinner.stop();

      if (data.rotations.length === 0) {
        console.log(chalk.yellow("No rotation history found."));
        return;
      }

      console.log(chalk.blue(`\n${data.rotations.length} rotation(s):\n`));
      console.log(
        "ID".padEnd(12) +
        "Rotated At".padEnd(22) +
        "By".padEnd(20) +
        "Re-encrypted"
      );
      console.log(chalk.gray("─".repeat(65)));

      for (const r of data.rotations) {
        console.log(
          r.id.slice(0, 10).padEnd(12) +
          new Date(r.rotated_at).toLocaleString().padEnd(22) +
          r.rotated_by.slice(0, 18).padEnd(20) +
          String(r.secrets_reencrypted)
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load rotation history");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },
};
