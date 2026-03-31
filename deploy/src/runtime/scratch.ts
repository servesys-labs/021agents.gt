/**
 * Phase 6.2: Shared Scratch Directory
 *
 * NOTE: Wire into workflow.ts for delegated runs by adding scratch-read/write
 * tools when parent_depth > 0. See IMPLEMENTATION_PLAN.md Phase 6.2.
 *
 * KV-backed shared state per trace. Sibling agents in a delegation chain
 * can exchange intermediate results without polluting their conversation context.
 *
 * Inspired by Claude Code's coordinator scratchpad for cross-worker knowledge.
 *
 * Keys are scoped by trace_id: `scratch/{traceId}/{key}`
 * TTL: 1 hour (auto-cleanup)
 */

import type { RuntimeEnv } from "./types";

const SCRATCH_PREFIX = "scratch";
const SCRATCH_TTL_SECONDS = 3600; // 1 hour

function scratchKey(traceId: string, key: string): string {
  return `${SCRATCH_PREFIX}/${traceId}/${key}`;
}

/**
 * Write a value to the shared scratch space.
 */
export async function scratchWrite(
  env: RuntimeEnv,
  traceId: string,
  key: string,
  value: string,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;
  await kv.put(scratchKey(traceId, key), value, {
    expirationTtl: SCRATCH_TTL_SECONDS,
  });
}

/**
 * Read a value from the shared scratch space.
 */
export async function scratchRead(
  env: RuntimeEnv,
  traceId: string,
  key: string,
): Promise<string | null> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return null;
  return await kv.get(scratchKey(traceId, key));
}

/**
 * List all keys in the scratch space for a trace.
 */
export async function scratchList(
  env: RuntimeEnv,
  traceId: string,
): Promise<string[]> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return [];
  const prefix = `${SCRATCH_PREFIX}/${traceId}/`;
  const result = await kv.list({ prefix });
  return (result.keys || []).map((k: any) => k.name.slice(prefix.length));
}
