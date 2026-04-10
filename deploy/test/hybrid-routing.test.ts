import { describe, expect, it } from "vitest";

import { selectModel, type PlanRouting } from "../src/runtime/router";

describe("hybrid routing fallback", () => {
  it("returns fallback_chain from matched route", async () => {
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
