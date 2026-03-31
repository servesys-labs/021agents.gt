/**
 * Autopilot Mode — Kairos equivalent for AgentOS
 *
 * Proactive autonomous agent that monitors and acts without user prompts.
 * Sends periodic "tick" messages so the agent can take initiative.
 *
 * Architecture:
 *   - Tick interval: 30s (configurable)
 *   - Each tick sends a system prompt asking "anything to do?"
 *   - Agent can: run tools, check status, suggest actions
 *   - Brief mode: responses capped to 2-3 sentences
 *   - User can interject at any time (pauses ticks)
 *
 * Inspired by Claude Code's Kairos system with tick-driven prompts
 * and assistant system prompt injection.
 */

export interface AutopilotConfig {
  enabled: boolean;
  tickIntervalMs: number;
  briefMode: boolean;
  systemAddendum: string;
}

const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: false,
  tickIntervalMs: 30_000, // 30 seconds between ticks
  briefMode: true,
  systemAddendum: `## Autopilot Mode Active
You are running in autonomous mode. Between user messages, you receive periodic <tick> signals.
On each tick, you may:
- Check for pending tasks or notifications
- Proactively suggest actions based on context
- Run background checks (health, cost, status)
- Stay silent if there's nothing useful to report

Rules:
- Keep responses brief (1-3 sentences max)
- Only speak when you have something actionable
- Never repeat information you've already shared
- If the user sends a message, prioritize their request over tick actions
- Prefix proactive messages with [autopilot] so the user knows it's autonomous`,
};

export type TickCallback = (tickPrompt: string) => Promise<void>;

export class AutopilotController {
  private config: AutopilotConfig;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private paused = false;
  private onTick: TickCallback | null = null;

  constructor(config?: Partial<AutopilotConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start autopilot ticks. Each tick invokes the callback with a prompt.
   */
  start(callback: TickCallback): void {
    this.config.enabled = true;
    this.onTick = callback;
    this.paused = false;
    this.tickCount = 0;

    this.tickTimer = setInterval(async () => {
      if (this.paused || !this.onTick) return;
      this.tickCount++;

      const tickPrompt = this.buildTickPrompt();
      try {
        await this.onTick(tickPrompt);
      } catch {
        // Tick failures are non-fatal
      }
    }, this.config.tickIntervalMs);
  }

  /**
   * Pause ticks (when user is typing or agent is responding).
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume ticks after user interaction completes.
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * Stop autopilot entirely.
   */
  stop(): void {
    this.config.enabled = false;
    this.paused = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.onTick = null;
  }

  /**
   * Get the system prompt addendum for autopilot mode.
   */
  getSystemAddendum(): string {
    return this.config.enabled ? this.config.systemAddendum : "";
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get ticks(): number {
    return this.tickCount;
  }

  private buildTickPrompt(): string {
    const now = new Date().toLocaleTimeString();
    const tickNum = this.tickCount;

    // Vary tick prompts to avoid repetitive responses
    if (tickNum % 10 === 0) {
      return `<tick n="${tickNum}" time="${now}" type="status_check">Check system health, pending tasks, and cost status. Report only if something needs attention.</tick>`;
    }
    if (tickNum % 5 === 0) {
      return `<tick n="${tickNum}" time="${now}" type="summary">Briefly summarize what you've accomplished and what's pending. One sentence max.</tick>`;
    }
    return `<tick n="${tickNum}" time="${now}" type="heartbeat">Any pending work or observations? Stay silent if nothing to report.</tick>`;
  }
}
