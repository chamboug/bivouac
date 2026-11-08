#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStateMount, type Runtime } from "./base.js";
import { parsePorts } from "./containers.js";
import { Docker } from "./docker.js";
import { runPass, type PassConfig, type PassResult } from "./pass.js";
import { METADATA_ADDRESS, parseAddress } from "./metadata-check.js";
import { SelfUpdater } from "./self-update.js";

/**
 * Entry point of the reconciler container. Everything it needs comes from
 * the environment and from files placed over SSH in /etc/bivouac (D7):
 *
 *   BIVOUAC_REPOSITORY        address of the instance repo (required)
 *   BIVOUAC_BRANCH            branch to follow (default: main)
 *   BIVOUAC_INTERVAL_SECONDS  delay between passes (default: 60, D2)
 *   BIVOUAC_STATE_DIR         generated files, mounted at the same path on
 *                             the host (default: /var/lib/bivouac)
 *   BIVOUAC_CONTAINER         the reconciler's own container name
 *                             (default: bivouac-reconciler)
 *   BIVOUAC_CADDY_PORTS       ports Caddy publishes, `container=host` pairs
 *                             (default: 80/tcp=80,443/tcp=443,443/udp=443)
 *   BIVOUAC_HEALTH_TIMEOUT    seconds to wait for a container to be healthy
 *                             (default: 180)
 *   BIVOUAC_METADATA_CHECK    metadata service that must be out of reach,
 *                             `host:port` (default: 169.254.169.254:80), or
 *                             `off` where there is none to protect (D7)
 *   BIVOUAC_RECONCILER_IMAGE  the image this reconciler runs, set by the
 *                             systemd unit; without it, the reconciler does
 *                             not update itself (D50)
 *   /etc/bivouac/deploy_key   read-only deploy key (D30)
 *   /etc/bivouac/age.key      age key decrypting the secrets (D7)
 *
 * `main.js once` runs a single pass and exits: 0 if everything applied,
 * 1 otherwise. Used by the tests and the local platform.
 *
 * `main.js selftest` only checks that the image runs and finds its tools
 * (git, ssh, sops): a new version passes it before the reconciler moves to
 * it. It needs no environment, network or mount.
 */

const here = dirname(fileURLToPath(import.meta.url));

function configFromEnvironment(): PassConfig & { interval: number; self: string; image?: string; runtime: Runtime } {
  const env = process.env;
  const repository = env.BIVOUAC_REPOSITORY;
  if (!repository) {
    throw new Error("BIVOUAC_REPOSITORY is not set: it is the address of the instance repo");
  }
  const deployKey = env.BIVOUAC_DEPLOY_KEY ?? "/etc/bivouac/deploy_key";
  const stateDir = env.BIVOUAC_STATE_DIR ?? "/var/lib/bivouac";
  const interval = Number(env.BIVOUAC_INTERVAL_SECONDS ?? "60");
  if (!Number.isFinite(interval) || interval < 10) {
    throw new Error("BIVOUAC_INTERVAL_SECONDS must be a number of seconds, at least 10");
  }
  const healthTimeout = Number(env.BIVOUAC_HEALTH_TIMEOUT ?? "180");
  const self = env.BIVOUAC_CONTAINER ?? "bivouac-reconciler";
  const metadataCheck = env.BIVOUAC_METADATA_CHECK ?? METADATA_ADDRESS;
  if (metadataCheck !== "off") parseAddress(metadataCheck);
  const docker = new Docker();
  return {
    source: {
      repository,
      branch: env.BIVOUAC_BRANCH ?? "main",
      deployKey,
      knownHosts: join(here, "..", "github_known_hosts"),
    },
    checkout: join(stateDir, "repo"),
    ageKey: env.BIVOUAC_AGE_KEY ?? "/etc/bivouac/age.key",
    interval,
    self,
    ...(env.BIVOUAC_RECONCILER_IMAGE ? { image: env.BIVOUAC_RECONCILER_IMAGE } : {}),
    runtime: {
      docker,
      stateDir,
      self,
      caddyPorts: parsePorts(env.BIVOUAC_CADDY_PORTS ?? "80/tcp=80,443/tcp=443,443/udp=443"),
      // Public images only for now; private app images need the GHCR token (D17).
      pull: (image) => docker.pull(image),
      healthTimeout,
      ...(metadataCheck === "off" ? {} : { metadataCheck }),
    },
  };
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}

function report(result: PassResult): boolean {
  if (result.status === "restart") {
    log("restarting on the new reconciler version", { commit: result.commit, image: result.image });
    return true;
  }
  if (result.status === "invalid") {
    log("instance is invalid: nothing applied", { commit: result.commit, errors: result.errors });
    return false;
  }
  log(`pass ${result.status}`, { commit: result.commit, changes: result.changes });
  for (const failure of result.failures) log("app failed", { app: failure.app, error: failure.message });
  return result.failures.length === 0;
}

/** Checks that the image runs and finds its tools, without anything else. */
function selftest(): number {
  for (const [command, args] of [["git", ["--version"]], ["ssh", ["-V"]], ["sops", ["--version", "--disable-version-check"]]] as const) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      log("selftest failed", { command, error: result.error?.message ?? result.stderr.trim() });
      return 1;
    }
  }
  log("selftest passed");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "selftest") return selftest();
  const config = configFromEnvironment();
  const version = await config.runtime.docker.checkVersion();
  await checkStateMount(config.runtime.docker, config.self, config.runtime.stateDir);
  log("starting", { repository: config.source.repository, interval: config.interval, docker: version, image: config.image });
  const selfUpdater = config.image
    ? new SelfUpdater({
        docker: config.runtime.docker,
        stateDir: config.runtime.stateDir,
        current: config.image,
        pull: config.runtime.pull,
        log,
      })
    : undefined;

  if (argv[0] === "once") {
    try {
      return report(await runPass(config, config.runtime, selfUpdater)) ? 0 : 1;
    } catch (error) {
      log("pass failed", { error: (error as Error).message });
      return 1;
    }
  }

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    log("stopping");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const loop = async () => {
    try {
      const result = await runPass(config, config.runtime, selfUpdater);
      report(result);
      if (result.status === "restart") {
        // systemd starts the reconciler again, on the image now named in
        // image.env (Restart=always).
        process.exit(0);
      }
    } catch (error) {
      log("pass failed", { error: (error as Error).message });
    }
    if (!stopping) {
      timer = setTimeout(() => void loop(), config.interval * 1000);
    }
  };
  await loop();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    log("cannot start", { error: (error as Error).message });
    process.exitCode = 1;
  },
);
