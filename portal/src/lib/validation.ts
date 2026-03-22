export function isRequired(value: string): boolean {
  return value.trim().length > 0;
}

export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isPositiveInteger(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  return Number(value) > 0;
}

export function parseScopes(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
