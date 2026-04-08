function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

export function getTokenExpiryEpochMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { exp?: number };
    if (!payload.exp || typeof payload.exp !== "number") {
      return null;
    }
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

export function getTokenSecondsRemaining(token: string): number | null {
  const expiry = getTokenExpiryEpochMs(token);
  if (!expiry) {
    return null;
  }
  return Math.floor((expiry - Date.now()) / 1000);
}
