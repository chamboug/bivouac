#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Watch, loadAlertCredentials, sendPushover } from "./alerts.js";
import { loadInstance } from "@bivouac/manifest";
import { BackupScheduler, backupPlan, runBackup, runMaintenance, runRestoreTest } from "./backup.js";
import { appBeingRestored } from "./lock.js";
import { parseRestoreArgs, restoreApp } from "./restore.js";
import { PLATFORM_SECRETS_FILE, decryptSecrets } from "./secrets.js";
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
 *   BIVOUAC_BACKUP_REPOSITORY replaces platform.yml's backup destination
 *                             (tests: a local directory)
 *   BIVOUAC_ALERTS            `off` where nothing must reach the owner's
 *                             phone (local platform); default: on, if the
 *                             secrets file holds the credentials (D45)
 *   BIVOUAC_RECONCILER_IMAGE  the image this reconciler runs, set by the
 *                             systemd unit; without it, the reconciler does
 *                             not update itself (D50)
 *   /etc/bivouac/deploy_key   read-only deploy key (D30)
 *   /etc/bivouac/age.key      age key decrypting the secrets (D7)
 *
 * `main.js once` runs a single pass and exits: 0 if everything applied,
 * 1 otherwise. Used by the tests and the local platform.
 *
 * `main.js once [--backup] [--maintenance] [--restore]` also runs these jobs
 * after the pass (tests).
 *
 * `main.js restore-app <app> [options]` restores one app's data from a
 * backup (restore.ts, runbook section 14), beside the running reconciler:
 * `docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-app …`.
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
    ...(env.BIVOUAC_BACKUP_REPOSITORY ? { backupRepository: env.BIVOUAC_BACKUP_REPOSITORY } : {}),
    interval,
    self,
    ...(env.BIVOUAC_RECONCILER_IMAGE ? { image: env.BIVOUAC_RECONCILER_IMAGE } : {}),
    runtime: {
      docker,
      stateDir,
      self,
      caddyPorts: parsePorts(env.BIVOUAC_CADDY_PORTS ?? "80/tcp=80,443/tcp=443,443/udp=443"),
      pull: (image, login) => docker.pull(image, login),
      healthTimeout,
      ...(metadataCheck === "off" ? {} : { metadataCheck }),
      pausedApps: new Set(),
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

/** Sends one message to the owner's phone, to prove the channel works. */
async function alertTest(): Promise<number> {
  const credentials = loadAlertCredentials(process.env.BIVOUAC_STATE_DIR ?? "/var/lib/bivouac");
  if (!credentials) {
    log("alert test: no credentials on this server yet");
    return 1;
  }
  await sendPushover(credentials, "Bivouac: test", "This is a test alert from your server.");
  log("alert test sent");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "selftest") return selftest();
  if (argv[0] === "alert-test") return alertTest();
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

  if (argv[0] === "restore-app") {
    try {
      const options = parseRestoreArgs(argv.slice(1));
      // The checkout as the running reconciler last applied it: syncing it
      // here would race with its passes.
      const instance = loadInstance(config.checkout);
      if (!instance.platform) throw new Error("the instance repo checkout cannot be read");
      const secrets = decryptSecrets(join(config.checkout, PLATFORM_SECRETS_FILE), config.ageKey);
      const plan = backupPlan(instance.platform, instance.apps, secrets, config.backupRepository);
      if (!plan) throw new Error("backups are not configured on this platform");
      await restoreApp({ runtime: config.runtime, plan, secrets, apps: instance.apps, log }, options);
      return 0;
    } catch (error) {
      log("restore failed", { error: (error as Error).message });
      return 1;
    }
  }

  if (argv[0] === "once") {
    try {
      const result = await runPass(config, config.runtime, selfUpdater);
      const ok = report(result);
      const steps = argv.slice(1);
      if (steps.length === 0) return ok ? 0 : 1;
      if (result.status === "restart" || result.status === "invalid" || !result.backup) throw new Error("nothing to back up");
      if (steps.includes("--backup")) {
        await runBackup(config.runtime, result.backup, log, { mayCreateRepository: true });
        log("backup done");
      }
      if (steps.includes("--maintenance")) await runMaintenance(config.runtime, result.backup, log);
      if (steps.includes("--restore")) await runRestoreTest(config.runtime, result.backup, log);
      return 0;
    } catch (error) {
      log("pass failed", { error: (error as Error).message });
      return 1;
    }
  }

  const watch = process.env.BIVOUAC_ALERTS === "off" ? undefined : new Watch({ stateDir: config.runtime.stateDir, log });
  const backups = new BackupScheduler({ runtime: config.runtime, log });
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
      await backups.recover();
      const result = await runPass(config, config.runtime, selfUpdater);
      report(result);
      if (result.status === "restart" && !backups.busy && !appBeingRestored(config.runtime.stateDir)) {
        // systemd starts the reconciler again, on the image now named in
        // image.env (Restart=always). During a backup, this waits for a
        // later pass, so alerts and the heartbeat carry on meanwhile. So
        // does a restore of one app, which runs inside this container.
        process.exit(0);
      }
      if (result.status === "applied" || result.status === "unchanged") backups.update(result.backup);
      backups.tick();
      await watch?.afterPass({ result }, [backups.observation()]);
    } catch (error) {
      log("pass failed", { error: (error as Error).message });
      backups.tick();
      await watch?.afterPass({ error: error as Error }, [backups.observation()]);
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
