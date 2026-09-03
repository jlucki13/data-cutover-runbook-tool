import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@cutover/engine": p("../../packages/engine/src/index.ts"),
      "@cutover/ingest": p("../../packages/ingest/src/index.ts"),
      "@cutover/db": p("../../packages/db/src/index.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
