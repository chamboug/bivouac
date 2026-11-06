import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AUTH_SUBDOMAIN,
  CADDY_INTERNAL_ADDRESS,
  PLATFORM_CONTAINERS,
  PLATFORM_IMAGES,
  PLATFORM_NETWORKS,
  POCKET_ID_PORT,
} from "@bivouac/manifest";
import { MANAGED_LABEL, ensureContainer, waitHealthy, type ContainerSpec, type EnsureResult } from "./containers.js";
import type { Docker } from "./docker.js";
import { closePlatformDatabases, connectionString, ensureDatabase, type PostgresServer } from "./postgres.js";
import { deriveSecret, type PlatformSecrets } from "./secrets.js";

/**
 * Everything the reconciler needs to know about where it runs. In
 * production these come from the systemd unit placed by Ignition.
 */
export interface Runtime {
  docker: Docker;
  /**
   * Generated files (Caddyfile, secret files). Must be mounted at the SAME
   * path on the host and in the reconciler's container: the containers it
   * creates name host paths. Checked at startup by `checkStateMount`.
   */
  stateDir: string;
  /** The reconciler's own container, joined to both platform networks. Unset when not in a container. */
  self?: string;
  /** Ports Caddy publishes on the host, e.g. `{ "443/tcp": ["443"] }`. */
  caddyPorts: Record<string, string[]>;
  /** Pulls an image, with registry credentials when needed. */
  pull: (image: string) => Promise<void>;
  /** Seconds to wait for a base service or an app to become healthy. */
  healthTimeout: number;
}

export const POSTGRES_PORT = 5432;
const SECRETS_TARGET = "/run/secrets/bivouac";

/** Pocket ID's own database, outside the app namespace (app names cannot start with `bivouac`). */
export const POCKET_ID_DATABASE = "bivouac_pocket_id";

export function postgresServer(secrets: PlatformSecrets): PostgresServer {
  return {
    host: PLATFORM_CONTAINERS.postgres,
    port: POSTGRES_PORT,
    superuserPassword: deriveSecret(secrets.master_secret, "postgres:superuser"),
  };
}

export function pocketIdUrl(): string {
  return `http://${PLATFORM_CONTAINERS.pocketId}:${POCKET_ID_PORT}`;
}

/**
 * The networks, Postgres and Pocket ID, each healthy before the next one
 * starts. Caddy comes last, once the apps' routes are known (see pass.ts).
 */
