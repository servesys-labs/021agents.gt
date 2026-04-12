import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.eval.ts"],
    testTimeout: 300_000,
    hookTimeout: 30_000,
  },
});
