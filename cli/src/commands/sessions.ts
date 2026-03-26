/**
 * Sessions command - Session and trace viewing
 */
import chalk from "chalk";
import { apiGet } from "../lib/api.js";

interface Session {
  session_id: string;
  agent_name: string;
  status: string;
  step_count: number;
  cost_total_usd: number;
  wall_clock_seconds: number;
  created_at: string;
}

interface Trace {
  turn_number: number;
  role: string;
  content?: string;
  tool_calls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  error?: string;
  latency_ms: number;
}

export const sessionsCommand = {
  async list(options: {
    agent?: string;
    status?: string;
    limit?: number;
  }): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (options.agent) params.set("agent_name", options.agent);
      if (options.status) params.set("status", options.status);
      if (options.limit) params.set("limit", String(options.limit || 20));

      const sessions = await apiGet<Session[]>(`/api/v1/sessions?${params}`);

      if (sessions.length === 0) {
        console.log(chalk.yellow("No sessions found."));
        return;
      }

      console.log(chalk.blue(`\n${sessions.length} session(s):\n`));
      console.log(
        "ID".padEnd(24) +
        "Agent".padEnd(20) +
        "Status".padEnd(10) +
        "Steps".padEnd(8) +
        "Cost".padEnd(10) +
        "Time"
      );
      console.log(chalk.gray("─".repeat(90)));

      for (const s of sessions) {
        const statusColor = s.status === "completed" ? chalk.green :
                           s.status === "error" ? chalk.red :
                           s.status === "running" ? chalk.blue : chalk.gray;

        console.log(
          s.session_id.slice(0, 22).padEnd(24) +
          s.agent_name.slice(0, 18).padEnd(20) +
          statusColor(s.status.padEnd(10)) +
          String(s.step_count).padEnd(8) +
          `$${s.cost_total_usd.toFixed(4)}`.padEnd(10) +
          `${Math.round(s.wall_clock_seconds)}s`
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list sessions:"), error);
      process.exit(1);
    }
  },

  async show(sessionId: string): Promise<void> {
    try {
      const session = await apiGet<Session & {
        turns?: Trace[];
        metadata?: Record<string, unknown>;
      }>(`/api/v1/sessions/${sessionId}`);

      console.log(chalk.blue(`\nSession: ${session.session_id}\n`));
      console.log(`Agent: ${session.agent_name}`);
      console.log(`Status: ${session.status}`);
      console.log(`Steps: ${session.step_count}`);
      console.log(`Cost: $${session.cost_total_usd.toFixed(4)}`);
      console.log(`Duration: ${Math.round(session.wall_clock_seconds)}s`);
      console.log(`Created: ${new Date(session.created_at).toLocaleString()}`);

      if (session.turns && session.turns.length > 0) {
        console.log(chalk.gray("\nTrace:\n"));
        for (const turn of session.turns.slice(0, 20)) {
          const roleColor = turn.role === "user" ? chalk.green :
                           turn.role === "assistant" ? chalk.blue : chalk.gray;
          console.log(`${roleColor(`[${turn.role}]`)} (${turn.latency_ms}ms)`);

          if (turn.content) {
            console.log(chalk.gray(`  ${turn.content.slice(0, 100)}${turn.content.length > 100 ? "..." : ""}`));
          }

          if (turn.tool_calls && turn.tool_calls.length > 0) {
            for (const tc of turn.tool_calls) {
              console.log(chalk.yellow(`  → ${tc.name}(${
                Object.entries(tc.arguments || {})
                  .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`)
                  .join(", ")
              })`));
            }
          }

          if (turn.error) {
            console.log(chalk.red(`  ✗ Error: ${turn.error.slice(0, 100)}`));
          }
          console.log();
        }

        if (session.turns.length > 20) {
          console.log(chalk.gray(`... and ${session.turns.length - 20} more turns`));
        }
      }
    } catch (error) {
      console.error(chalk.red("Failed to get session:"), error);
      process.exit(1);
    }
  },

  async traces(sessionId: string): Promise<void> {
    // Alias for show
    await this.show(sessionId);
  },
};
