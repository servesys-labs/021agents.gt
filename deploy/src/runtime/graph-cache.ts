/**
 * Graph validation and expansion caching.
 * 
 * Caches expensive graph operations:
 * - Validation results (linear path, DAG constraints)
 * - Subgraph expansions
 * - Schema validations
 * 
 * Cache key = SHA256 of graph JSON + version info
 */

import { linearEntryExitPath, type GraphSpec } from "./linear_declarative";
import { expandSubgraphs } from "./subgraph";

// ── Cache Implementation ─────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
  size: number; // Approximate size in bytes
}

class GraphCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private maxSize: number;
  private currentSize = 0;
  
  constructor(maxSizeMB = 50) {
    this.maxSize = maxSizeMB * 1024 * 1024;
  }
  
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.delete(key);
      return undefined;
    }
    
    return entry.value as T;
  }
  
  set<T>(key: string, value: T, ttlMs = 300_000): void { // Default 5 min TTL
    const size = this.estimateSize(value);
    
    // Evict if needed
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }
    
    // Remove old entry if exists
    const oldEntry = this.cache.get(key);
    if (oldEntry) {
      this.currentSize -= oldEntry.size;
    }
    
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl: ttlMs,
      size,
    });
    
    this.currentSize += size;
  }
  
  private delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(key);
    }
  }
  
  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.delete(oldestKey);
    }
  }
  
  private estimateSize(value: unknown): number {
    // Rough estimation
    const str = JSON.stringify(value);
    return str.length * 2; // UTF-16 chars
  }
  
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }
  
  stats(): { size: number; entries: number; maxSize: number } {
    return {
      size: this.currentSize,
      entries: this.cache.size,
      maxSize: this.maxSize,
    };
  }
}

export const graphCache = new GraphCache(50); // 50MB cache

// ── Cache Keys ──────────────────────────────────────────────────────

function hashGraph(graph: GraphSpec): string {
  // Simple hash - in production use crypto.subtle.digest
  const str = JSON.stringify(graph);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// ── Cached Operations ───────────────────────────────────────────────

interface ValidationCacheEntry {
  valid: boolean;
  linearPath?: string[];
  errors?: string[];
  warnings?: string[];
  timestamp: number;
}

export function getCachedValidation(graph: GraphSpec): ValidationCacheEntry | undefined {
  const key = `val:${hashGraph(graph)}`;
  return graphCache.get<ValidationCacheEntry>(key);
}

export function setCachedValidation(
  graph: GraphSpec,
  result: ValidationCacheEntry,
  ttlMs = 600_000 // 10 minutes
): void {
  const key = `val:${hashGraph(graph)}`;
  graphCache.set(key, result, ttlMs);
}

interface ExpansionCacheEntry {
  expanded: GraphSpec;
  subgraphCount: number;
  timestamp: number;
}

export async function getCachedExpansion(graph: GraphSpec): Promise<GraphSpec | undefined> {
  const key = `exp:${hashGraph(graph)}`;
  const cached = graphCache.get<ExpansionCacheEntry>(key);
  return cached?.expanded;
}

export function setCachedExpansion(
  original: GraphSpec,
  expanded: GraphSpec,
  ttlMs = 300_000 // 5 minutes
): void {
  const key = `exp:${hashGraph(original)}`;
  const subgraphCount = original.nodes.filter(n => n.kind === "subgraph").length;
  
  graphCache.set(key, {
    expanded,
    subgraphCount,
    timestamp: Date.now(),
  }, ttlMs);
}

interface LinearPathCacheEntry {
  path: string[] | null;
  isLinear: boolean;
  timestamp: number;
}

export function getCachedLinearPath(graph: GraphSpec): string[] | null | undefined {
  const key = `lin:${hashGraph(graph)}`;
  const cached = graphCache.get<LinearPathCacheEntry>(key);
  return cached?.path;
}

export function setCachedLinearPath(
  graph: GraphSpec,
  path: string[] | null,
  ttlMs = 600_000
): void {
  const key = `lin:${hashGraph(graph)}`;
  graphCache.set(key, {
    path,
    isLinear: path !== null,
    timestamp: Date.now(),
  }, ttlMs);
}

// ── Cached Wrappers ─────────────────────────────────────────────────

export async function validateGraphWithCache(
  graph: GraphSpec,
  validator: (graph: GraphSpec) => Promise<ValidationCacheEntry>
): Promise<ValidationCacheEntry> {
  const cached = getCachedValidation(graph);
  if (cached) {
    return cached;
  }
  
  const result = await validator(graph);
  setCachedValidation(graph, result);
  return result;
}

export async function expandGraphWithCache(
  graph: GraphSpec,
  expander: (graph: GraphSpec) => Promise<GraphSpec>
): Promise<GraphSpec> {
  const cached = await getCachedExpansion(graph);
  if (cached) {
    return cached;
  }
  
  const result = await expander(graph);
  setCachedExpansion(graph, result);
  return result;
}

export function getLinearPathWithCache(graph: GraphSpec): string[] | null {
  const cached = getCachedLinearPath(graph);
  if (cached !== undefined) {
    return cached;
  }
  
  const path = linearEntryExitPath(graph);
  setCachedLinearPath(graph, path);
  return path;
}

// ── Cache Invalidation ──────────────────────────────────────────────

/**
 * Invalidate all cached results for a graph.
 * Call this when the graph is modified.
 */
export function invalidateGraphCache(graph: GraphSpec): void {
  const hash = hashGraph(graph);
  
  // We can't easily delete by prefix, so we track and rebuild
  // In production, use a proper cache with prefix scanning
  const keysToDelete: string[] = [];
  
  for (const key of graphCache["cache"].keys()) {
    if (key.includes(hash)) {
      keysToDelete.push(key);
    }
  }
  
  for (const key of keysToDelete) {
    graphCache["cache"].delete(key);
  }
}

/**
 * Invalidate cache when a subgraph is updated.
 */
export function invalidateSubgraphCache(subgraphId: string): void {
  // In production, maintain an index of which graphs use which subgraphs
  // For now, clear entire cache (subgraphs are relatively rare)
  graphCache.clear();
}

/**
 * Clear all graph cache entries.
 */
export function clearGraphCache(): void {
  graphCache.clear();
}

// ── Metrics ─────────────────────────────────────────────────────────

export function getCacheMetrics(): {
  size: number;
  entries: number;
  maxSize: number;
  utilization: number;
} {
  const stats = graphCache.stats();
  return {
    ...stats,
    utilization: stats.size / stats.maxSize,
  };
}
