import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("chart.js")) {
            return "vendor-chartjs";
          }
          if (id.includes("@clerk/")) {
            return "vendor-clerk";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3000,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:8788",
      "/health": "http://localhost:8788",
      "/openapi.json": "http://localhost:8788",
      "/.well-known": "http://localhost:8788",
      "/a2a": "http://localhost:8788",
      "/docs": "http://localhost:8788",
    },
  },
});
