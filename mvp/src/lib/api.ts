const BASE = (globalThis as any).__VITE_API_URL ?? "https://api.oneshots.co/api/v1";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("agentos_token");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    localStorage.removeItem("agentos_token");
    window.location.href = "/login";
    throw new ApiError(401, "Unauthorized");
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, body.error || body.message || "Request failed");
  }

  return body as T;
}

/** Public fetch — no auth redirect on 401 */
export async function publicFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || body.message || "Request failed");
  return body as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, data?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  del: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  /** Public GET — no auth header, no 401 redirect */
  public: <T>(path: string) => publicFetch<T>(path),
};
