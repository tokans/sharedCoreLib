import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-TS engine — no DOM, no React. Plain node environment.
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
