/**
 * JWT HS256 sign/verify — ported from agentos/auth/jwt.py.
 * Uses Web Crypto API (available in CF Workers).
 */
import type { TokenClaims } from "./types";

const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function b64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

function strToBuffer(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function hmacSign(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    strToBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, strToBuffer(data));
}

async function hmacVerify(secret: string, data: string, signature: BufferSource): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    strToBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, strToBuffer(data));
}

export async function createToken(
  secret: string,
  userId: string,
  opts: {
    email?: string;
    name?: string;
    provider?: string;
    org_id?: string;
    expiry_seconds?: number;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
  const payload: Record<string, unknown> = {
    sub: userId,
    email: opts.email ?? "",
    name: opts.name ?? "",
    provider: opts.provider ?? "",
    org_id: opts.org_id ?? "",
    iat: now,
    exp: now + (opts.expiry_seconds ?? DEFAULT_EXPIRY_SECONDS),
    ...opts.extra,
  };

  const headerB64 = b64urlEncode(strToBuffer(header));
  const payloadB64 = b64urlEncode(strToBuffer(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign(secret, signingInput);
  const sigB64 = b64urlEncode(signature);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export async function verifyToken(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = b64urlDecode(sigB64);

    const valid = await hmacVerify(secret, signingInput, signature as unknown as Uint8Array);
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return {
      ...payload,
      sub: payload.sub ?? "",
      email: payload.email ?? "",
      name: payload.name ?? "",
      provider: payload.provider ?? "",
      org_id: payload.org_id ?? "",
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
      role: payload.role,
    };
  } catch {
    return null;
  }
}
