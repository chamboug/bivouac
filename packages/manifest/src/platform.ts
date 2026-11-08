/**
 * Fixed facts about the platform's base services, shared by `bivy validate`
 * and the reconciler so both always agree.
 */

/**
 * Exact images of the base services, pinned by digest: a tag like
 * `postgis/postgis:18-3.7` is rebuilt in place for Postgres minor releases,
 * and the reconciler only pulls an image it does not have, so a tag alone
 * would keep the first build forever. Renovate bumps the digests. Versions
 * verified on 6 November 2026: Caddy 2.11.9 and Pocket ID v2.19.2 are the
 * latest releases; Postgres 18 with PostGIS 3.7 is D51. Digests are those
 * of the multi-architecture indexes (`docker buildx imagetools inspect`).
 */
export const PLATFORM_IMAGES = {
  caddy: "caddy:2.11.9@sha256:0c2243efcf437ab7f7a978f1027fcf0d4f9be8a75df27b1b3fbc5dbe0ffa8cf0",
  postgres: "postgis/postgis:18-3.7@sha256:440bdd14e3edccfce04d080d8a1a0cbae5763fa16a1c4172bff83530828461de",
  pocketId: "ghcr.io/pocket-id/pocket-id:v2.19.2@sha256:3ee23895d6a3adb5dd5de801a4fd31fc31b960e6dfbea9b5200e33cf477695eb",
  /** Latest release, verified on 8 November 2026. Throwaway containers only (D33). */
  restic: "restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510",
} as const;

export interface NetworkSpec {
  name: string;
  subnet: string;
  /** Addresses Docker hands out on its own: the upper half, never a fixed one. */
  ipRange: string;
  gateway: string;
}

/**
 * Two Docker networks:
 *
 * - `apps`: every app, with Caddy, Postgres and the reconciler;
 * - `internal`: Pocket ID, with Caddy, Postgres and the reconciler. No app
 *   is on it, so no app can reach Pocket ID's API or first-admin page
 *   without going through Caddy, nor listen to the reconciler's calls to it.
 *
 * Subnets are fixed so Caddy can have a fixed address on `internal`:
 * Pocket ID only trusts the client IP forwarded from that one address
 * (D27, D52).
 */
export const PLATFORM_NETWORKS = {
  apps: { name: "bivouac", subnet: "10.209.0.0/24", ipRange: "10.209.0.128/25", gateway: "10.209.0.1" },
  internal: { name: "bivouac-internal", subnet: "10.209.1.0/24", ipRange: "10.209.1.128/25", gateway: "10.209.1.1" },
} as const satisfies Record<string, NetworkSpec>;

/** Caddy's fixed address on the internal network, the only one Pocket ID trusts. */
export const CADDY_INTERNAL_ADDRESS = "10.209.1.10";

/**
 * Postgres extensions an app may ask for. Extensions are created by the
 * superuser in a database the app owns: a list of well-known ones closes the
 * door to anything that would hand the app more rights (D55). All are
 * shipped by `postgis/postgis:18-3.7`; pgvector will join with its image
 * (D51).
 */
export const ALLOWED_EXTENSIONS = [
  "btree_gin",
  "btree_gist",
  "citext",
  "fuzzystrmatch",
  "hstore",
  "pg_trgm",
  "pgcrypto",
  "postgis",
  "postgis_raster",
  "postgis_topology",
  "unaccent",
] as const;
