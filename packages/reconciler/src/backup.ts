import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_CONTAINERS, PLATFORM_IMAGES, PLATFORM_NETWORKS, appContainerName, type AppManifest, type PlatformConfig } from "@bivouac/manifest";
import { redact, type Observation } from "./alerts.js";
import { POCKET_ID_DATABASE, postgresServer, writeIfChanged, type Runtime } from "./base.js";
import { createBody, type ContainerSpec } from "./containers.js";
import { databaseName, databasesBytes, type PostgresServer } from "./postgres.js";
import type { PlatformSecrets } from "./secrets.js";

/**
 * The nightly backup (D33): one dump per database and the declared volumes,
 * sent with restic in throwaway containers. The reconciler only starts them
 * and waits: nothing runs on the host, and the running services are not
 * touched, except apps asking to be stopped for a consistent copy (D20).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** In UTC. Before the OS's reboot window; the healthchecks.io check expects this schedule. */
export const BACKUP_HOUR_UTC = 2;
export const BACKUP_ATTEMPTS_PER_DAY = 2;
const RETRY_DELAY = HOUR;
/** A whole run must end before the OS's reboot window (04:00 UTC). */
const RUN_DEADLINE = 110 * MINUTE;
/** Dumps must leave room: a full disk stops Postgres (D42). */
const DUMP_MAX_SHARE_OF_FREE_SPACE = 0.8;
/** Restic and pg_dump must never push the base services out of a small server. */
const ONE_OFF_MEMORY_BYTES = 1536 * 1024 * 1024;
/** restic groups snapshots by host, and a container's name changes on every run. */
const RESTIC_HOST = "bivouac";
/** restic's documented exit code for "the repository does not exist". */
const RESTIC_NO_REPOSITORY = 10;

const CONTAINER = "bivouac-backup";
const SECRETS_TARGET = "/run/secrets/bivouac";

export interface BackupPlan {
  repository: string;
  region?: string;
  resticPassword: string;
  accessKeyId: string;
  secretAccessKey: string;
  postgres: PostgresServer;
  databases: string[];
  /** Docker volumes to copy. */
  volumes: string[];
  /** Apps to stop during the copy of their files (D20). */
  stop: { app: string; container: string }[];
  /** healthchecks.io ping address of this job: a secret. */
  ping?: string;
}

/** What to back up, from the manifests. Undefined when backups are not configured. */
export function backupPlan(
  platform: PlatformConfig,
  apps: AppManifest[],
  secrets: PlatformSecrets,
  override?: string,
): BackupPlan | undefined {
  if (!platform.backup || !secrets.backup) return undefined;
  const repository = override ?? platform.backup.repository;
  const region = /^s3:https:\/\/s3\.([a-z0-9-]+)\./.exec(repository)?.[1];
  return {
    repository,
    ...(region ? { region } : {}),
    resticPassword: secrets.backup.restic_password,
    accessKeyId: secrets.backup.b2_key_id,
    secretAccessKey: secrets.backup.b2_application_key,
    postgres: postgresServer(secrets),
    databases: [POCKET_ID_DATABASE, ...apps.filter((app) => app.database).map((app) => databaseName(app.name))],
    volumes: apps.flatMap((app) => Object.keys(app.volumes).map((volume) => `${appContainerName(app.name)}_${volume}`)),
    stop: apps
      .filter((app) => app.backup.stop && Object.keys(app.volumes).length > 0)
      .map((app) => ({ app: app.name, container: appContainerName(app.name) })),
    ...(secrets.alerts ? { ping: secrets.alerts.healthchecks.backup } : {}),
  };
}

export interface OneOffResult {
  exitCode: number;
  logs: string;
}

/** Runs a container to its end and removes it. A leftover of an interrupted run is removed first. */
export async function runOneOff(runtime: Runtime, spec: ContainerSpec, timeout: number): Promise<OneOffResult> {
  const { docker } = runtime;
  await docker.removeContainer(spec.name);
  if (!(await docker.imageExists(spec.image))) await runtime.pull(spec.image);
  const body = createBody(spec);
  const host = body.HostConfig as Record<string, unknown>;
  host.RestartPolicy = { Name: "no" };
  host.Memory = ONE_OFF_MEMORY_BYTES;
  await docker.createContainer(spec.name, body);
  try {
    await docker.startContainer(spec.name);
    const exitCode = await docker.waitContainer(spec.name, timeout);
    return { exitCode, logs: await docker.logs(spec.name) };
  } finally {
    await docker.removeContainer(spec.name);
  }
}

const lastLine = (text: string) => text.trim().split("\n").pop() ?? "";

