export function logInfo(event: string, data?: Record<string, unknown>) {
  console.info(`[mobile:${event}]`, data ?? {});
}

export function logError(event: string, error: unknown, data?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mobile:${event}]`, { message, ...(data ?? {}) });
}

