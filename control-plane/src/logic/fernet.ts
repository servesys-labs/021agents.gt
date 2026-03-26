/**
 * Fernet-compatible encryption using Web Crypto API.
 *
 * Format: fernet:v1:<base64url-salt>:<base64url-ciphertext>
 *
 * Key derivation: PBKDF2(SHA-256, 390000 iterations) from seed + salt
 * Encryption: AES-256-CBC with random IV
 * Authentication: HMAC-SHA256 over IV+ciphertext
 *
 * Stored as: fernet:v1:<salt-b64>:<iv-b64>.<hmac-b64>.<ciphertext-b64>
 */

const PBKDF2_ITERATIONS = 390_000;

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKeys(
  seed: string,
  salt: Uint8Array,
): Promise<{ encKey: CryptoKey; macKey: CryptoKey }> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(seed),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  // Derive 64 bytes: first 32 for encryption, last 32 for HMAC
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    512,
  );

  const encKeyBytes = derived.slice(0, 32);
  const macKeyBytes = derived.slice(32, 64);

  const encKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-CBC", false, [
    "encrypt",
    "decrypt",
  ]);
  const macKey = await crypto.subtle.importKey(
    "raw",
    macKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  return { encKey, macKey };
}

/**
 * Encrypt a plaintext string using Fernet-compatible format.
 */
export async function fernetEncrypt(plaintext: string, keySeed: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const { encKey, macKey } = await deriveKeys(keySeed, salt);

  const ptBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, encKey, ptBytes);

  // HMAC over iv + ciphertext
  const macInput = new Uint8Array(iv.length + ciphertext.byteLength);
  macInput.set(iv, 0);
  macInput.set(new Uint8Array(ciphertext), iv.length);
  const hmac = await crypto.subtle.sign("HMAC", macKey, macInput);

  const saltB64 = toBase64Url(salt.buffer);
  const ivB64 = toBase64Url(iv.buffer);
  const hmacB64 = toBase64Url(hmac);
  const ctB64 = toBase64Url(ciphertext);

  return `fernet:v1:${saltB64}:${ivB64}.${hmacB64}.${ctB64}`;
}

/**
 * Decrypt a Fernet-compatible ciphertext string.
 */
export async function fernetDecrypt(token: string, keySeed: string): Promise<string> {
  if (!token.startsWith("fernet:v1:")) {
    throw new Error("Not a fernet:v1 token");
  }

  const parts = token.split(":", 4);
  if (parts.length < 4) throw new Error("Malformed fernet token");

  const saltB64 = parts[2];
  const payload = parts[3]; // iv.hmac.ciphertext

  const dotParts = payload.split(".");
  if (dotParts.length !== 3) throw new Error("Malformed fernet payload");

  const [ivB64, hmacB64, ctB64] = dotParts;

  const salt = fromBase64Url(saltB64);
  const iv = fromBase64Url(ivB64);
  const hmacExpected = fromBase64Url(hmacB64);
  const ciphertext = fromBase64Url(ctB64);

  const { encKey, macKey } = await deriveKeys(keySeed, salt);

  // Verify HMAC
  const macInput = new Uint8Array(iv.length + ciphertext.length);
  macInput.set(iv, 0);
  macInput.set(ciphertext, iv.length);
  const valid = await crypto.subtle.verify("HMAC", macKey, hmacExpected, macInput);
  if (!valid) throw new Error("HMAC verification failed — data may be tampered");

  // Decrypt
  const plainBytes = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, encKey, ciphertext);
  return new TextDecoder().decode(plainBytes);
}
