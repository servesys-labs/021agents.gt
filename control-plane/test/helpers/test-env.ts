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

/**
 * Build a vi.mock() module factory for `../src/db/client` that forwards
 * every `withOrgDb` / `withAdminDb` call to a shared mock tagged-template
 * sql function. Use this in any route test that used to `vi.mock`
 * `getDb` / `getDbForOrg` — those shims were deleted in the April 2026
 * schema consolidation.
 *
 * Usage at the top of a test file:
 *
 *     import { buildDbClientMock, type MockSqlFn } from "./helpers/test-env";
 *
 *     const mockSql: MockSqlFn = vi.fn(async () => []);
 *     vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));
 *
 * Inside a test body:
 *
 *     (mockSql as any).mockImplementation(async (strings, ...values) => {
 *       const query = strings.join("?");
 *       if (query.includes("SELECT ...")) return [...];
 *       return [];
 *     });
 *
 * The factory dereferences the closure lazily so individual tests can
 * replace `mockSql`'s implementation per-test without resetting the
 * module mock.
 */
export type MockSqlFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<any>;

export function buildDbClientMock(getSql: () => MockSqlFn): Record<string, unknown> {
  const withOrgDb = async (_env: unknown, _orgId: unknown, fn: (sql: any) => Promise<any>) =>
    fn(getSql());
  const withAdminDb = async (_env: unknown, fn: (sql: any) => Promise<any>) =>
    fn(getSql());
  return {
    withOrgDb,
    withAdminDb,
    // Back-compat shims for tests that still call getDb/getDbForOrg.
    // Routes never import these anymore, but some tests still do in
    // unit-test fixtures — forward to the same shared sql.
    getDb: async () => getSql(),
    getDbForOrg: async () => getSql(),
    // Type exports the routes pull in from the same module. Vitest's
    // module mocking replaces the whole module, so we need these to
    // exist even if they're not used inside the route at runtime.
    OrgSql: null,
    AdminSql: null,
    Sql: null,
  };
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
