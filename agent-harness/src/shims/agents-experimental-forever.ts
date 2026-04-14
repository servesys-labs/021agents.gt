/**
 * Shim for agents/experimental/forever
 *
 * @cloudflare/think 0.1.2 imports withFibers from "agents/experimental/forever"
 * but the published agents package doesn't export this path.
 *
 * In the current agents package (0.7+), fiber support is built directly into
 * the Agent base class (runFiber, keepAlive, keepAliveWhile are native methods).
 * withFibers was originally a mixin that added these capabilities — it's now
 * an identity function since Agent already has them.
 */

// withFibers: identity mixin — Agent already has fiber support baked in
export function withFibers<T extends new (...args: any[]) => any>(Base: T): T {
  return Base;
}

// Re-export anything else that might be imported from this path
export { Agent } from "agents";
