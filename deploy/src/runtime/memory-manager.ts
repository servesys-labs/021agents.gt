import type { RuntimeEnv } from "./types";

import { buildMemoryContext, type WorkingMemory } from "./memory";
import { loadCuratedMemorySnapshot } from "./curated-memory";

interface MemoryProviderContext {
  env: RuntimeEnv;
  hyperdrive: Hyperdrive;
  workingMemory: WorkingMemory;
  agentName: string;
  orgId: string;
}

interface MemoryProvider {
  readonly name: string;
  getStartupBlocks(): Promise<string[]>;
  getTurnContext(query: string): Promise<string>;
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
  // Current behavior: only built-in memory provider.
  // The manager exists to support future external providers without changing stream.ts flow.
  return new MemoryManager([new BuiltinMemoryProvider(ctx)]);
}
