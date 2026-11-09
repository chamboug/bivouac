import { existsSync } from "node:fs";
import { join } from "node:path";

// The platform's shared code, at one exact commit (Renovate proposes new ones):
// - platform: database, migrations at startup, health endpoint;
// - oidc: sign-in through the platform's identity provider.
const layersCommit = "0000000000000000000000000000000000000000"; // app-layers-v1.0.0
const shared = [
  `github:chamboug/bivouac/app-layers/platform#${layersCommit}`,
  `github:chamboug/bivouac/app-layers/oidc#${layersCommit}`,
];

// Only the platform's own CI sets this, to test unpublished layers.
const local = process.env.BIVOUAC_LOCAL_LAYERS;

// Nuxt only warns when a layer cannot be loaded, and the app would then be
// built with no sign-in at all: stop the build instead.
const REQUIRED_FILES = ["server/middleware/auth.ts", "server/api/health.get.ts"];

export default defineNuxtConfig({
  extends: local ? [`${local}/platform`, `${local}/oidc`] : shared,
  compatibilityDate: "2026-11-01",
  modules: [
    "@nuxt/ui",
    (_options, nuxt) => {
      for (const file of REQUIRED_FILES) {
        if (!nuxt.options._layers.some((layer) => layer.cwd && existsSync(join(layer.cwd, file)))) {
          throw new Error(`Shared layer missing: no ${file}. Refusing to build an unprotected app.`);
        }
      }
    },
  ],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: false },
  telemetry: false,
  // Sibling apps share a registrable domain: none may frame this one.
  routeRules: { "/**": { headers: { "content-security-policy": "frame-ancestors 'self'" } } },
});
