import { useCallback, useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "agentos_token";

const BASE_URL = import.meta.env.VITE_API_URL ?? "";

/* ── Token helpers ──────────────────────────────────────────────── */

function isTokenExpired(token: string): boolean {
  try {
    const [, payloadB64] = token.split(".");
    if (!payloadB64) return true;
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp < Math.floor(Date.now() / 1000) : false;
  } catch {
    return true; // Treat malformed tokens as expired
  }
}

export function getStoredToken(): string {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return "";
  if (isTokenExpired(token)) {
    localStorage.removeItem(TOKEN_KEY);
    return "";
  }
  return token;
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/* ── Core fetch ─────────────────────────────────────────────────── */

export class ApiError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function parseErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (!payload || typeof payload !== "object") return fallback;
  const obj = payload as {
    error?: unknown;
    detail?: unknown;
    details?: unknown;
    message?: unknown;
  };
  if (typeof obj.error === "string" && obj.error) return obj.error;
  if (typeof obj.detail === "string" && obj.detail) return obj.detail;
  if (typeof obj.message === "string" && obj.message) return obj.message;
  if (typeof obj.details === "string" && obj.details) return obj.details;
  return fallback;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> | undefined),
  };

  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, { ...opts, headers });

  if (response.status === 401) {
    clearStoredToken();
    window.location.href = "/login";
    throw new ApiError("Unauthorized", 401);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      message = parseErrorMessage(payload, message);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("Expected JSON but received non-JSON payload", response.status || 500);
  }
}

/* ── Method helpers ─────────────────────────────────────────────── */

export function apiGet<T = unknown>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}

export function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function apiPut<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function apiDelete<T = unknown>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

/* ── useApiQuery hook ───────────────────────────────────────────── */

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
      const result = await apiGet<T>(path);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown API error");
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

  return useMemo(() => ({ data, loading, error, refetch: run }), [data, loading, error, run]);
}

/* ── useApiMutation hook ────────────────────────────────────────── */

export type UseApiMutationResult<TResponse, TBody = unknown> = {
  mutate: (body?: TBody) => Promise<TResponse>;
  data: TResponse | null;
  loading: boolean;
  error: string | null;
  reset: () => void;
};

/* ── Backward-compatible aliases ────────────────────────────────── */
/* Many existing pages import these names; keep them working.       */

export const getToken = getStoredToken;

export async function apiRequest<TResponse>(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<TResponse> {
  return apiFetch<TResponse>(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function apiUpload<TResponse>(
  path: string,
  formData: FormData,
): Promise<TResponse> {
  const token = getStoredToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (response.status === 401) {
    clearStoredToken();
    window.location.href = "/login";
    throw new ApiError("Unauthorized", 401);
  }

  if (!response.ok) {
    let message = `Upload failed (${response.status})`;
    try {
      const payload = await response.json();
      message = parseErrorMessage(payload, message);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as unknown as TResponse;

  try {
    return (await response.json()) as TResponse;
  } catch {
    return undefined as unknown as TResponse;
  }
}

/* ── useApiMutation hook ────────────────────────────────────────── */

export function useApiMutation<TResponse, TBody = unknown>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): UseApiMutationResult<TResponse, TBody> {
  const [data, setData] = useState<TResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (body?: TBody): Promise<TResponse> => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiFetch<TResponse>(path, {
          method,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        setData(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown API error";
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [path, method],
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return useMemo(() => ({ mutate, data, loading, error, reset }), [mutate, data, loading, error, reset]);
}