export async function ensureBase(
  runtime: Runtime,
  secrets: PlatformSecrets,
  domain: string,
  changes: string[],
): Promise<void> {
  const { docker } = runtime;
  const both = { [PLATFORM_NETWORKS.apps.name]: null, [PLATFORM_NETWORKS.internal.name]: null };
  for (const network of Object.values(PLATFORM_NETWORKS)) {
    if (!(await docker.networkExists(network.name))) {
      await docker.createNetwork(network.name, network, { [MANAGED_LABEL]: "true" });
      changes.push(`network ${network.name}`);
    }
    if (runtime.self) {
      const self = await docker.inspectContainer(runtime.self);
      if (!self) throw new Error(`the reconciler's own container '${runtime.self}' does not exist`);
      if (!self.NetworkSettings.Networks[network.name]) {
        await docker.connectNetwork(network.name, runtime.self);
      }
    }
  }

  const server = postgresServer(secrets);
  const postgresSecrets = join(runtime.stateDir, "secrets", "postgres");
  const postgresInputs = writeSecretFiles(postgresSecrets, { superuser_password: server.superuserPassword }, changes);
  await ensureService(runtime, changes, {
    name: PLATFORM_CONTAINERS.postgres,
    image: PLATFORM_IMAGES.postgres,
    // On both networks: apps and Pocket ID both have a database.
    networks: both,
    inputs: postgresInputs,
    env: { POSTGRES_PASSWORD_FILE: `${SECRETS_TARGET}/superuser_password` },
    mounts: [
      { type: "volume", source: "bivouac-postgres-data", target: "/var/lib/postgresql" },
      { type: "bind", source: postgresSecrets, target: SECRETS_TARGET, readOnly: true },
    ],
    // Over TCP: during its first start the image runs a temporary server on
    // the Unix socket only, which pg_isready would wrongly call ready
    // (observed on postgis/postgis:18-3.7).
    healthCheck: { test: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"], intervalSeconds: 10, startPeriodSeconds: 120 },
  });

  await closePlatformDatabases(server);

  const pocketIdDatabase = {
    name: POCKET_ID_DATABASE,
    password: deriveSecret(secrets.master_secret, `db:${POCKET_ID_DATABASE}`),
    extensions: [],
  };
  changes.push(...(await ensureDatabase(server, pocketIdDatabase)));

  const pocketIdSecrets = join(runtime.stateDir, "secrets", "pocket-id");
  const pocketIdInputs = writeSecretFiles(
    pocketIdSecrets,
    {
      encryption_key: secrets.pocket_id.encryption_key,
      static_api_key: secrets.pocket_id.static_api_key,
      db_connection_string: connectionString(server, pocketIdDatabase),
    },
    changes,
  );
  await ensureService(runtime, changes, {
    name: PLATFORM_CONTAINERS.pocketId,
    image: PLATFORM_IMAGES.pocketId,
    // Internal network only: apps never reach Pocket ID except through
    // Caddy, which refuses its first-admin page (D15).
    networks: { [PLATFORM_NETWORKS.internal.name]: null },
    inputs: pocketIdInputs,
    // Settings verified in Pocket ID v2.19.2's source and binary (D52).
    env: {
      APP_URL: `https://${AUTH_SUBDOMAIN}.${domain}`,
      // Only Caddy may tell Pocket ID the client's real IP (D27).
      TRUST_PROXY: CADDY_INTERNAL_ADDRESS,
      ALLOW_INSECURE_CALLBACK_URLS: "false",
      // No heartbeat to analytics.pocket-id.org.
      ANALYTICS_DISABLED: "true",
      // Uploaded logos and pictures go to Postgres, hence into its backups.
      FILE_BACKEND: "database",
      DB_CONNECTION_STRING_FILE: `${SECRETS_TARGET}/db_connection_string`,
      ENCRYPTION_KEY_FILE: `${SECRETS_TARGET}/encryption_key`,
      STATIC_API_KEY_FILE: `${SECRETS_TARGET}/static_api_key`,
    },
    mounts: [{ type: "bind", source: pocketIdSecrets, target: SECRETS_TARGET, readOnly: true }],
    healthCheck: { test: ["/app/pocket-id", "healthcheck"], intervalSeconds: 30, startPeriodSeconds: 60 },
  });
}

/** A base service: created or updated, restarted if stopped, then waited for. */
export async function ensureService(runtime: Runtime, changes: string[], spec: ContainerSpec): Promise<EnsureResult> {
  const result = await ensureContainer(runtime.docker, spec, runtime.pull, { restartStopped: true });
  if (result !== "unchanged") changes.push(`container ${spec.name} ${result}`);
  await waitHealthy(runtime.docker, spec.name, runtime.healthTimeout);
  return result;
}

/**
 * Writes one directory of secret files for a container. The parent
 * `secrets/` directory is closed to everyone but root on the host; the
 * container only mounts its own subdirectory (the daemon resolves the bind
 * mount, so the container never crosses the parent), whose files it can
 * read whatever its user. No ownership change: Docker Desktop's file sharing
 * does not let the container's root bypass permissions, so the same code
 * runs on a Mac and on the server.
 *
 * Written without a trailing newline: with `_FILE` variables it would become
 * part of the secret. Returns a fingerprint of the files, for `inputs`.
 */
export function writeSecretFiles(directory: string, files: Record<string, string>, changes: string[]): string {
  mkdirSync(dirname(directory), { recursive: true });
  chmodSync(dirname(directory), 0o700);
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o755);
  let changed = false;
  for (const [name, content] of Object.entries(files)) {
    if (writeIfChanged(join(directory, name), content, 0o444)) changed = true;
  }
  if (changed) changes.push(`secret files ${directory}`);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** Writes atomically (temporary file, then rename), only if the content changed. */
export function writeIfChanged(path: string, content: string, mode = 0o644): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    chmodSync(path, mode);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
  return true;
}

/**
 * Refuses to run if the state directory is not mounted at the same path on
 * the host: the containers created by the reconciler would then mount empty
 * host directories instead of the generated files.
 */
export async function checkStateMount(docker: Docker, self: string, stateDir: string): Promise<void> {
  const info = await docker.inspectContainer(self);
  const mount = info?.Mounts.find((entry) => entry.Destination === stateDir);
  if (!mount || mount.Type !== "bind" || mount.Source !== stateDir) {
    throw new Error(
      `${stateDir} must be bind-mounted at the same path on the host (--volume ${stateDir}:${stateDir}): ` +
        `the containers the reconciler creates mount files from it by their host path`,
    );
  }
}
