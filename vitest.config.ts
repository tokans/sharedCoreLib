import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The core's own tests live under src/. Scope the run here so it does NOT
    // sweep up the independent sub-packages (form-engine-lib, publisher-ci),
    // which ship their own vitest configs/environments. Running form-engine-lib's
    // jsdom tests under the core's default node environment caused
    // `localStorage is not defined` (REVIEW-REQUIRED #5).
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
