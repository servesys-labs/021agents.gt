import { env } from "../config/env";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function mapHttpError(status: number, body: any): ApiError {
  const message = String(body?.error ?? body?.message ?? `HTTP ${status}`);
  const code = body?.code ? String(body.code) : undefined;
  return new ApiError(status, message, code);
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit,
  token?: string,
): Promise<T> {
  const res = await fetch(`${env.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw mapHttpError(res.status, json);
  }
  return json as T;
}

