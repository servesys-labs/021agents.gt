/**
 * Secrets Key Rotation Router — re-encrypt all org secrets with a new key.
 *
 * The actual SECRETS_ENCRYPTION_KEY env var must be updated separately via
 * `wrangler secret put SECRETS_ENCRYPTION_KEY`. This endpoint re-encrypts
 * existing data so that the new key can decrypt it.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import type { Env } from "../env";
import { withOrgDb } from "../db/client";
import { fernetEncrypt, fernetDecrypt } from "../logic/fernet";
import { requireRole } from "../middleware/auth";
import type { SecurityEventType } from "../telemetry/events";

export const secretsRotationRoutes = createOpenAPIRouter();

// ── Helpers ─────────────────────────────────────────────────────

function genId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getKeySeed(env: Env): string {
  const key = env.SECRETS_ENCRYPTION_KEY;
  if (!key) throw Object.assign(new Error("SECRETS_ENCRYPTION_KEY is required"), { status: 503 });
  return key;
}

// ── POST /rotate — Re-encrypt all secrets with a new key ────────
const rotateKeysRoute = createRoute({
  method: "post",
  path: "/rotate",
  tags: ["Secrets Rotation"],
  summary: "Re-encrypt all secrets with a new key",
  middleware: [requireRole("admin")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            new_key: z.string().min(16),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Rotation result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403),
  },
});
secretsRotationRoutes.openapi(rotateKeysRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  if (!body.new_key || typeof body.new_key !== "string" || body.new_key.length < 16) {
    return c.json({ error: "new_key is required (minimum 16 characters)" }, 400);
  }

  const oldKey = getKeySeed(c.env);
  const newKey = body.new_key;
  const rotationId = genId();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // 1. The secrets_key_rotations table tracks per-secret rotations
    //    (id BIGSERIAL, secret_id, status, created_at, completed_at).
    //    We insert per-secret rows in step 3 below and track the bulk
    //    rotation via the security_events log at the end.

    // 2. Fetch all secrets for this org (RLS filters by org_id)
    const secrets = await sql`
      SELECT id, name, project_id, env, encrypted_value FROM secrets
    `;

    let reEncrypted = 0;
    let errors = 0;
    const errorDetails: Array<{ name: string; error: string }> = [];

    // 3. Re-encrypt each secret: decrypt with old key, encrypt with new key.
    //    Track each rotation in secrets_key_rotations (schema: id BIGSERIAL,
    //    secret_id TEXT, status, created_at, completed_at).
    for (const secret of secrets) {
      try {
        // Create a pending rotation row for this secret
        await sql`
          INSERT INTO secrets_key_rotations (secret_id, status, created_at)
          VALUES (${secret.id}, 'in_progress', now())
        `;

        const plaintext = await fernetDecrypt(
          String(secret.encrypted_value),
          oldKey,
        );
        const newEncrypted = await fernetEncrypt(plaintext, newKey);

        await sql`
          UPDATE secrets
          SET encrypted_value = ${newEncrypted}, updated_at = now()
          WHERE name = ${secret.name}
            AND project_id = ${secret.project_id}
            AND env = ${secret.env}
        `;

        // Mark rotation completed
        await sql`
          UPDATE secrets_key_rotations
          SET status = 'completed', completed_at = now()
          WHERE secret_id = ${secret.id} AND status = 'in_progress'
        `;
        reEncrypted++;
      } catch (err) {
        // Mark rotation failed
        await sql`
          UPDATE secrets_key_rotations
          SET status = 'failed', completed_at = now()
          WHERE secret_id = ${secret.id} AND status = 'in_progress'
        `.catch(() => {});
        errors++;
        errorDetails.push({
          name: String(secret.name),
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const finalStatus = errors === 0 ? "completed" : "completed_with_errors";

    // 4. Log security event (RLS-enforced)
    try {
      await sql`
        INSERT INTO security_events (org_id, event_type, actor_type, actor_id, severity, details, created_at)
        VALUES (${user.org_id}, ${"secrets.rotated" satisfies SecurityEventType}, ${"user"}, ${user.user_id}, ${"info"},
                ${JSON.stringify({ rotation_id: rotationId, secrets_re_encrypted: reEncrypted, errors })},
                now())
      `;
    } catch {
      // Best effort — don't fail the rotation over logging
    }

    return c.json({
      rotation_id: rotationId,
      secrets_re_encrypted: reEncrypted,
      errors,
      status: finalStatus,
      ...(errors > 0 ? { error_details: errorDetails } : {}),
    });
  });
});

// ── GET /rotations — List key rotation history ──────────────────
const listRotationsRoute = createRoute({
  method: "get",
  path: "/rotations",
  tags: ["Secrets Rotation"],
  summary: "List key rotation history",
  middleware: [requireRole("admin")],
  responses: {
    200: { description: "Rotation history", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 403),
  },
});
secretsRotationRoutes.openapi(listRotationsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows: Record<string, unknown>[] = [];
    try {
      // secrets_key_rotations tracks per-secret rotations. Join with secrets
      // to filter by org (secrets table is RLS-enforced).
      rows = await sql`
        SELECT r.id, r.secret_id, r.status, r.created_at, r.completed_at
        FROM secrets_key_rotations r
        JOIN secrets s ON r.secret_id = s.id
        ORDER BY r.created_at DESC
        LIMIT 50
      `;
    } catch {
      // Table may not exist yet
    }

    return c.json({ rotations: rows });
  });
});
