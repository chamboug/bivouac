#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Watch, loadAlertCredentials, sendPushover } from "./alerts.js";
import { Api, platformState, readLastPass } from "./api.js";
import { API_PORT, loadInstance } from "@bivouac/manifest";
import { BackupScheduler, backupPlan, readBackupRequest, requestBackup, runBackup, runMaintenance, runRestoreTest, type BackupRequest } from "./backup.js";
import { appBeingRestored, readLock } from "./lock.js";
import { parseRestoreArgs, restoreApp } from "./restore.js";
import { DEFAULT_MARKER, parsePlatformRestoreArgs, readRebuildState, restorePlatform } from "./rebuild.js";
import { PLATFORM_SECRETS_FILE, decryptSecrets } from "./secrets.js";
import { BaseServiceError, checkStateMount, type Runtime } from "./base.js";
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
 *   BIVOUAC_REBUILD_MARKER    where `bivy rebuild` places its marker
 *                             (default: /etc/bivouac/rebuild.json, D91)
 *   BIVOUAC_API_PORT          port of the internal API read by the status
 *                             page (default: 8080), or `off` (D8)
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
 * `main.js restore-platform [--list] [--snapshot <id>] [--yes]` brings the
 * whole platform's data back on a server being rebuilt (rebuild.ts, D91).
 *
 * `main.js status` prints what the status page shows, as one JSON line,
 * and `main.js backup-now [--restore-test]` asks the running reconciler for
 * a backup now and follows it to its end (both beside it with `docker exec`,
 * for bivy status and bivy backup, D104).
 *
 * Any other command is refused: it never starts a second reconciler.
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
    rebuildMarker: env.BIVOUAC_REBUILD_MARKER ?? DEFAULT_MARKER,
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

/** How long `backup-now` follows a request: a backup and a restore test each stop at 110 minutes. */
const FOLLOW_FOR_MS = 5 * 60 * 60_000;
/** Past this, a request still waiting is said once, with the reason when known. */
const PICKED_UP_WITHIN_MS = 3 * 60_000;

