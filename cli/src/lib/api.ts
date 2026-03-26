/**
 * API client for AgentOS control-plane
 */
import fetch from "node-fetch";
import { getConfig, requireAuth } from "./config.js";

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = "APIError";
  }
}

function getHeaders(auth = true): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "AgentOS-CLI/0.2.0",
  };

  if (auth) {
    const authConfig = requireAuth();
    headers["Authorization"] = `Bearer ${authConfig.token}`;
  }

  return headers;
}

export async function apiGet<T>(path: string, auth = true): Promise<T> {
  const config = getConfig();
  const url = `${config.apiUrl}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: getHeaders(auth),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new APIError(
      error || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  auth = true
): Promise<T> {
  const config = getConfig();
  const url = `${config.apiUrl}${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(auth),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new APIError(
      error || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function apiPut<T>(
  path: string,
  body: unknown,
  auth = true
): Promise<T> {
  const config = getConfig();
  const url = `${config.apiUrl}${path}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: getHeaders(auth),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new APIError(
      error || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function apiPatch<T>(
  path: string,
  body: unknown,
  auth = true
): Promise<T> {
  const config = getConfig();
  const url = `${config.apiUrl}${path}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: getHeaders(auth),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new APIError(
      error || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function apiDelete<T>(path: string, auth = true): Promise<T> {
  const config = getConfig();
  const url = `${config.apiUrl}${path}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: getHeaders(auth),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new APIError(
      error || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

// Streaming API for agent run
export async function* apiStream(
  path: string,
  bodyData: unknown,
  auth = true
): AsyncGenerator<string> {
  const config = getConfig();
  const url = `${config.apiUrl}${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(auth),
    body: JSON.stringify(bodyData),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new APIError(
      error || `HTTP ${response.status}`,
      response.status
    );
  }

  if (!response.body) {
    return;
  }

  // Handle web streams
  const stream = response.body as unknown as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}
