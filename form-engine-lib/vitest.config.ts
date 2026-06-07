import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
  resolve: {
    alias: {
      // Lets tests import via the same alias the consuming app uses, if desired.
      "@form-engine": new URL("./src", import.meta.url).pathname,
    },
  },
});
