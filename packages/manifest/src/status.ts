import type { AppManifest, PlatformConfig } from "./schema.js";

/** The status page's name: `status.<domain>`, reserved for it (D34). */
export const STATUS_APP = "status";

/**
 * The port of the reconciler's read-only API (D8). It is only answered on
 * the internal network, where no app is, and only with the status page's
 * token.
 */
export const API_PORT = 8080;

/**
 * The status page, as the app the reconciler runs for it: a Nuxt app of the
 * monorepo, signed in through the identity provider like any `oidc` app, with
 * no database and no volume. Its name is reserved, so no app can take it.
 */
export function statusApp(platform: PlatformConfig): AppManifest | undefined {
  if (!platform.status) return undefined;
  return {
    name: STATUS_APP,
    image: platform.status.image,
    port: 3000,
    health: "/api/health",
    auth: "oidc",
    groups: platform.status.groups,
    volumes: {},
    backup: { stop: false },
    env: {},
    domains: [],
    mcp: false,
  };
}

/** The instance's apps, with the status page when platform.yml names one. */
export function withStatusApp(platform: PlatformConfig, apps: AppManifest[]): AppManifest[] {
  const status = statusApp(platform);
  return status ? [...apps, status] : apps;
}
