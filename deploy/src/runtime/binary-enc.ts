/**
 * Chunked UTF-16 binary string → base64 (avoids stack limits from huge spreads).
 */
export function uint8ArrayToBase64(bytes: Uint8Array, maxBytes = 50_000_000): string {
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Payload exceeds maxBytes (${maxBytes})`);
  }
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(""));
}
