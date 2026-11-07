import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLATFORM_CONTAINERS,
  PLATFORM_IMAGES,
  CADDY_INTERNAL_ADDRESS,
  PLATFORM_NETWORKS,
  generateCaddyfile,
  loadInstance,
  type Instance,
  type ValidationError,
} from "@bivouac/manifest";
import { ensureApp, type AppResult } from "./apps.js";
import { ensureBase, ensureService, pocketIdUrl, postgresServer, writeIfChanged, type Runtime } from "./base.js";
import { syncRepository, type GitSource } from "./git.js";
import { PocketId } from "./pocket-id.js";
import { PLATFORM_SECRETS_FILE, decryptSecrets } from "./secrets.js";
import type { SelfUpdater } from "./self-update.js";

export interface PassConfig {
  source: GitSource;
  /** Local checkout of the instance repo. */
  checkout: string;
  /** The age key that decrypts the instance's secrets (D7). */
  ageKey: string;
}

export type Prepared =
  | { status: "valid"; commit: string; instance: Instance & { platform: NonNullable<Instance["platform"]> } }
  | { status: "invalid"; commit: string; errors: ValidationError[] };

export type PassResult =
  | { status: "applied" | "unchanged"; commit: string; changes: string[]; failures: { app: string; message: string }[] }
  | { status: "invalid"; commit: string; errors: ValidationError[] }
  /** platform.yml names a new reconciler version, ready to run: exit so systemd restarts on it. */
  | { status: "restart"; commit: string; image: string };

/**
 * Reads the desired state: brings the checkout to the tip of the branch and
 * validates it with the same rules as the instance repo's CI. An invalid
 * commit applies nothing: the server keeps the last valid state. CI blocks
 * invalid changes before merge; this is the safety net.
 */
export function prepare(config: Pick<PassConfig, "source" | "checkout">): Prepared {
  const commit = syncRepository(config.source, config.checkout);
  const instance = loadInstance(config.checkout);
  const errors = [...instance.errors];
  if (!instance.platform) {
    return { status: "invalid", commit, errors };
  }
  errors.push(...generateCaddyfile(instance.platform, instance.apps, instance.sites).errors);
  if (errors.length > 0) {
    return { status: "invalid", commit, errors };
  }
  return { status: "valid", commit, instance: { ...instance, platform: instance.platform } };
}

/**
 * One reconciler pass: compare the desired state (Git) with what runs on
 * the server and correct the difference, in order:
 *
 *   0. a new reconciler version in platform.yml stops the pass there;
 *   1. secrets decrypted, network, Postgres, Pocket ID (each healthy first);
 *   2. for each app: database, role and extensions; OIDC client; container;
 *   3. Caddyfile with the routes of the healthy apps, then Caddy.
 *
 * Idempotent: a second pass with the same commit changes nothing. One app
 * failing does not stop the others.
 */
export async function runPass(config: PassConfig, runtime: Runtime, selfUpdater?: SelfUpdater): Promise<PassResult> {
  const prepared = prepare(config);
  // Before anything else, even for an invalid commit: an older version may
  // not understand a newer instance repo, but must still move on (D50).
  const image = await selfUpdater?.check(config.checkout);
  if (image) return { status: "restart", commit: prepared.commit, image };
  if (prepared.status === "invalid") return prepared;
  const { commit, instance } = prepared;
  const { domain } = instance.platform;

  const secrets = decryptSecrets(join(config.checkout, PLATFORM_SECRETS_FILE), config.ageKey);
  const changes: string[] = [];
  await ensureBase(runtime, secrets, domain, changes);

  const context = {
    runtime,
    secrets,
    domain,
    postgres: postgresServer(secrets),
    pocketId: new PocketId(pocketIdUrl(), secrets.pocket_id.static_api_key),
  };
  const results: AppResult[] = [];
  for (const app of instance.apps) {
    try {
      results.push(await ensureApp(context, app));
    } catch (error) {
      results.push({ name: app.name, routed: false, changes: [], failure: (error as Error).message });
    }
  }
  for (const result of results) changes.push(...result.changes);

  const routed = instance.apps.filter((app) => results.find((result) => result.name === app.name)?.routed);
  const { caddyfile } = generateCaddyfile(instance.platform, routed, instance.sites);
  await ensureCaddy(runtime, caddyfile, changes);

  const failures = results.flatMap((result) => (result.failure ? [{ app: result.name, message: result.failure }] : []));
  return { status: changes.length > 0 ? "applied" : "unchanged", commit, changes, failures };
}

/**
 * Caddy reads the Caddyfile from the state directory. A new container reads
 * it at startup; a running one is reloaded through `docker exec` (its admin
 * API only listens inside the container, D53). If Caddy refuses the new
 * file, it keeps running its previous config, and the previous file is put
 * back so a restart cannot pick up the refused one and the next pass tries
 * again.
 */
async function ensureCaddy(runtime: Runtime, caddyfile: string, changes: string[]): Promise<void> {
  const directory = join(runtime.stateDir, "caddy");
  const path = join(directory, "Caddyfile");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const changed = writeIfChanged(path, caddyfile);
  if (changed) changes.push("Caddyfile");
  const result = await ensureService(runtime, changes, {
    name: PLATFORM_CONTAINERS.caddy,
    image: PLATFORM_IMAGES.caddy,
    networks: { [PLATFORM_NETWORKS.apps.name]: null, [PLATFORM_NETWORKS.internal.name]: CADDY_INTERNAL_ADDRESS },
    ports: runtime.caddyPorts,
    mounts: [
      { type: "bind", source: directory, target: "/etc/caddy", readOnly: true },
      // Certificates and Caddy's own state: losing them only means asking
      // for new certificates.
      { type: "volume", source: "bivouac-caddy-data", target: "/data" },
      { type: "volume", source: "bivouac-caddy-config", target: "/config" },
    ],
    // 127.0.0.1, not localhost: in Caddy's image `localhost` is ::1, where
    // the admin API does not listen (observed on caddy:2.11.9).
    healthCheck: { test: ["wget", "-qO-", "http://127.0.0.1:2019/config/"], intervalSeconds: 30, startPeriodSeconds: 30 },
  });
  if (changed && result === "unchanged") {
    const reload = await runtime.docker.exec(PLATFORM_CONTAINERS.caddy, [
      "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
    ]);
    if (reload.exitCode !== 0) {
      if (previous !== undefined) writeIfChanged(path, previous);
      throw new Error(`Caddy refused the new Caddyfile: ${reload.stderr.trim().split("\n").pop()}`);
    }
  }
}
