import { AgentOSError, AgentOSAuthError, AgentOSTimeoutError } from "./errors";
import type { StreamEvent } from "./types";

// ---------------------------------------------------------------------------
// snake_case → camelCase deep transformer (API → SDK boundary)
// ---------------------------------------------------------------------------

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function transformKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(transformKeys);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[snakeToCamel(key)] = transformKeys(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal HTTP client used by all resource clients
// ---------------------------------------------------------------------------

/** @internal */
export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout: number;
  fetch: typeof globalThis.fetch;
  /** When true, log all requests and responses to the console. */
  debug?: boolean;
}

/** @internal */
export class HttpClient {
  private readonly _baseUrl: string;
  private readonly _apiKey: string;
  private readonly _timeout: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _debug: boolean;

  constructor(config: HttpClientConfig) {
    this._baseUrl = config.baseUrl.replace(/\/+$/, "");
    this._apiKey = config.apiKey;
    this._timeout = config.timeout;
    this._fetch = config.fetch;
    this._debug = config.debug ?? false;
  }

  // -----------------------------------------------------------------------
  // Public helpers
  // -----------------------------------------------------------------------

  /** Perform a JSON request and return the parsed body. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = this._buildUrl(path, query);
    const headers = this._headers(body !== undefined);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      this._debugLog("request", method, url, body);

      const res = await this._fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        await this._throwApiError(res);
      }

      // 204 No Content — return undefined cast as T
      if (res.status === 204) {
        this._debugLog("response", method, url, 204, undefined);
        return undefined as T;
      }

      const json = await res.json();
      this._debugLog("response", method, url, res.status, json);
      return transformKeys(json) as T;
    } catch (err) {
      if (err instanceof AgentOSError) throw err;
      if (this._isAbortError(err)) throw new AgentOSTimeoutError(this._timeout);
      throw new AgentOSError(
        (err as Error).message ?? "Unknown network error",
        0,
        "network_error",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a multipart form-data request and return the parsed body. */
  async requestMultipart<T>(path: string, form: FormData): Promise<T> {
    const url = this._buildUrl(path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
      "User-Agent": "@oneshots/sdk 0.1.0",
      // Note: Content-Type is intentionally omitted — the browser/runtime
      // sets it automatically with the correct multipart boundary.
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      this._debugLog("request", "POST (multipart)", url, "[FormData]");

      const res = await this._fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal,
      });

      if (!res.ok) {
        await this._throwApiError(res);
      }

      if (res.status === 204) {
        this._debugLog("response", "POST (multipart)", url, 204, undefined);
        return undefined as T;
      }

      const json = await res.json();
      this._debugLog("response", "POST (multipart)", url, res.status, json);
      return transformKeys(json) as T;
    } catch (err) {
      if (err instanceof AgentOSError) throw err;
      if (this._isAbortError(err)) throw new AgentOSTimeoutError(this._timeout);
      throw new AgentOSError(
        (err as Error).message ?? "Unknown network error",
        0,
        "network_error",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform an SSE streaming request and yield parsed {@link StreamEvent} objects.
   *
   * Uses raw `fetch` + manual line-based SSE parsing so we avoid any
   * dependency on `EventSource` (which requires a GET and cannot send a body).
   *
   * @param path   - API path.
   * @param body   - Request body (JSON-serialisable).
   * @param signal - Optional AbortSignal for cancellation.
   */
  async *stream(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const url = this._buildUrl(path);
    const headers: Record<string, string> = {
      ...this._headers(true),
      Accept: "text/event-stream",
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    // If the caller provides an AbortSignal, forward its abort to our controller
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    this._debugLog("request", "POST (stream)", url, body);

    let res: Response;
    try {
      res = await this._fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (this._isAbortError(err)) throw new AgentOSTimeoutError(this._timeout);
      throw new AgentOSError(
        (err as Error).message ?? "Unknown network error",
        0,
        "network_error",
      );
    }

    if (!res.ok) {
      clearTimeout(timer);
      await this._throwApiError(res);
    }

    try {
      yield* this._parseSSE(res);
    } finally {
      clearTimeout(timer);
      // Ensure the connection is released even if the consumer breaks early
      controller.abort();
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private _buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${this._baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private _headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
      "User-Agent": "@oneshots/sdk 0.1.0",
    };
    if (hasBody) {
      h["Content-Type"] = "application/json";
    }
    return h;
  }

  private async _throwApiError(res: Response): Promise<never> {
    let message = `API error: ${res.status} ${res.statusText}`;
    let code = "api_error";

    try {
      const body = (await res.json()) as { error?: string; code?: string; message?: string };
      message = body.message ?? body.error ?? message;
      code = body.code ?? code;
    } catch {
      // Body may not be JSON — use defaults
    }

    if (res.status === 401) {
      throw new AgentOSAuthError(message);
    }

    throw new AgentOSError(message, res.status, code);
  }

  /**
   * Parse an SSE response body into a sequence of {@link StreamEvent}.
   *
   * Handles the standard SSE format:
   * ```
   * event: <type>
   * data: <json>
   *
   * ```
   */
  private async *_parseSSE(
    res: Response,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const reader = res.body?.getReader();
    if (!reader) {
      throw new AgentOSError("Response body is not readable", 0, "stream_error");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData += line.slice(5).trim();
          } else if (line === "") {
            // Blank line = end of event
            if (currentData) {
              const event = this._parseStreamEvent(currentEvent, currentData);
              if (event) yield event;
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }

      // Flush any remaining event
      if (currentData) {
        const event = this._parseStreamEvent(currentEvent, currentData);
        if (event) yield event;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private _parseStreamEvent(
    _eventType: string,
    data: string,
  ): StreamEvent | null {
    try {
      const raw = JSON.parse(data);
      return transformKeys(raw) as StreamEvent;
    } catch {
      // Malformed JSON — skip this event
      return null;
    }
  }

  private _isAbortError(err: unknown): boolean {
    return (
      err instanceof DOMException && err.name === "AbortError" ||
      (err as Error)?.name === "AbortError"
    );
  }

  /** Log debug information to the console when debug mode is enabled. */
  private _debugLog(
    direction: "request" | "response",
    method: string,
    url: string,
    statusOrBody?: unknown,
    responseBody?: unknown,
  ): void {
    if (!this._debug) return;

    if (direction === "request") {
      // eslint-disable-next-line no-console
      console.debug(`[AgentOS] -> ${method} ${url}`, statusOrBody ?? "");
    } else {
      // eslint-disable-next-line no-console
      console.debug(`[AgentOS] <- ${method} ${url} ${statusOrBody}`, responseBody ?? "");
    }
  }
}
