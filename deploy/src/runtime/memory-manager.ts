import { buildMemoryContext } from "./memory";
import { loadCuratedMemorySnapshot } from "./curated-memory";
import { log } from "./log";
import type { MemoryProvider, MemoryProviderContext } from "./memory-provider";

class HttpExternalMemoryProvider implements MemoryProvider {
  readonly name = "external-http";
  private consecutiveFailures = 0;
  private cooldownUntilMs = 0;
  private lastHealthCheckMs = 0;
  private static readonly FAILURE_THRESHOLD = 3;
  private static readonly COOLDOWN_MS = 60_000;
  private static readonly HEALTHCHECK_INTERVAL_MS = 30_000;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly ctx: MemoryProviderContext,
  ) {}

  private inCooldown(): boolean {
    return Date.now() < this.cooldownUntilMs;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= HttpExternalMemoryProvider.FAILURE_THRESHOLD) {
      this.cooldownUntilMs = Date.now() + HttpExternalMemoryProvider.COOLDOWN_MS;
      log.warn(
        `[memory-manager] external provider cooldown enabled for ${HttpExternalMemoryProvider.COOLDOWN_MS}ms after ${this.consecutiveFailures} failures (${String((err as any)?.message || err)})`,
      );
      // Reset so next post-cooldown failures must be consecutive again.
      this.consecutiveFailures = 0;
    }
  }

  private async healthCheck(): Promise<void> {
    if (this.inCooldown()) throw new Error("external provider in cooldown");
    const now = Date.now();
    if (now - this.lastHealthCheckMs < HttpExternalMemoryProvider.HEALTHCHECK_INTERVAL_MS) return;
    this.lastHealthCheckMs = now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`health HTTP ${res.status}`);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async postJson(path: string, payload: Record<string, unknown>): Promise<any> {
    if (this.inCooldown()) throw new Error("external provider in cooldown");
    await this.healthCheck();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.recordSuccess();
      return data;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getStartupBlocks(): Promise<string[]> {
    const data = await this.postJson("/startup", {
      agent_name: this.ctx.agentName,
      org_id: this.ctx.orgId,
    });
    if (Array.isArray(data?.blocks)) {
      return data.blocks.map((b: unknown) => String(b || "")).filter((b: string) => b.trim().length > 0);
    }
    const blocks = [
      String(data?.memory_block || ""),
      String(data?.user_block || ""),
      String(data?.context || ""),
    ].filter((b) => b.trim().length > 0);
    return blocks;
  }

  async getTurnContext(query: string): Promise<string> {
    const data = await this.postJson("/turn-context", {
      query,
      agent_name: this.ctx.agentName,
      org_id: this.ctx.orgId,
    });
    return String(data?.context || "");
  }
}

class BuiltinMemoryProvider implements MemoryProvider {
  readonly name = "builtin";

  constructor(private readonly ctx: MemoryProviderContext) {}

  async getStartupBlocks(): Promise<string[]> {
    const curated = await loadCuratedMemorySnapshot(this.ctx.env, {
      agent_name: this.ctx.agentName,
      org_id: this.ctx.orgId,
    });
    return [curated.memory_block || "", curated.user_block || ""].filter(Boolean);
  }

  async getTurnContext(query: string): Promise<string> {
    return buildMemoryContext(
      this.ctx.env,
      this.ctx.hyperdrive,
      query,
      this.ctx.workingMemory,
      { agent_name: this.ctx.agentName, org_id: this.ctx.orgId },
    );
  }
}

export class MemoryManager {
  constructor(private readonly providers: MemoryProvider[]) {}

  async getStartupBlocks(): Promise<string[]> {
    const blocks = await Promise.all(this.providers.map((p) => p.getStartupBlocks().catch(() => [])));
    return blocks.flat().filter((b) => typeof b === "string" && b.trim().length > 0);
  }

  async getTurnContext(query: string): Promise<string> {
    const parts = await Promise.all(this.providers.map((p) => p.getTurnContext(query).catch(() => "")));
    return parts.filter((p) => typeof p === "string" && p.trim().length > 0).join("\n\n");
  }
}

export function createMemoryManager(ctx: MemoryProviderContext): MemoryManager {
  const providers: MemoryProvider[] = [new BuiltinMemoryProvider(ctx)];

  // Optional feature-flagged external provider scaffold.
  // Disabled by default to preserve current behavior.
  const enabled = String(ctx.env.EXTERNAL_MEMORY_PROVIDER_ENABLED || "").toLowerCase() === "true";
  const baseUrl = String(ctx.env.EXTERNAL_MEMORY_PROVIDER_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(ctx.env.EXTERNAL_MEMORY_PROVIDER_API_KEY || "").trim();
  if (enabled && baseUrl) {
    providers.push(new HttpExternalMemoryProvider(baseUrl, apiKey, ctx));
    log.info(`[memory-manager] external provider enabled: ${baseUrl}`);
  }

  return new MemoryManager(providers);
}
