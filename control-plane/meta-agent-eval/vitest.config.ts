import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Separate vitest config for the meta-agent eval harness so it:
//   1. Doesn't run on `pnpm --filter control-plane test` (different include glob)
//   2. Has longer timeouts for real Gemma calls through the AI Gateway
//   3. Is invoked explicitly via `pnpm --filter control-plane eval`
//
// `root` is anchored to this file's directory so `include` globs can
// never leak outside meta-agent-eval/, regardless of which CWD vitest
// was invoked from. Guards against a stray `*.eval.ts` being added
// elsewhere in the workspace and getting picked up inadvertently.
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: HERE,
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
