/**
 * API key generation and resolution — ported from agentos/api/deps.py.
 */

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const raw = `ak_${crypto.randomUUID().replace(/-/g, "")}`;
  const prefix = raw.slice(0, 11); // "ak_" + first 8 hex chars
  return { key: raw, prefix, hash: "" }; // hash computed async
}

export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
