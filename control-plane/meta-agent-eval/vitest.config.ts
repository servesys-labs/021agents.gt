import { defineConfig } from "vitest/config";

// Separate vitest config for the meta-agent eval harness so it:
//   1. Doesn't run on `pnpm --filter control-plane test` (different include glob)
//   2. Has longer timeouts for real Gemma calls through the AI Gateway
//   3. Is invoked explicitly via `pnpm --filter control-plane eval`
export default defineConfig({
  test: {
    include: ["**/*.eval.ts"],
    environment: "node",
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@/": new URL("../src/", import.meta.url).pathname,
    },
  },
});
