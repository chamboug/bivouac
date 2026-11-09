// Layers in layers/ are picked up by Nuxt on their own:
// - layers/platform: database, migrations at startup, health endpoint;
// - layers/oidc: sign-in through the platform's identity provider.
export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: false },
  telemetry: false,
  // Sibling apps share a registrable domain: none may frame this one.
  routeRules: { "/**": { headers: { "content-security-policy": "frame-ancestors 'self'" } } },
});
