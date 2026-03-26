/**
 * Test environment helpers — mock Env bindings, DB, and auth tokens.
 *
 * These helpers allow testing route handlers without a real CF Workers
 * runtime or Hyperdrive connection.
 */

import type { Env } from "../../src/env";

/** JWT secret shared across all tests. */
export const TEST_JWT_SECRET = "test-secret-for-unit-tests-only";

/** Create a mock Env with all bindings stubbed. */
export function mockEnv(overrides?: Partial<Env>): Env {
  return {
    HYPERDRIVE: null as any, // tests that hit DB must provide their own
    AI: { run: async () => ({ response: "" }) } as any,
    STORAGE: mockR2Bucket(),
    VECTORIZE: { query: async () => ({ matches: [] }), insert: async () => ({}) } as any,
    RUNTIME: mockFetcher(),
    WORKFLOWS: mockFetcher(),
    JOB_QUEUE: { send: async () => {} } as any,
    AUTH_JWT_SECRET: TEST_JWT_SECRET,
    OPENROUTER_API_KEY: "test-key",
    AI_GATEWAY_ID: "test-gw",
    AI_GATEWAY_TOKEN: "test-gw-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
    SERVICE_TOKEN: "test-service-token",
    RUNTIME_WORKER_URL: "https://agentos.test.workers.dev",
    APPROVAL_WORKFLOWS_ENABLED: "false",
    ...overrides,
  };
}

/** Mock R2Bucket that stores in memory. */
export function mockR2Bucket(): R2Bucket {
  const store = new Map<string, { body: string; metadata?: Record<string, string> }>();
  return {
    put: async (key: string, value: any) => {
      store.set(key, { body: typeof value === "string" ? value : JSON.stringify(value) });
      return {} as any;
    },
    get: async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        text: async () => entry.body,
        json: async () => JSON.parse(entry.body),
        body: entry.body,
      } as any;
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key }));
      return { objects, truncated: false } as any;
    },
    delete: async (key: string) => { store.delete(key); },
    head: async () => null,
    createMultipartUpload: async () => ({}) as any,
    resumeMultipartUpload: async () => ({}) as any,
  } as any;
}

/** Mock Fetcher (Service Binding) that returns configurable responses. */
export function mockFetcher(
  handler?: (req: Request) => Promise<Response>,
): Fetcher {
  const defaultHandler = async (req: Request) =>
    new Response(JSON.stringify({ ok: true, proxied: true }), {
      headers: { "Content-Type": "application/json" },
    });
  return {
    fetch: handler ?? defaultHandler,
    connect: () => { throw new Error("connect not implemented in mock"); },
  } as any;
}

/** Create a signed JWT for testing. */
export async function createTestToken(
  userId: string,
  opts: { email?: string; orgId?: string; role?: string } = {},
): Promise<string> {
  const { createToken } = await import("../../src/auth/jwt");
  return createToken(TEST_JWT_SECRET, userId, {
    email: opts.email ?? `${userId}@test.com`,
    org_id: opts.orgId ?? "test-org",
    extra: { role: opts.role ?? "admin" },
  });
}

/** Auth header for a test user. */
export async function authHeader(
  userId: string,
  opts: { email?: string; orgId?: string; role?: string } = {},
): Promise<Record<string, string>> {
  const token = await createTestToken(userId, opts);
  return { Authorization: `Bearer ${token}` };
}
