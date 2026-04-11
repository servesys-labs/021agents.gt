import { describe, expect, it } from "vitest";

import { selectModel, type PlanRouting } from "../src/runtime/router";

describe("hybrid routing fallback", () => {
  it("falls back from Kimi route when complex canary is disabled", async () => {
    const routing: PlanRouting = {
      general: {
        complex: {
          model: "@cf/moonshotai/kimi-k2.5",
          provider: "workers-ai",
          fallback: [
            { model: "gemma-4-31b", provider: "custom-gemma4-local" },
            { model: "gemma-4-26b-moe", provider: "custom-gemma4-fast" },
          ],
        },
      },
    };

    const route = await selectModel(
      "Please compare architectural trade-offs and provide a deep analysis.",
      routing,
      "gemma-4-26b-moe",
      "custom-gemma4-fast",
      {
        __orgId: "org-disabled",
        AGENT_PROGRESS_KV: {
          get: async () => null,
        },
      } as any,
    );

    expect(route.model).toBe("gemma-4-31b");
    expect(route.provider).toBe("custom-gemma4-local");
    expect(route.fallback_chain?.length).toBe(1);
    expect(route.fallback_chain?.[0]?.model).toBe("gemma-4-26b-moe");
  });

  it("keeps Kimi route when complex canary is enabled", async () => {
    const routing: PlanRouting = {
      general: {
        complex: {
          model: "@cf/moonshotai/kimi-k2.5",
          provider: "workers-ai",
          fallback: [
            { model: "gemma-4-31b", provider: "custom-gemma4-local" },
            { model: "gemma-4-26b-moe", provider: "custom-gemma4-fast" },
          ],
        },
      },
    };
    const env = {
      AGENT_PROGRESS_KV: {
        get: async (key: string) => {
          if (key === "features-version/org-canary") return "1";
          if (key === "features/org-canary") return JSON.stringify({ kimi_complex_canary: true });
          return null;
        },
      },
      __orgId: "org-canary",
    } as any;

    const route = await selectModel(
      "Please compare architectural trade-offs and provide a deep analysis.",
      routing,
      "gemma-4-26b-moe",
      "custom-gemma4-fast",
      env,
    );

    expect(route.model).toBe("@cf/moonshotai/kimi-k2.5");
    expect(route.provider).toBe("workers-ai");
    expect(route.fallback_chain?.length).toBe(2);
    expect(route.fallback_chain?.[0]?.model).toBe("gemma-4-31b");
  });

  it("returns empty fallback_chain when no route fallback exists", async () => {
    const routing: PlanRouting = {
      general: {
        simple: { model: "gemma-4-26b-moe", provider: "custom-gemma4-fast" },
      },
    };

    const route = await selectModel(
      "hello",
      routing,
      "gemma-4-26b-moe",
      "custom-gemma4-fast",
    );

    expect(route.fallback_chain || []).toEqual([]);
  });
});
