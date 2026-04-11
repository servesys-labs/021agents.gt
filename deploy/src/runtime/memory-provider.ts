import type { RuntimeEnv } from "./types";

import type { WorkingMemory } from "./memory";

export interface MemoryProviderContext {
  env: RuntimeEnv;
  hyperdrive: Hyperdrive;
  workingMemory: WorkingMemory;
  agentName: string;
  orgId: string;
}

export interface MemoryProvider {
  readonly name: string;
  getStartupBlocks(): Promise<string[]>;
  getTurnContext(query: string): Promise<string>;
}
