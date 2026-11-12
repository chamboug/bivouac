import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_CONTAINERS, PLATFORM_IMAGES, PLATFORM_NETWORKS, appContainerName, type AppManifest } from "@bivouac/manifest";
import { checkHealth } from "./apps.js";
import { BACKUP_CONTAINER, RESTIC_HOST, checked, dumpDatabase, lastLine, runOneOff, runRestic, type BackupPlan } from "./backup.js";
import { joinPlatformNetworks, postgresServer, type Runtime } from "./base.js";
import { waitFor } from "./containers.js";
import { acquireLock, interruptedFile, releaseLock } from "./lock.js";
import { createRestoreTarget, databaseExists, databaseName, swapDatabases } from "./postgres.js";
import { deriveSecret, type PlatformSecrets } from "./secrets.js";

/**
 * Restoring one app's data from a nightly copy (runbook section 14), without
 * touching the other apps or Pocket ID. Run by hand on the server:
 *
 *   docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-app <app> [options]
 *
 * Without `--yes` it only says what it would do. In order, each step only
 * once the previous one worked:
 *
 *   1. the app's current database and volumes are sent to restic, tagged
 *      `pre-restore`: the restore itself can be undone, and what was written
 *      since the chosen copy is not lost;
 *   2. the app is stopped; passes and backups leave it alone (lock.ts);
 *   3. its dump is loaded into a new database beside the live one, as the
 *      app's own role, never as superuser (a dump comes from a database the
 *      app controls, D75), then the two are swapped in one transaction; the
 *      replaced database is kept, renamed;
 *   4. its volumes are brought back to the copy in place (restic only
 *      rewrites what differs, and removes what the copy does not have);
 *   5. the app is started again and its health checked.
 */

const MINUTE = 60_000;
const TIMEOUT = 90 * MINUTE;
const [RESTIC_CONTAINER, DUMP_CONTAINER, LOAD_CONTAINER, FILES_CONTAINER] = [
  "bivouac-restore-app",
  "bivouac-restore-app-dump",
  "bivouac-restore-app-load",
  "bivouac-restore-app-files",
] as const;
export const PRE_RESTORE_TAG = "pre-restore";

export interface RestoreOptions {
  app: string;
  list: boolean;
  snapshot?: string;
  /** The latest nightly copy taken at or before this time. */
  before?: number;
  only?: "database" | "files";
  yes: boolean;
}

