import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      // Allow importing src modules cleanly
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
});
