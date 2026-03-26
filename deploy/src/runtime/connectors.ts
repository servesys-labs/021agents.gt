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
 *     metadata_json   TEXT DEFAULT '{}',
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
    return JSON.stringify({
      error: `Connector '${connectorName}' not connected. Enable it in the portal to authorize access.`,
    });
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
    });

    if (resp.status === 401) {
      // Token may be expired — invalidate cache so next call re-reads from DB
      invalidateToken(orgId, connectorName);
      return JSON.stringify({
        error: `Connector '${connectorName}' token expired. Re-authorize in the portal.`,
      });
    }

    const body = await resp.text();
    return body.slice(0, 10000);
  } catch (err: any) {
    return JSON.stringify({ error: `Connector call failed: ${err.message}` });
  }
}