/** One restic command. Its credentials only exist in a container that is removed right after. */
export function runRestic(runtime: Runtime, plan: BackupPlan, timeout: number, args: string[], mounts: ContainerSpec["mounts"] = []): Promise<OneOffResult> {
  const local = plan.repository.startsWith("/");
  if (local) mkdirSync(plan.repository, { recursive: true });
  return runOneOff(runtime, {
    name: CONTAINER,
    image: PLATFORM_IMAGES.restic,
    env: {
      RESTIC_REPOSITORY: plan.repository,
      RESTIC_PASSWORD: plan.resticPassword,
      RESTIC_CACHE_DIR: "/cache",
      AWS_ACCESS_KEY_ID: plan.accessKeyId,
      AWS_SECRET_ACCESS_KEY: plan.secretAccessKey,
      ...(plan.region ? { AWS_DEFAULT_REGION: plan.region } : {}),
    },
    cmd: args,
    mounts: [
      { type: "bind", source: join(runtime.stateDir, "backup", "cache"), target: "/cache" },
      ...(local ? [{ type: "bind" as const, source: plan.repository, target: plan.repository }] : []),
      ...(mounts ?? []),
    ],
    networks: {},
  }, timeout);
}

async function checked(step: string, run: Promise<OneOffResult>): Promise<void> {
  const { exitCode, logs } = await run;
  if (exitCode !== 0) throw new Error(`${step} failed (exit ${exitCode}): ${lastLine(logs)}`);
}

/**
 * A repository is only ever created before the first success: afterwards, a
 * missing one means something is wrong (a changed address, lost data), and
 * starting a new empty history would hide it behind a success.
 */
async function ensureRepository(runtime: Runtime, plan: BackupPlan, timeout: number, mayCreate: boolean): Promise<void> {
  const { exitCode, logs } = await runRestic(runtime, plan, timeout, ["cat", "config"]);
  if (exitCode === RESTIC_NO_REPOSITORY) {
    if (!mayCreate) throw new Error("the backup repository has disappeared: not creating a new one");
    await checked("restic init", runRestic(runtime, plan, timeout, ["init"]));
  } else if (exitCode !== 0) {
    throw new Error(`the backup repository cannot be read (exit ${exitCode}): ${lastLine(logs)}`);
  }
}

/** pg_dump without compression: restic compresses, and deduplicates only what it can compare. */
async function dumpDatabase(runtime: Runtime, database: string, directory: string, timeout: number): Promise<void> {
  await checked(`pg_dump of ${database}`, runOneOff(runtime, {
    name: `${CONTAINER}-dump`,
    image: PLATFORM_IMAGES.postgres,
    cmd: [
      "sh", "-c",
      // Under a temporary name: a dump cut short must never pass for a whole one.
      `export PGPASSWORD="$(cat ${SECRETS_TARGET}/superuser_password)"; pg_dump --host ${PLATFORM_CONTAINERS.postgres} --username postgres --format custom --compress 0 --file "/dumps/$1.tmp" "$1" && mv "/dumps/$1.tmp" "/dumps/$1.dump" || { rm -f "/dumps/$1.tmp"; exit 1; }`,
      "sh", database,
    ],
    mounts: [
      { type: "bind", source: directory, target: "/dumps" },
      { type: "bind", source: join(runtime.stateDir, "secrets", "postgres"), target: SECRETS_TARGET, readOnly: true },
    ],
    // Not the network the apps share: the dump travels in the clear.
    networks: { [PLATFORM_NETWORKS.internal.name]: null },
  }, timeout));
}

export const dumpsFit = (bytes: number, free: number) => bytes <= free * DUMP_MAX_SHARE_OF_FREE_SPACE;

const pausedFile = (stateDir: string) => join(stateDir, "backup", "paused.json");

function readPaused(stateDir: string): { app: string; container: string }[] {
  try {
    return JSON.parse(readFileSync(pausedFile(stateDir), "utf8")) as { app: string; container: string }[];
  } catch {
    return [];
  }
}

function writePaused(stateDir: string, entries: { app: string; container: string }[]): void {
  if (entries.length === 0) rmSync(pausedFile(stateDir), { force: true });
  else writeIfChanged(pausedFile(stateDir), JSON.stringify(entries), 0o600);
}

/**
 * Starts the apps a backup stopped. The list is on disk, written before each
 * stop: a crash or a reboot during the backup must not leave them down, since
 * a stopped container otherwise means a failed deployment (D21). An app that
 * cannot be started stays listed, and is tried again on the next pass.
 */
