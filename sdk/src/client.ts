import { AgentsClient } from "./agents";
import { EndUsersClient } from "./end-users";
import { AgentOSError } from "./errors";
import { HttpClient } from "./http";
import type { AgentOSConfig, HealthCheckResult } from "./types";

const DEFAULT_BASE_URL = "https://api.agentos.dev";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Main entry point for the AgentOS SDK.
 *
 * Create a single instance and reuse it across your application.
 *
 * @example
 * ```ts
 * import { AgentOS } from "@agentos/sdk";
 *
 * const client = new AgentOS({ apiKey: "ak_live_..." });
 *
 * const result = await client.agents.run("my-agent", {
 *   input: "Hello!",
 * });
 * console.log(result.output);
 * ```
 */
export class AgentOS {
  /** Client for running agents and managing conversations. */
  readonly agents: AgentsClient;

  /** Client for managing end-user tokens and usage. */
  readonly endUsers: EndUsersClient;

  /** @internal */
  private readonly _http: HttpClient;

  constructor(config: AgentOSConfig) {
    // Validate API key format
    if (!config.apiKey || !config.apiKey.startsWith("ak_")) {
      throw new AgentOSError(
        'Invalid API key — must start with "ak_"',
        0,
        "invalid_api_key",
      );
    }

    const fetchFn = config.fetch ?? globalThis.fetch;
    if (!fetchFn) {
      throw new AgentOSError(
        "No global fetch available. Pass a custom `fetch` implementation in the config (e.g. node-fetch).",
        0,
        "missing_fetch",
      );
    }

    this._http = new HttpClient({
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: config.apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
      fetch: fetchFn.bind(globalThis),
      debug: config.debug,
    });

    this.agents = new AgentsClient(this._http);
    this.endUsers = new EndUsersClient(this._http);
  }

  /**
   * Check the health of the AgentOS API.
   *
   * @returns The current API health status.
   *
   * @example
   * ```ts
   * const health = await client.health();
   * console.log(health.status); // "ok"
   * ```
   */
  async health(): Promise<HealthCheckResult> {
    return this._http.request<HealthCheckResult>("GET", "/v1/health");
  }
}
