import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://localhost:8340",
      "/health": "http://localhost:8340",
      "/.well-known": "http://localhost:8340",
      "/a2a": "http://localhost:8340",
      "/docs": "http://localhost:8340",
    },
  },
});
