import type { HttpClient } from "./http";
import type {
  EndUserToken,
  EndUserTokenOptions,
  EndUserUsage,
} from "./types";

/**
 * Client for managing end-user tokens and usage.
 *
 * End-user tokens allow SaaS platforms to issue scoped, rate-limited tokens
 * to their own users, enabling secure multi-tenant access to agents.
 *
 * Access via `client.endUsers`.
 *
 * @example
 * ```ts
 * const token = await client.endUsers.createToken({
 *   endUserId: "user_123",
 *   allowedAgents: ["support-bot"],
 *   expiresInSeconds: 3600,
 * });
 * // Hand `token.token` to your end-user's frontend
 * ```
 */
export class EndUsersClient {
  /** @internal */
  constructor(private readonly _http: HttpClient) {}

  /**
   * Create a scoped token for an end-user.
   *
   * @param options - Token configuration including user ID, allowed agents, and rate limits.
   * @returns The newly created token.
   */
  async createToken(options: EndUserTokenOptions): Promise<EndUserToken> {
    return this._http.request<EndUserToken>("POST", "/api/v1/end-user-tokens", {
      end_user_id: options.endUserId,
      allowed_agents: options.allowedAgents,
      expires_in_seconds: options.expiresInSeconds,
      rate_limit_rpm: options.rateLimitRpm,
      rate_limit_rpd: options.rateLimitRpd,
    });
  }

  /**
   * List all active end-user tokens.
   *
   * @returns An array of active tokens.
   */
  async listTokens(): Promise<EndUserToken[]> {
    return this._http.request<EndUserToken[]>("GET", "/api/v1/end-user-tokens");
  }

  /**
   * Revoke an end-user token.
   *
   * @param tokenId - The token ID to revoke.
   */
  async revokeToken(tokenId: string): Promise<void> {
    await this._http.request<void>(
      "DELETE",
      `/api/v1/end-user-tokens/${encodeURIComponent(tokenId)}`,
    );
  }

  /**
   * Get usage statistics for a specific end-user.
   *
   * @param endUserId - The end-user's identifier.
   * @returns Aggregated usage data including per-agent breakdowns.
   */
  async getUsage(endUserId: string): Promise<EndUserUsage> {
    return this._http.request<EndUserUsage>(
      "GET",
      `/api/v1/end-user-tokens/usage/${encodeURIComponent(endUserId)}`,
    );
  }
}
