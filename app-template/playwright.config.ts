import { defineConfig } from "@playwright/test";

const appPort = 3100;
const issuerPort = 4010;
// Where the app keeps its files during the tests (git ignores .data).
export const storageDir = ".data/e2e-storage";

// Needs a built app (npm run build) and a Postgres in DATABASE_URL.
export default defineConfig({
  testDir: "test/e2e",
  // One at a time: some tests change who the fake identity provider signs in.
  workers: 1,
  use: { baseURL: `http://localhost:${appPort}` },
  webServer: [
    { command: "node test/e2e/fake-issuer.mjs", url: `http://localhost:${issuerPort}/jwks` },
    {
      command: "node .output/server/index.mjs",
      url: `http://localhost:${appPort}/api/health`,
      env: {
        PORT: String(appPort),
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        OIDC_ISSUER: `http://localhost:${issuerPort}`,
        OIDC_CLIENT_ID: "test-client",
        OIDC_CLIENT_SECRET: "test-secret-test-secret-test-secret",
        STORAGE_DIR: storageDir,
        MCP_RESOURCE: `http://localhost:${appPort}/mcp`,
        // Lets the file route's tests download; a real app writes its own mayRead.
        TEMPLATE_TEST_FILES_OPEN: "1",
      },
    },
  ],
});
