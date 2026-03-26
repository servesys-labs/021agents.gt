/**
 * Cloudflare Access RS256 JWKS verification.
 * Fetches JWKS from CF Access's certs endpoint, verifies RS256 signatures.
 */
import type { TokenClaims } from "./types";

interface JWKSCache {
  keys: JsonWebKey[];
  fetchedAt: number;
}

let cfAccessJwksCache: JWKSCache | null = null;
const JWKS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchJwks(teamDomain: string): Promise<JsonWebKey[]> {
  if (cfAccessJwksCache && Date.now() - cfAccessJwksCache.fetchedAt < JWKS_TTL_MS) {
    return cfAccessJwksCache.keys;
  }

  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`CF Access JWKS fetch failed: ${resp.status}`);

  const data = (await resp.json()) as { keys: JsonWebKey[] };
  cfAccessJwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

async function importRsaKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function b64urlDecode(s: string): Uint8Array {
  let padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (padded.length % 4);
  if (pad !== 4) padded += "=".repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function cfAccessEnabled(teamDomain?: string): boolean {
  return !!teamDomain;
}

/**
 * Derive a display name from JWT payload fields.
 * CF Access JWTs typically only have email, so we extract from that.
 */
export function deriveDisplayName(payload: Record<string, unknown>): string {
  const explicitName = String(payload.name ?? "").trim();
  if (explicitName) return explicitName;

  const first = String(payload.given_name ?? "").trim();
  const last = String(payload.family_name ?? "").trim();
  const joined = [first, last].filter(Boolean).join(" ").trim();
  if (joined) return joined;

  const email = String(payload.email ?? payload.primary_email_address ?? "").trim().toLowerCase();
  if (email && email.includes("@")) {
    const localPart = email.split("@")[0].replace(/[._-]+/g, " ").trim();
    if (localPart) return localPart;
  }
  return "";
}

export async function verifyCfAccessToken(
  token: string,
  teamDomain: string,
  opts?: { aud?: string },
): Promise<TokenClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;

    // Parse header for kid
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
    if (header.alg !== "RS256") return null;

    // Find matching JWK
    const keys = await fetchJwks(teamDomain);
    const jwk = header.kid ? keys.find((k) => (k as any).kid === header.kid) : keys[0];
    if (!jwk) return null;

    // Verify signature
    const key = await importRsaKey(jwk);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = b64urlDecode(sigB64);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput);
    if (!valid) return null;

    // Parse payload
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));

    // Verify audience (the Application AUD tag)
    if (opts?.aud) {
      const aud = payload.aud;
      if (Array.isArray(aud)) {
        if (!aud.includes(opts.aud)) return null;
      } else if (aud !== opts.aud) {
        return null;
      }
    }

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Reject tokens with iat too far in the future (clock skew tolerance: 60s)
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.iat && payload.iat > nowSec + 60) return null;

    return {
      sub: payload.sub ?? "",
      email: payload.email ?? "",
      name: deriveDisplayName(payload),
      provider: "cf_access",
      org_id: "", // CF Access JWTs have no org_id
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}
