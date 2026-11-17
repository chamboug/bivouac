import { existsSync } from "node:fs";
import { join } from "node:path";

// The platform's status page (D8). It signs in through the identity provider
// with the oidc layer of this same commit, copied into .layers/ by
// `npm run layers` (and by the Dockerfile), so the layer's imports find this
// app's node_modules. No database: everything comes from the reconciler's
// internal API.
const REQUIRED_FILES = ["server/middleware/auth.ts"];

export default defineNuxtConfig({
  extends: ["./.layers/oidc"],
  compatibilityDate: "2026-11-01",
  modules: [
    "@nuxt/ui",
    (_options, nuxt) => {
      for (const file of REQUIRED_FILES) {
        if (!nuxt.options._layers.some((layer) => layer.cwd && existsSync(join(layer.cwd, file)))) {
          throw new Error(`Shared layer missing: no ${file}. Refusing to build an unprotected page.`);
        }
      }
    },
  ],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: false },
  telemetry: false,
  routeRules: { "/**": { headers: { "content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff" } } },
});
