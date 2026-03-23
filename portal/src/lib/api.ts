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

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as unknown as TResponse;
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

/* ── Upload helper (multipart/form-data) ─────────────────────── */

export async function apiUpload<TResponse>(
  path: string,
  formData: FormData,
): Promise<TResponse> {
  const token = getToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!response.ok) {
    let message = `Upload failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: string; message?: string };
      message = payload.detail ?? payload.message ?? message;
    } catch {
      // Keep generic fallback.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as unknown as TResponse;
  }

  try {
    return (await response.json()) as TResponse;
  } catch {
    return undefined as unknown as TResponse;
  }
}

/* ── useApiQuery (GET) ───────────────────────────────────────── */

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
    () => ({ data, loading, error, refetch: run }),
    [data, loading, error, run],
  );
}

/* ── useApiMutation (POST / PUT / PATCH / DELETE) ────────────── */

export type UseApiMutationResult<TResponse, TBody = unknown> = {
  mutate: (body?: TBody) => Promise<TResponse>;
  data: TResponse | null;
  loading: boolean;
  error: string | null;
  reset: () => void;
};

export function useApiMutation<TResponse, TBody = unknown>(
  path: string,
  method: HttpMethod = "POST",
): UseApiMutationResult<TResponse, TBody> {
  const [data, setData] = useState<TResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (body?: TBody): Promise<TResponse> => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiRequest<TResponse>(path, method, body);
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

  return useMemo(
    () => ({ mutate, data, loading, error, reset }),
    [mutate, data, loading, error, reset],
  );
}

/* ── useApiUpload (multipart) ────────────────────────────────── */

export type UseApiUploadResult<TResponse> = {
  upload: (formData: FormData) => Promise<TResponse>;
  data: TResponse | null;
  loading: boolean;
  error: string | null;
};

export function useApiUpload<TResponse>(
  path: string,
): UseApiUploadResult<TResponse> {
  const [data, setData] = useState<TResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (formData: FormData): Promise<TResponse> => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiUpload<TResponse>(path, formData);
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
    [path],
  );

  return useMemo(
    () => ({ upload, data, loading, error }),
    [upload, data, loading, error],
  );
}
