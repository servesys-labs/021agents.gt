/**
 * PBKDF2-HMAC-SHA256 password hashing.
 *
 * Compatible with Python backend format:
 *   salt = os.urandom(16).hex()  # 32-char hex string
 *   hash = pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
 *   stored = f"{salt}:{hash}"
 *
 * Key detail: Python encodes the HEX STRING as salt bytes (not raw bytes).
 * So a 16-byte random value becomes a 32-char hex string, which is then
 * encoded as UTF-8 (32 bytes) for PBKDF2 input.
 *
 * Iterations: 100,000 for new hashes (fits CF Workers CPU budget).
 * Verification: tries 100k first, falls back to 600k for legacy Python hashes.
 */

// New hashes: 100k iterations (CF Workers CPU-safe, OWASP minimum)
const NEW_ITERATIONS = 100_000;
// Legacy Python hashes used 600k
const LEGACY_ITERATIONS = 600_000;
const KEY_LENGTH = 32; // bytes

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive PBKDF2 hash — matches Python's pbkdf2_hmac("sha256", pw.encode(), salt_hex.encode(), iters)
 * Note: salt is the HEX STRING encoded as UTF-8, not raw bytes.
 */
async function deriveKey(password: string, saltHex: string, iterations: number): Promise<string> {
  // Python does: salt.encode() where salt is a hex string → UTF-8 bytes of the hex string
  const saltBytes = new TextEncoder().encode(saltHex);
  const passwordBytes = new TextEncoder().encode(password);

  const key = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    KEY_LENGTH * 8,
  );
  return bufToHex(derived);
}

/**
 * Hash a new password. Format: "{salt_hex}:{hash_hex}"
 * Uses 100k iterations (safe for CF Workers).
 */
export async function hashPassword(password: string): Promise<string> {
  // Generate 16 random bytes, convert to hex string (32 chars) — matches Python format
  const saltRaw = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bufToHex(saltRaw.buffer as ArrayBuffer);
  const hashHex = await deriveKey(password, saltHex, NEW_ITERATIONS);
  return `${saltHex}:${hashHex}`;
}

/**
 * Verify a password against a stored hash.
 * Tries current iterations first (100k), then legacy (600k) for Python-era hashes.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const colonIdx = stored.indexOf(":");
  if (colonIdx < 0) return false;

  const saltHex = stored.slice(0, colonIdx);
  const expectedHash = stored.slice(colonIdx + 1);
  if (!saltHex || !expectedHash) return false;

  // Try current iterations first (fast path)
  try {
    const hash100k = await deriveKey(password, saltHex, NEW_ITERATIONS);
    if (constantTimeEqual(hash100k, expectedHash)) return true;
  } catch {
    // derivation failed — try legacy
  }

  // Try legacy 600k iterations (Python-era hashes)
  // This is slow on Workers but only happens once per legacy user login
  try {
    const hash600k = await deriveKey(password, saltHex, LEGACY_ITERATIONS);
    if (constantTimeEqual(hash600k, expectedHash)) return true;
  } catch {
    // CPU limit may be exceeded — return false
  }

  return false;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