export async function restartPaused(runtime: Runtime): Promise<string[]> {
  const problems: string[] = [];
  const remaining: { app: string; container: string }[] = [];
  for (const entry of readPaused(runtime.stateDir)) {
    try {
      const info = await runtime.docker.inspectContainer(entry.container);
      if (info && !info.State.Running) await runtime.docker.startContainer(entry.container);
      runtime.pausedApps.delete(entry.app);
    } catch (error) {
      remaining.push(entry);
      problems.push(`${entry.app} could not be started again: ${(error as Error).message}`);
    }
  }
  writePaused(runtime.stateDir, remaining);
  return problems;
}

/**
 * One full backup. A database that cannot be dumped does not cost the others
 * their copy: everything else is still sent, and the run is reported failed.
 */
export async function runBackup(
  runtime: Runtime,
  plan: BackupPlan,
  log: (message: string, fields?: Record<string, unknown>) => void,
  options: { mayCreateRepository: boolean },
): Promise<void> {
  const root = join(runtime.stateDir, "backup");
  const dumps = join(root, "dumps");
  rmSync(dumps, { recursive: true, force: true });
  mkdirSync(dumps, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "cache"), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + RUN_DEADLINE;
  const remaining = () => Math.max(MINUTE, deadline - Date.now());
  const problems: string[] = [];
  try {
    const { bavail, bsize } = statfsSync(root);
    const needed = await databasesBytes(plan.postgres, plan.databases);
    if (!dumpsFit(needed, bavail * bsize)) throw new Error(`not enough free disk for the dumps (${Math.ceil(needed / 1048576)} MiB needed)`);
    await ensureRepository(runtime, plan, remaining(), options.mayCreateRepository);
    await checked("restic unlock", runRestic(runtime, plan, remaining(), ["unlock"]));
    for (const database of plan.databases) {
      try {
        await dumpDatabase(runtime, database, dumps, remaining());
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    const paused: { app: string; container: string }[] = [];
    for (const entry of plan.stop) {
      runtime.pausedApps.add(entry.app);
      const info = await runtime.docker.inspectContainer(entry.container);
      // Only what is running: a stopped app is a failed deployment, to leave as it is.
      if (info?.State.Running) {
        paused.push(entry);
        writePaused(runtime.stateDir, paused);
        await runtime.docker.stopContainer(entry.container);
      }
    }
    await checked("restic backup", runRestic(
      runtime,
      plan,
      remaining(),
      ["backup", "--host", RESTIC_HOST, "--tag", problems.length > 0 ? "incomplete" : "nightly", "/source"],
      [
        { type: "bind", source: dumps, target: "/source/dumps", readOnly: true },
        ...plan.volumes.map((volume) => ({ type: "volume" as const, source: volume, target: `/source/volumes/${volume}`, readOnly: true })),
      ],
    ));
    log("backup sent", { databases: plan.databases.length, volumes: plan.volumes.length });
  } catch (error) {
    problems.push((error as Error).message);
  } finally {
    problems.push(...(await restartPaused(runtime)));
    for (const entry of plan.stop) runtime.pausedApps.delete(entry.app);
    rmSync(dumps, { recursive: true, force: true });
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

/**
 * What the weekly clean-up keeps. Counted in snapshots that exist, not in
 * days: nights without a backup never push a good copy out. Only snapshots
 * with these tags are considered, so an `archive` one (D18) is never touched.
 */
export function retentionCommands(): string[][] {
  return [
    ["forget", "--host", RESTIC_HOST, "--tag", "nightly", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6"],
    ["forget", "--host", RESTIC_HOST, "--tag", "incomplete", "--keep-within", "30d"],
    ["prune"],
  ];
}

const MAINTENANCE_TIMEOUT = 90 * MINUTE;

/** Applies the retention. Files removed here stay recoverable for a while, by the bucket's own rule. */
export async function runMaintenance(runtime: Runtime, plan: BackupPlan, log: (message: string, fields?: Record<string, unknown>) => void): Promise<void> {
  for (const command of retentionCommands()) {
    await checked(`restic ${command[0]}`, runRestic(runtime, plan, MAINTENANCE_TIMEOUT, command));
  }
  log("old backups cleaned up");
}

/** Weeks start on Sunday (day 0 of the Unix epoch was a Thursday), when the restore test is expected. */
export const backupWeek = (now: number) => Math.floor((backupDay(now) + 4) / 7);

export interface BackupState {
  /** The backup day of the last attempt. */
  day?: number;
  attempts: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  /** The week of the last successful clean-up. */
  maintenanceWeek?: number;
  maintenanceError?: string;
}

/** A backup day starts at the backup hour. */
export const backupDay = (now: number) => Math.floor((now - BACKUP_HOUR_UTC * HOUR) / DAY);

export function isDue(state: BackupState, now: number): boolean {
  if (state.day !== backupDay(now)) return true;
  return state.lastError !== undefined
    && state.attempts < BACKUP_ATTEMPTS_PER_DAY
    && now - (state.lastAttemptAt ?? 0) >= RETRY_DELAY;
}

export interface SchedulerOptions {
  runtime: Runtime;
  log: (message: string, fields?: Record<string, unknown>) => void;
  run?: (plan: BackupPlan) => Promise<void>;
  maintain?: (plan: BackupPlan) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Decides when to back up. The work runs beside the passes, which must go on (D2, D45). */
export class BackupScheduler {
  private readonly path: string;
  private readonly now: () => number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly run: (plan: BackupPlan) => Promise<void>;
  private readonly maintain: (plan: BackupPlan) => Promise<void>;
  private readonly state: BackupState;
  private plan: BackupPlan | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly options: SchedulerOptions) {
    this.path = join(options.runtime.stateDir, "backup", "state.json");
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.run = options.run ?? ((plan) => runBackup(options.runtime, plan, options.log, { mayCreateRepository: this.state.lastSuccessAt === undefined }));
    this.maintain = options.maintain ?? ((plan) => runMaintenance(options.runtime, plan, options.log));
    this.state = this.load();
    // Left by a run that was cut short: no reason to keep a copy of the data there.
    rmSync(join(options.runtime.stateDir, "backup", "dumps"), { recursive: true, force: true });
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Before each pass: nothing a backup stopped may look like a failed deployment. */
  async recover(): Promise<void> {
    if (this.running) return;
    for (const problem of await restartPaused(this.options.runtime)) this.options.log("backup: app not restarted", { problem: redact(problem) });
  }

  update(plan: BackupPlan | undefined): void {
    this.plan = plan;
  }

  tick(): void {
    if (this.running || !this.plan || !isDue(this.state, this.now())) return;
    const plan = this.plan;
    this.running = this.attempt(plan).finally(() => {
      this.running = undefined;
    });
  }

  async idle(): Promise<void> {
    await this.running;
  }

  /** While it runs, a backup is neither good nor bad. */
  observation(): Observation {
    if (this.running) return { incidents: [], checked: [] };
    return {
      incidents: [
        ...(this.state.lastError ? [{ key: "backup:nightly" as const, message: `The backup failed: ${this.state.lastError}` }] : []),
        ...(this.state.maintenanceError ? [{ key: "backup:retention" as const, message: `Cleaning up old backups failed: ${this.state.maintenanceError}` }] : []),
      ],
      checked: ["backup"],
    };
  }

  private async attempt(plan: BackupPlan): Promise<void> {
    const now = this.now();
    const day = backupDay(now);
    Object.assign(this.state, {
      attempts: this.state.day === day ? this.state.attempts + 1 : 1,
      day,
      lastAttemptAt: now,
      lastError: "it was interrupted",
    });
    this.save();
    this.options.log("backup starting");
    await this.ping(plan, "/start");
    try {
      await this.run(plan);
      delete this.state.lastError;
      this.state.lastSuccessAt = this.now();
      this.save();
      await this.ping(plan, "");
      this.options.log("backup done");
      await this.cleanUp(plan);
    } catch (error) {
      this.state.lastError = redact((error as Error).message);
      this.save();
      this.options.log("backup failed", { error: this.state.lastError });
      await this.ping(plan, "/fail");
    }
  }

  /** Only after a backup that worked, once a week. A failure costs space, not the night's copy. */
  private async cleanUp(plan: BackupPlan): Promise<void> {
    const week = backupWeek(this.now());
    if (this.state.maintenanceWeek === week) return;
    try {
      await this.maintain(plan);
      this.state.maintenanceWeek = week;
      delete this.state.maintenanceError;
    } catch (error) {
      this.state.maintenanceError = redact((error as Error).message);
      this.options.log("clean-up failed", { error: this.state.maintenanceError });
    }
    this.save();
  }

  /** The address is a secret: it is never logged. */
  private async ping(plan: BackupPlan, suffix: string): Promise<void> {
    if (!plan.ping) return;
    try {
      await this.fetch(`${plan.ping}${suffix}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    } catch {
      this.options.log("backup ping not sent");
    }
  }

  private load(): BackupState {
    // No state means a new server: its platform is still empty or being
    // restored, and an empty backup must not become the latest one.
    if (!existsSync(this.path)) return { attempts: 0, day: backupDay(this.now()) };
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as BackupState;
    } catch {
      return { attempts: 0 };
    }
  }

  private save(): void {
    try {
      writeIfChanged(this.path, JSON.stringify(this.state), 0o600);
    } catch (error) {
      this.options.log("backup state not saved", { error: (error as Error).message });
    }
  }
}
