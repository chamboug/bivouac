import { defineConfig } from "vitest/config";

export default defineConfig({
  // The storage tests move several MB: room for a slow or busy machine.
  test: { include: ["test/*.test.ts"], testTimeout: 30_000 },
});
