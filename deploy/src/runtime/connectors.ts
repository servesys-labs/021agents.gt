/**
 * Edge Runtime — Connector OAuth Token Management.
 *
 * Reads OAuth tokens from Supabase (connector_tokens table).
 * Portal writes tokens after OAuth flow completes.
 * Edge reads them when a connector tool fires.
 *
 * Token lifecycle:
 *   1. User enables connector in portal → OAuth flow → portal writes token to Supabase
 *   2. Agent invokes connector tool → edge reads token from Supabase via Hyperdrive
 *   3. Token cached in session for subsequent calls
 *   4. On 401 → re-read from Supabase (portal may have refreshed)
 *   5. Revocation → delete from Supabase, next call fails gracefully
 *
 * Table schema (create in Supabase):
 *   CREATE TABLE connector_tokens (
 *     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     org_id          TEXT NOT NULL,
 *     connector_name  TEXT NOT NULL,
 *     access_token    TEXT NOT NULL,
 *     refresh_token   TEXT DEFAULT '',
 *     token_type      TEXT DEFAULT 'Bearer',
 *     expires_at      TIMESTAMPTZ,
 *     scopes          TEXT DEFAULT '',
 *     metadata   TEXT DEFAULT '{}',
 *     created_at      TIMESTAMPTZ DEFAULT NOW(),
 *     updated_at      TIMESTAMPTZ DEFAULT NOW(),
 *     UNIQUE(org_id, connector_name)
 *   );
 */

export interface ConnectorToken {
  connector_name: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number | null;
  scopes: string;
}

function connectorError(
  code: string,
  message: string,
  opts?: { retryable?: boolean; status?: number; detail?: string },
): string {
  return JSON.stringify({
    error: message,
    code,
    retryable: opts?.retryable === true,
    status: opts?.status || 0,
    detail: opts?.detail || "",
  });
}

// Session-scoped token cache
const tokenCache = new Map<string, ConnectorToken>();

/**
 * Get an OAuth token for a connector.
 * Checks cache first, then reads from Supabase.
 */
export async function getConnectorToken(
  hyperdrive: Hyperdrive,
  orgId: string,
  connectorName: string,
): Promise<ConnectorToken | null> {
  const cacheKey = `${orgId}:${connectorName}`;

  // Check cache
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    // Check if expired
    if (cached.expires_at && Date.now() > cached.expires_at) {
      tokenCache.delete(cacheKey);
    } else {
      return cached;
    }
  }

  // Read from Supabase
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);

  try {
    const rows = await sql`
      SELECT connector_name, access_token, refresh_token, token_type,
             expires_at, scopes
      FROM connector_tokens
      WHERE org_id = ${orgId} AND connector_name = ${connectorName}
      LIMIT 1
    `;

    if (rows.length === 0) return null;

    const row = rows[0];
    const token: ConnectorToken = {
      connector_name: row.connector_name,
      access_token: row.access_token || "",
      refresh_token: row.refresh_token || "",
      token_type: row.token_type || "Bearer",
      expires_at: row.expires_at ? new Date(row.expires_at).getTime() : null,
      scopes: row.scopes || "",
    };

    // Cache for session
    tokenCache.set(cacheKey, token);
    return token;
  } catch {
    // Table may not exist yet
    return null;
  }
}

/**
 * Invalidate a cached token (e.g., after a 401).
 * Next call will re-read from Supabase.
 */
export function invalidateToken(orgId: string, connectorName: string): void {
  tokenCache.delete(`${orgId}:${connectorName}`);
}

/**
 * Execute a connector tool call using the stored OAuth token.
 * Makes the actual HTTP call to the connector's API endpoint.
 */
export async function executeConnector(
  hyperdrive: Hyperdrive,
  orgId: string,
  connectorName: string,
  toolName: string,
  args: Record<string, any>,
): Promise<string> {
  const token = await getConnectorToken(hyperdrive, orgId, connectorName);
  if (!token) {
    return connectorError(
      "CONNECTOR_NOT_CONNECTED",
      `Connector '${connectorName}' not connected. Enable it in the portal to authorize access.`,
      { retryable: false, status: 401 },
    );
  }

  // Pipedream MCP endpoint pattern
  const endpoint = `https://api.pipedream.com/v1/connect/${connectorName}/${toolName}`;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `${token.token_type} ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.status === 401) {
      // Token may be expired — invalidate cache so next call re-reads from DB
      invalidateToken(orgId, connectorName);
      return connectorError(
        "CONNECTOR_TOKEN_EXPIRED",
        `Connector '${connectorName}' token expired. Re-authorize in the portal.`,
        { retryable: false, status: 401 },
      );
    }

    if (!resp.ok) {
      const body = await resp.text();
      return connectorError(
        "CONNECTOR_CALL_FAILED",
        `Connector '${connectorName}' call failed`,
        {
          retryable: resp.status >= 500 || resp.status === 429,
          status: resp.status,
          detail: body.slice(0, 400),
        },
      );
    }

    const body = await resp.text();
    return body.slice(0, 10000);
  } catch (err: any) {
    return connectorError(
      "CONNECTOR_NETWORK_ERROR",
      `Connector call failed: ${err.message || err}`,
      { retryable: true, status: 0, detail: String(err?.message || err).slice(0, 400) },
    );
  }
}
