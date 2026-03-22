import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuthToken } from "../auth/tokens";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string {
  return getAuthToken();
}

export async function apiRequest<TResponse>(
  path: string,
  method: HttpMethod = "GET",
  body?: unknown,
): Promise<TResponse> {
  const token = getToken();
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: string; message?: string };
      message = payload.detail ?? payload.message ?? message;
    } catch {
      // Keep generic fallback when non-JSON.
    }
    throw new ApiError(message, response.status);
  }

  try {
    return (await response.json()) as TResponse;
  } catch {
    throw new ApiError(
      "Expected JSON response but received a non-JSON payload. Verify the API path/proxy.",
      response.status || 500,
    );
  }
}

export type UseApiQueryResult<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

export function useApiQuery<T>(path: string, enabled = true): UseApiQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextData = await apiRequest<T>(path);
      setData(nextData);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown API error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void run();
  }, [enabled, run]);

  return useMemo(
    () => ({
      data,
      loading,
      error,
      refetch: run,
    }),
    [data, loading, error, run],
  );
}