export function parseRestoreArgs(args: string[]): RestoreOptions {
  const [app, ...rest] = args;
  if (!app || app.startsWith("-")) throw new Error("usage: restore-app <app> [--list] [--snapshot <id> | --before <date>] [--only database|files] [--yes]");
  const options: RestoreOptions = { app, list: false, yes: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--list") options.list = true;
    else if (flag === "--yes") options.yes = true;
    else if (flag === "--snapshot") {
      const id = value();
      if (!/^[0-9a-f]{8,64}$/.test(id)) throw new Error("--snapshot takes a snapshot ID, as --list shows it");
      options.snapshot = id;
    } else if (flag === "--before") {
      const text = value();
      // A date alone means the end of that day, in UTC like the backups.
      const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59Z` : text);
      if (Number.isNaN(time)) throw new Error(`--before: '${text}' is not a date (2026-11-12 or 2026-11-12T08:00Z)`);
      options.before = time;
    } else if (flag === "--only") {
      const only = value();
      if (only !== "database" && only !== "files") throw new Error("--only takes 'database' or 'files'");
      options.only = only;
    } else throw new Error(`unknown option ${flag}`);
  }
  if (options.snapshot && options.before !== undefined) throw new Error("--snapshot and --before cannot be used together");
  return options;
}

export interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  tags?: string[];
}

/**
 * The copy to restore: the one named, or the latest nightly one at or before
 * a time, or the latest nightly one. `incomplete` copies are only used when
 * named, and `pre-restore` ones too (they hold only one app).
 */
export function chooseSnapshot(snapshots: Snapshot[], options: Pick<RestoreOptions, "snapshot" | "before">): Snapshot {
  if (options.snapshot) {
    const wanted = options.snapshot;
    const found = snapshots.filter((entry) => entry.id.startsWith(wanted) || entry.short_id === wanted);
    if (found.length !== 1) throw new Error(found.length === 0 ? `no copy ${wanted}` : `${wanted} names several copies: give more characters`);
    return found[0] as Snapshot;
  }
  const nightly = snapshots
    .filter((entry) => entry.tags?.includes("nightly"))
    .filter((entry) => options.before === undefined || Date.parse(entry.time) <= options.before)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const latest = nightly.at(-1);
  if (!latest) throw new Error(options.before === undefined ? "no nightly copy yet" : "no nightly copy at or before that date");
  return latest;
}

/** Postgres names are at most 63 bytes; app names at most 40 (manifest schema). */
export const restoringName = (database: string) => `bivouac_restoring_${database}`;
export function previousName(database: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `bivouac_r${stamp}_${database}`;
}

export const volumeNames = (app: AppManifest) => Object.keys(app.volumes).map((volume) => `${appContainerName(app.name)}_${volume}`);

type Log = (message: string, fields?: Record<string, unknown>) => void;

function parseJsonLine<T>(output: string): T {
  const line = output.split("\n").find((entry) => entry.startsWith("[") || entry.startsWith("{"));
  if (!line) throw new Error(`restic gave no answer: ${lastLine(output)}`);
  return JSON.parse(line) as T;
}

async function listSnapshots(runtime: Runtime, plan: BackupPlan): Promise<Snapshot[]> {
  const result = await runRestic(runtime, plan, 10 * MINUTE, ["snapshots", "--no-lock", "--host", RESTIC_HOST, "--json"], [], RESTIC_CONTAINER);
  if (result.exitCode !== 0) throw new Error(`restic snapshots failed (exit ${result.exitCode}): ${lastLine(result.logs)}`);
  return parseJsonLine<Snapshot[]>(result.logs);
}

/** Which of the app's volumes the copy holds (only their directories are listed). */
async function volumesIn(runtime: Runtime, plan: BackupPlan, snapshot: string): Promise<Set<string>> {
  const result = await runRestic(runtime, plan, 10 * MINUTE, ["ls", "--no-lock", "--json", snapshot, "/source/volumes"], [], RESTIC_CONTAINER);
  if (result.exitCode !== 0) throw new Error(`restic ls failed (exit ${result.exitCode}): ${lastLine(result.logs)}`);
  const present = new Set<string>();
  for (const line of result.logs.split("\n")) {
    const match = /"path":"\/source\/volumes\/([^"/]+)"/.exec(line);
    if (match?.[1]) present.add(match[1]);
  }
  return present;
}

async function stopApp(runtime: Runtime, container: string): Promise<boolean> {
  const info = await runtime.docker.inspectContainer(container);
  if (!info?.State.Running) return false;
  await runtime.docker.stopContainer(container);
  return true;
}

export interface RestoreContext {
  runtime: Runtime;
  plan: BackupPlan;
  secrets: PlatformSecrets;
  apps: AppManifest[];
  log: Log;
  now?: () => Date;
}

export async function restoreApp(context: RestoreContext, options: RestoreOptions): Promise<void> {
  const { runtime, plan, secrets, log } = context;
  const app = context.apps.find((entry) => entry.name === options.app);
  if (!app) throw new Error(`no app '${options.app}' in the instance repo`);
  const database = app.database ? databaseName(app.name) : undefined;
  const volumes = volumeNames(app);
  const wantDatabase = database !== undefined && options.only !== "files";
  const wantFiles = volumes.length > 0 && options.only !== "database";
  if (!wantDatabase && !wantFiles) throw new Error(`${app.name} has no ${options.only === "files" ? "volume" : options.only === "database" ? "database" : "data"} to restore`);

  const snapshots = await listSnapshots(runtime, plan);
  if (options.list) {
    for (const entry of snapshots) log("copy", { id: entry.short_id, time: entry.time, tags: entry.tags ?? [] });
    return;
  }
  const chosen = chooseSnapshot(snapshots, options);
  const present = wantFiles ? await volumesIn(runtime, plan, chosen.id) : new Set<string>();
  const missing = wantFiles ? volumes.filter((volume) => !present.has(volume)) : [];
  if (missing.length > 0) throw new Error(`copy ${chosen.short_id} does not hold ${missing.join(", ")}: choose a later one`);
  const now = (context.now ?? (() => new Date()))();
  const previous = database ? previousName(database, now) : undefined;
  log("restore plan", {
    app: app.name,
    copy: chosen.short_id,
    taken: chosen.time,
    database: wantDatabase ? `${database} (the current one kept as ${previous})` : "untouched",
    volumes: wantFiles ? volumes : "untouched",
  });
  if (!options.yes) {
    log("nothing changed: add --yes to restore");
    return;
  }

  const stateDir = runtime.stateDir;
  const holder = acquireLock(stateDir, { job: "restore", app: app.name, startedAt: now.getTime() });
  if (holder) throw new Error(`a ${holder.job}${holder.app ? ` of ${holder.app}` : ""} is running: try again once it is over`);
  for (const name of [BACKUP_CONTAINER, `${BACKUP_CONTAINER}-dump`, "bivouac-restore-test"]) {
    if (await runtime.docker.inspectContainer(name)) {
      releaseLock(stateDir);
      throw new Error(`${name} is running: try again once the backup is over`);
    }
  }
  const work = join(stateDir, "backup", "restore-app");
  const container = appContainerName(app.name);
  let wasRunning = false;
  let safety: string | undefined;
  /** Set once live data starts changing: a failure past it leaves the app stopped. */
  let changing = false;
  try {
    await joinPlatformNetworks(runtime);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "dumps"), { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "backup", "cache"), { recursive: true, mode: 0o700 });
    wasRunning = await stopApp(runtime, container);
    log("app stopped", { app: app.name, wasRunning });

    // 1. The safety copy: nothing is changed unless it was sent.
    if (database && (await databaseExists(postgresServer(secrets), database))) {
      await dumpDatabase(runtime, database, join(work, "dumps"), TIMEOUT, DUMP_CONTAINER);
    }
    const sent = await runRestic(
      runtime,
      plan,
      TIMEOUT,
      ["backup", "--host", RESTIC_HOST, "--tag", PRE_RESTORE_TAG, "--tag", `app:${app.name}`, "/source"],
      [
        { type: "bind", source: join(work, "dumps"), target: "/source/dumps", readOnly: true },
        ...volumes.map((volume) => ({ type: "volume" as const, source: volume, target: `/source/volumes/${volume}`, readOnly: true })),
      ],
      RESTIC_CONTAINER,
    );
    if (sent.exitCode !== 0) throw new Error(`the safety copy failed (exit ${sent.exitCode}): ${lastLine(sent.logs)}`);
    // Read back from the repository: the container's output is only kept in part.
    safety = (await listSnapshots(runtime, plan))
      .filter((entry) => entry.tags?.includes(PRE_RESTORE_TAG) && entry.tags.includes(`app:${app.name}`))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      .at(-1)?.short_id;
    if (!safety) throw new Error("the safety copy cannot be found in the repository");
    log("safety copy sent", { copy: safety });

    // 2. The database, beside the live one, then swapped.
    if (wantDatabase && database && previous) {
      const restoreDir = join(work, "restore");
      mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
      await checked("restic restore of the dump", runRestic(
        runtime,
        plan,
        TIMEOUT,
        ["restore", "--no-lock", chosen.id, "--include", `/source/dumps/${database}.dump`, "--target", "/restore"],
        [{ type: "bind", source: restoreDir, target: "/restore" }],
        RESTIC_CONTAINER,
      ));
      const dumps = join(restoreDir, "source", "dumps");
      if (!existsSync(join(dumps, `${database}.dump`))) throw new Error(`copy ${chosen.short_id} holds no dump of ${database}: choose a later one`);
      const server = postgresServer(secrets);
      const incoming = restoringName(database);
      await createRestoreTarget(server, incoming, database, app.database?.extensions ?? []);
      await loadDump(runtime, database, incoming, dumps, deriveSecret(secrets.master_secret, `db:${database}`));
      changing = true;
      await swapDatabases(server, database, incoming, previous);
      log("database restored", { database, kept: previous });
    }

    // 3. The volumes, in place.
    if (wantFiles) {
      for (const volume of volumes) {
        changing = true;
        await checked(`restic restore of ${volume}`, runRestic(
          runtime,
          plan,
          TIMEOUT,
          // --delete only within --include (verified, restic docs): nothing outside this volume.
          ["restore", "--no-lock", `${chosen.id}:/source/volumes`, "--target", "/restore", "--include", `/${volume}`, "--delete"],
          [{ type: "volume", source: volume, target: `/restore/${volume}` }],
          FILES_CONTAINER,
        ));
        log("volume restored", { volume });
      }
    }
    rmSync(interruptedFile(stateDir), { force: true });
  } catch (error) {
    if (changing) {
      // Half restored: the app must not run on it. Passes report it until a restore completes.
      writeFileSync(interruptedFile(stateDir), JSON.stringify({ job: "restore", app: app.name, startedAt: now.getTime() }), { mode: 0o600 });
      wasRunning = false;
    }
    const undo = safety ? ` Safety copy of the data before this restore: ${safety}.` : "";
    throw new Error(`${(error as Error).message}.${changing ? " The app stays stopped: run the restore again, or restore the safety copy." : " Nothing was changed."}${undo}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    releaseLock(stateDir);
    if (wasRunning) await runtime.docker.startContainer(container).catch((error: Error) => log("app not started again", { error: error.message }));
  }
  if (wasRunning) {
    await waitFor(() => checkHealth(container, app), runtime.healthTimeout, `${app.name}'s health check`);
  }
  log("restore done", {
    app: app.name,
    copy: chosen.short_id,
    undo: safety ? `restore-app ${app.name} --snapshot ${safety} --yes` : undefined,
    ...(wantDatabase ? { previousDatabase: previous } : {}),
  });
}

/**
 * pg_restore as the app's role, into the new database it owns, in one
 * transaction. Left out of the dump's list: extensions, which the platform
 * created as superuser, and what the superuser owns, such as an extension's
 * own table (PostGIS's `spatial_ref_sys`, observed): the role may not write
 * them, and the extension brought them back already.
 */
async function loadDump(runtime: Runtime, role: string, target: string, dumps: string, password: string): Promise<void> {
  await checked(`loading the dump of ${role}`, runOneOff(runtime, {
    name: LOAD_CONTAINER,
    image: PLATFORM_IMAGES.postgres,
    env: { PGPASSWORD: password },
    cmd: [
      "sh", "-c",
      `pg_restore --list "/dumps/$1.dump" | grep -v -e ' EXTENSION ' -e ' postgres$' > /tmp/list && pg_restore --host ${PLATFORM_CONTAINERS.postgres} --username "$1" --dbname "$2" --no-owner --no-privileges --exit-on-error --single-transaction --use-list /tmp/list "/dumps/$1.dump"`,
      "sh", role, target,
    ],
    mounts: [{ type: "bind", source: dumps, target: "/dumps", readOnly: true }],
    networks: { [PLATFORM_NETWORKS.internal.name]: null },
  }, TIMEOUT));
}
