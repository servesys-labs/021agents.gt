import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

// Note: @cloudflare/vitest-pool-workers is required for DO integration tests.
// Install: npm install --save-dev @cloudflare/vitest-pool-workers
// If not installed, these tests won't run — use the Layer 1 tests in test/platform.test.ts instead.

let plugins: any[] = [];
try {
  const { cloudflareTest } = await import("@cloudflare/vitest-pool-workers");
  plugins = [cloudflareTest({ wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") } })];
} catch {
  console.warn("[test] @cloudflare/vitest-pool-workers not installed — skipping DO integration tests");
}

export default defineConfig({
  plugins,
  test: {
    name: "integration",
    include: [path.join(testsDir, "**/*.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 15000,
  },
});
