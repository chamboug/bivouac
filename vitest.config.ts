import { defineConfig, configDefaults } from "vitest/config";

// app-template and status-page are separate projects, with their own
// dependencies and tests (their own CI jobs).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "app-template/**", "status-page/**", ".claude/**"] },
});
