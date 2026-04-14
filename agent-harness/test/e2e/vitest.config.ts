import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "e2e",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 120_000, // 2 min per test (LLM calls are slow)
    hookTimeout: 30_000,
    // Run tests serially — they share a DO instance
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
