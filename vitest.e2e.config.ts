import { defineConfig } from "vitest/config";

// End-to-end tests: real containers, one platform shared by the tests of a
// file, run in order. Slow (images to pull, Postgres to initialize).
export default defineConfig({
  test: {
    include: ["packages/*/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 900_000,
  },
});
