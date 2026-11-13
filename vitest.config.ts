import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      mu: fileURLToPath(new URL("./test/mu-stub.ts", import.meta.url)),
    },
  },
});