/** Follows a backup asked for now until its end, one log line per step. */
async function followRequest(stateDir: string, requestedAt: number): Promise<number> {
  const started = Date.now();
  let seen: BackupRequest["status"] | undefined;
  let saidWaiting = false;
  for (;;) {
    const request = readBackupRequest(stateDir);
    if (!request || request.requestedAt !== requestedAt) {
      log("backup failed", { error: "the request disappeared: look at bivy status" });
      return 1;
    }
    if (request.status !== seen) {
      seen = request.status;
      if (request.status === "running") log("backup starting");
      if (request.status === "failed") {
        log("backup failed", { error: request.error ?? "unknown" });
        return 1;
      }
      if (request.status === "done") {
        log("backup done", request.restoreTest ? { restore: request.restore } : {});
        if (request.restore === "failed") log("restore test failed", { error: request.restoreError ?? "unknown" });
        return request.restore === "failed" ? 1 : 0;
      }
    }
    const waited = Date.now() - started;
    if (request.status === "waiting" && !saidWaiting && waited > PICKED_UP_WITHIN_MS) {
      saidWaiting = true;
      const lock = readLock(stateDir);
      log("still waiting", { reason: lock ? `a ${lock.job}${lock.app ? ` of ${lock.app}` : ""} is running` : "the reconciler has not picked it up yet" });
    }
    if (waited > FOLLOW_FOR_MS) {
      log("still running", { error: "no end after 5 hours: look at bivy status" });
      return 1;
    }
    await new Promise((wait) => setTimeout(wait, 2000));
  }
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
  // For the alert on a version that has not moved for too long (D109).
  if (selfUpdater && config.image) {
    try {
      selfUpdater.setBuiltAt(await config.runtime.docker.imageCreated(config.image));
    } catch (error) {
      log("cannot read when this version was built", { error: (error as Error).message });
    }
  }

  if (argv[0] === "restore-app") {
    // Started over SSH by bivy restore (D101): a lost connection must not cut a
    // restore short. Its output may then have nowhere to go; the work carries on.
    process.stdout.on("error", () => undefined);
    process.stderr.on("error", () => undefined);
    process.on("SIGHUP", () => undefined);
    try {
      const options = parseRestoreArgs(argv.slice(1));
      // It first sends a safety copy to the repository: never from a test
      // server, nor before the platform's data is back (D91).
      const rebuild = readRebuildState(config.rebuildMarker, config.runtime.stateDir);
      if (rebuild?.mode === "test") throw new Error("this is a rebuild test server: it never writes to the backups, and restore-app does");
      if (rebuild?.waiting) throw new Error("this server is waiting for its data: use restore-platform");
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

  if (argv[0] === "restore-platform") {
    try {
      const options = parsePlatformRestoreArgs(argv.slice(1));
      const instance = loadInstance(config.checkout);
      if (!instance.platform) throw new Error("the instance repo checkout cannot be read: wait for a pass");
      const secrets = decryptSecrets(join(config.checkout, PLATFORM_SECRETS_FILE), config.ageKey);
      const plan = backupPlan(instance.platform, instance.apps, secrets, config.backupRepository);
      if (!plan) throw new Error("backups are not configured on this platform: there is nothing to restore from");
      await restorePlatform({ runtime: config.runtime, plan, secrets, apps: instance.apps, marker: config.rebuildMarker, log }, options);
      return 0;
    } catch (error) {
      log("restore failed", { error: (error as Error).message });
      return 1;
    }
  }

  if (argv[0] === "status") {
    // bivy status (D104): what the status page shows, for whoever has SSH.
    const self = await config.runtime.docker.inspectContainer(config.self);
    const state = await platformState({
      runtime: config.runtime,
      reconciler: { image: config.image ?? null, startedAt: self?.State.StartedAt ?? null },
      lastPass: readLastPass(config.runtime.stateDir),
    });
    process.stdout.write(`${JSON.stringify(state)}\n`);
    return 0;
  }

  if (argv[0] === "backup-now") {
    // bivy backup (D104): asks the running reconciler, then follows it. Cut
    // short, the backup carries on: it runs in the reconciler, not here.
    process.stdout.on("error", () => undefined);
    try {
      const flags = argv.slice(1);
      const unknown = flags.filter((flag) => flag !== "--restore-test");
      if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(" ")}: only --restore-test`);
      const rebuild = readRebuildState(config.rebuildMarker, config.runtime.stateDir);
      if (rebuild?.mode === "test") throw new Error("this is a rebuild test server: it never writes to the backups");
      if (rebuild?.waiting) throw new Error("this server is waiting for its data: nothing to back up yet");
      const instance = loadInstance(config.checkout);
      if (!instance.platform) throw new Error("the instance repo checkout cannot be read");
      const secrets = decryptSecrets(join(config.checkout, PLATFORM_SECRETS_FILE), config.ageKey);
      if (!backupPlan(instance.platform, instance.apps, secrets, config.backupRepository)) throw new Error("backups are not configured on this platform");
      const { request, joined } = requestBackup(config.runtime.stateDir, flags.includes("--restore-test"));
      log(joined ? "joining the backup already asked for" : "backup requested", { restoreTest: request.restoreTest });
      return await followRequest(config.runtime.stateDir, request.requestedAt);
    } catch (error) {
      log("backup failed", { error: (error as Error).message });
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

  // An unknown command must never fall through to a second reconciler loop.
  if (argv[0] !== undefined) {
    log("unknown command", { command: argv[0] });
    return 2;
  }

  const watch = process.env.BIVOUAC_ALERTS === "off" ? undefined : new Watch({ stateDir: config.runtime.stateDir, log });
  const backups = new BackupScheduler({ runtime: config.runtime, log });
  let stopping = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const api = new Api({
    runtime: config.runtime,
    log,
    ...(config.image ? { image: config.image } : {}),
    // A pass now, unless one is running (D3): the next one is then rescheduled from it.
    sync: () => {
      if (running || stopping) return false;
      clearTimeout(timer);
      void loop();
      return true;
    },
  });
  const apiPort = process.env.BIVOUAC_API_PORT ?? String(API_PORT);
  const server = apiPort === "off" ? undefined : api.listen(Number(apiPort));
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    server?.close();
    log("stopping");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  /**
   * A test server (D91) never alerts, pings or backs up: the real server is
   * still running. A marker that cannot be read stops every pass, and is
   * reported: a test server cannot send alerts anyway (its credentials are
   * never saved, and it never gets a backup plan), while a real server must
   * not fall silent.
   */
  const testServer = () => {
    try {
      return readRebuildState(config.rebuildMarker, config.runtime.stateDir)?.mode === "test";
    } catch {
      return false;
    }
  };

  const loop = async () => {
    running = true;
    const quiet = testServer();
    try {
      await backups.recover();
      const result = await runPass(config, config.runtime, selfUpdater);
      report(result);
      if (result.status === "applied" || result.status === "unchanged") {
        if (result.apiToken) api.setToken(result.apiToken);
        api.recordPass({ status: result.status, commit: result.commit, changes: result.changes, failures: result.failures });
      } else if (result.status === "invalid") {
        api.recordPass({ status: "invalid", commit: result.commit, changes: [], failures: result.errors.map((error) => ({ app: error.file, message: error.message })) });
      }
      if (result.status === "restart" && !backups.busy && !appBeingRestored(config.runtime.stateDir)) {
        // systemd starts the reconciler again, on the image now named in
        // image.env (Restart=always). During a backup, this waits for a
        // later pass, so alerts and the heartbeat carry on meanwhile. So
        // does a restore of one app, which runs inside this container.
        process.exit(0);
      }
      // A version on trial got through a pass without crashing: the host
      // stops counting its starts (D61). Not only clean passes: an invalid
      // commit or a failing app must not hold the trial open until reboots
      // roll back a version that works.
      if (result.status !== "restart") selfUpdater?.confirm();
      if (result.status === "applied" || result.status === "unchanged") backups.update(quiet ? undefined : result.backup);
      if (!quiet) {
        backups.tick();
        await watch?.afterPass({ result }, [backups.observation(), ...(selfUpdater ? [selfUpdater.observation()] : [])]);
      }
    } catch (error) {
      log("pass failed", { error: (error as Error).message });
      api.recordPass({ status: "failed", changes: [], failures: [{ app: "(platform)", message: (error as Error).message }] });
      if (error instanceof BaseServiceError && selfUpdater?.onTrial()) {
        // A version on trial whose new base image does not start goes back
        // to the previous one, which brings its own images back (D109). Not
        // during a backup or a restore: the trial stays open, and the next
        // failed pass tries again.
        if (!backups.busy && !appBeingRestored(config.runtime.stateDir) && selfUpdater.rollBack(error.message)) process.exit(0);
      } else {
        // A pass stopped by another error (GitHub unreachable, secrets
        // unreadable) still proves the version stays up: reported by the
        // alerts instead.
        selfUpdater?.confirm();
      }
      if (!quiet) {
        backups.tick();
        await watch?.afterPass({ error: error as Error }, [backups.observation(), ...(selfUpdater ? [selfUpdater.observation()] : [])]);
      }
    }
    running = false;
    if (!stopping) {
      clearTimeout(timer);
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
