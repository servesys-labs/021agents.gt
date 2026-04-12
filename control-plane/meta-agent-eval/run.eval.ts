// Meta-agent eval harness runner.
//
// Invoked by `pnpm --filter control-plane eval` via the separate
// vitest.config.ts in this directory. Each fixture becomes one
// `it.each` case that:
//
//   1. Spins up a fresh seeded universe mock (shared seed data)
//   2. Calls the real runMetaChat end-to-end with Gemma via the AI Gateway
//   3. Runs L1 rule-based invariant checks on the trace
//   4. Calls the L2 Gemma judge on the trimmed trace
//   5. Asserts both L1 pass AND judge average >= fixture.min_judge_score
//
// Auto-skips the whole suite when the AI Gateway credentials aren't in
// env — local devs without staging access get a gentle skip rather than
// a wall of 401s. CI is expected to provide the vars explicitly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { buildEvalDbClientMock, type MockSqlFn } from "./fixtures/universe";

// ── .env auto-loading ───────────────────────────────────────────────
// Gateway credentials live in the repo-root .env by convention. Try a
// couple of candidate paths and load the first one that exists. Uses
// Node's native process.loadEnvFile() — no dotenv dependency. Silently
// no-ops if nothing found; the env-check below will surface the
// problem with a clear message.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../.env"),    // <repo>/.env from meta-agent-eval/
    resolve(here, "../.env"),       // control-plane/.env fallback
    resolve(process.cwd(), ".env"), // CWD fallback
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        // @ts-expect-error — process.loadEnvFile is stable in Node 22+
        process.loadEnvFile(path);
        break;
      } catch {
        // unreadable / malformed — try next candidate
      }
    }
  }
}

// ── Stateful shared SQL mock ────────────────────────────────────────
// The `let mockSql` indirection is required because vi.mock() is
// hoisted to the top of the file and needs a reference that survives
// module-load ordering. Each fixture beforeEach() swaps in a fresh
// universe instance.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;
vi.mock("../src/db/client", () => buildEvalDbClientMock(() => mockSql));

// ── Post-mock imports ───────────────────────────────────────────────
// These MUST come after the vi.mock call. Vitest hoists vi.mock() to
// the top of the module regardless of source order, so these imports
// resolve against the mocked db/client.
import { runMetaChat, type MetaChatMessage } from "../src/logic/meta-agent-chat";
import { createUniverseSqlMock } from "./fixtures/universe";
import { FIXTURES, type EvalFixture } from "./fixtures/inputs";
import { summarizeTrace, runL1Checks } from "./l1-checks";
import { judgeTrace } from "./l2-judge";

// ── Environment ─────────────────────────────────────────────────────

interface GatewayEnv {
  cloudflareAccountId: string;
  aiGatewayId: string;
  aiGatewayToken: string;
  gpuServiceKey: string;
}

function readGatewayEnv(): GatewayEnv | null {
  const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const aiGatewayId = process.env.AI_GATEWAY_ID;
  const aiGatewayToken = process.env.AI_GATEWAY_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  const gpuServiceKey = process.env.GPU_SERVICE_KEY ?? process.env.SERVICE_TOKEN ?? "";
  if (!cloudflareAccountId || !aiGatewayId || !gpuServiceKey) return null;
  return { cloudflareAccountId, aiGatewayId, aiGatewayToken, gpuServiceKey };
}

const gatewayEnv = readGatewayEnv();
const skipReason = gatewayEnv
  ? null
  : "missing Gateway env — set CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID, and GPU_SERVICE_KEY (or SERVICE_TOKEN) to run the meta-agent eval";

if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(`[meta-agent-eval] skipping: ${skipReason}`);
}

// ── The suite ───────────────────────────────────────────────────────

describe.skipIf(!gatewayEnv)("meta-agent eval harness", () => {
  beforeEach(() => {
    const { sql } = createUniverseSqlMock();
    mockSql = sql;
  });

  it.each(FIXTURES.map((f) => [f.id, f] as const))(
    "fixture: %s",
    async (_id: string, fixture: EvalFixture) => {
      const env = gatewayEnv!;

      // Build a MetaChatContext structurally — the interface is not
      // exported, so we assemble a plain object that matches the shape
      // consumed by runMetaChat. Hyperdrive is passed through to
      // withOrgDb which is mocked, so {} works.
      const ctx = {
        agentName: fixture.agent_name,
        orgId: "eval-org",
        userId: "eval-user",
        userRole: "owner",
        hyperdrive: {} as unknown,
        openrouterApiKey: "",
        cloudflareAccountId: env.cloudflareAccountId,
        aiGatewayId: env.aiGatewayId,
        cloudflareApiToken: env.aiGatewayToken,
        aiGatewayToken: env.aiGatewayToken,
        gpuServiceKey: env.gpuServiceKey,
        // Force the Gemma path unconditionally — the whole reason this
        // harness exists is to grade the production gemma-4-31b path.
        modelPath: "gemma" as const,
        mode: fixture.mode,
        env: {
          RUNTIME: undefined,
          SERVICE_TOKEN: env.gpuServiceKey,
          JOB_QUEUE: { send: async () => {} },
        },
      };

      const messages: MetaChatMessage[] = [
        { role: "user", content: fixture.user_message },
      ];

      const result = await runMetaChat(messages, ctx as Parameters<typeof runMetaChat>[1]);

      const summary = summarizeTrace(result.messages, {
        cost_usd: result.cost_usd,
        turns: result.turns,
      });

      const l1 = runL1Checks(fixture, summary);
      if (!l1.passed) {
        // eslint-disable-next-line no-console
        console.error(`[${fixture.id}] L1 failures:`, l1.failures);
        // eslint-disable-next-line no-console
        console.error(`[${fixture.id}] final response:`, summary.final_response.slice(0, 300));
      }
      expect(l1.passed, `L1 failed: ${l1.failures.join("; ")}`).toBe(true);

      const judge = await judgeTrace(
        {
          cloudflareAccountId: env.cloudflareAccountId,
          aiGatewayId: env.aiGatewayId,
          aiGatewayToken: env.aiGatewayToken,
          cloudflareApiToken: env.aiGatewayToken,
          gpuServiceKey: env.gpuServiceKey,
        },
        fixture.user_message,
        fixture.judge_expected_behavior,
        summary,
        fixture.judge_model,
      );

      // eslint-disable-next-line no-console
      console.log(
        `[${fixture.id}] judge (${judge.judge_model}): avg=${judge.average.toFixed(2)} ` +
        `correctness=${judge.scores.correctness} relevance=${judge.scores.relevance} ` +
        `tool_selection=${judge.scores.tool_selection} — ${judge.scores.notes}`,
      );

      expect(
        judge.average,
        `judge average ${judge.average.toFixed(2)} < min ${fixture.min_judge_score}`,
      ).toBeGreaterThanOrEqual(fixture.min_judge_score);
    },
  );
});
