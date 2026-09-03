import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@cutover/engine": fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url)) } },
  server: {
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:4000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  preview: {
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:4000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
