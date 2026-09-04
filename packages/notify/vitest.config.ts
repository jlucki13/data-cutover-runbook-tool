import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@cutover/engine": fileURLToPath(new URL("../engine/src/index.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
