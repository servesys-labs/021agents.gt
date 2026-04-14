import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "agent-harness",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 15000,
  },
});
