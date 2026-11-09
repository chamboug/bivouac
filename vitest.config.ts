import { defineConfig, configDefaults } from "vitest/config";

// app-template is a separate project, with its own dependencies and tests.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "app-template/**"] },
});
