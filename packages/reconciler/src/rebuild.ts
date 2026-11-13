import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ALLOWED_EXTENSIONS, PLATFORM_IMAGES, type AppManifest } from "@bivouac/manifest";
import { REBUILD_CONTAINERS, checked, dumpsFit, lastLine, runOneOff, runRestic, type BackupPlan } from "./backup.js";
import { POCKET_ID_DATABASE, joinPlatformNetworks, postgresServer, type Runtime } from "./base.js";
import { acquireLock, releaseLock } from "./lock.js";
import { countIn, databaseName, ensureDatabase } from "./postgres.js";
import { listSnapshots, loadDump, volumeNames, type Snapshot } from "./restore.js";
import { deriveSecret, type PlatformSecrets } from "./secrets.js";

/**
 * Rebuilding a server from the backups (D91). `bivy rebuild` places a
 * marker in /etc/bivouac before the deploy key and the age key:
 *
 *   {"mode": "rebuild"}   a real rebuild
 *   {"mode": "test"}      `bivy rebuild --test`: a temporary copy of the platform
 *
 * Until the data is back (`restore-platform`, below), a pass only starts the
 * networks and Postgres: Pocket ID and the apps must never start on empty
 * databases, and no empty platform may become the latest backup. In test
 * mode, for the life of the server, nothing is ever written to the backups
 * and nothing reaches the owner (alerts, healthchecks.io), since the real
 * server is still running.
 */

export const DEFAULT_MARKER = "/etc/bivouac/rebuild.json";

const markerSchema = z.object({ mode: z.enum(["rebuild", "test"]) }).strict();
export type RebuildMode = z.infer<typeof markerSchema>["mode"];

export interface RebuildState {
  mode: RebuildMode;
  /** True until restore-platform has brought the data back. */
  waiting: boolean;
}

const restoredFile = (stateDir: string) => join(stateDir, "rebuild", "restored.json");
const progressFile = (stateDir: string) => join(stateDir, "rebuild", "progress.json");

/**
 * The marker, read on every pass: it is placed while the reconciler already
 * runs. A marker that cannot be read stops the pass: guessing could start an
 * empty platform, or let a test server write to the backups.
 */
export function readRebuildState(marker: string, stateDir: string): RebuildState | undefined {
  if (!existsSync(marker)) return undefined;
  let parsed: z.infer<typeof markerSchema>;
  try {
    parsed = markerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (error) {
    throw new Error(`the rebuild marker ${marker} cannot be read, nothing is applied: ${(error as Error).message}`);
  }
  return { mode: parsed.mode, waiting: !existsSync(restoredFile(stateDir)) };
}

interface Progress {
  snapshot: string;
  /** Databases this restore loaded completely (each in one transaction). */
  databases: string[];
  /** Volumes this restore started to fill: restic can be run again on them. */
  volumes: string[];
}

function readProgress(stateDir: string): Progress | undefined {
  try {
    return JSON.parse(readFileSync(progressFile(stateDir), "utf8")) as Progress;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

export interface PlatformRestoreOptions {
  snapshot?: string;
  list: boolean;
  yes: boolean;
}

export function parsePlatformRestoreArgs(args: string[]): PlatformRestoreOptions {
  const options: PlatformRestoreOptions = { list: false, yes: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--list") options.list = true;
    else if (flag === "--yes") options.yes = true;
    else if (flag === "--snapshot") {
      const id = args[++index];
      if (!id || !/^[0-9a-f]{8,64}$/.test(id)) throw new Error("--snapshot takes a snapshot ID, as --list shows it");
      options.snapshot = id;
    } else throw new Error(`unknown option ${flag}; usage: restore-platform [--list] [--snapshot <id>] [--yes]`);
  }
  return options;
}

/**
 * The copy a rebuild starts from: the one named, or the latest `nightly`
 * one. Never an `incomplete` or `pre-restore` copy unless named: the first
 * lacks something, the second holds one app only.
 */
export function chooseRebuildSnapshot(snapshots: Snapshot[], wanted?: string): Snapshot {
  if (wanted) {
    const found = snapshots.filter((entry) => entry.id.startsWith(wanted) || entry.short_id === wanted);
    if (found.length !== 1) throw new Error(found.length === 0 ? `no copy ${wanted}` : `${wanted} names several copies: give more characters`);
    return found[0] as Snapshot;
  }
  const latest = snapshots
    .filter((entry) => entry.tags?.includes("nightly"))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .at(-1);
  if (!latest) throw new Error("the repository holds no nightly copy");
  return latest;
}

/** What a rebuild restores: Pocket ID's database, then each app's database and volumes. */
export function rebuildTargets(apps: AppManifest[]): { databases: string[]; volumes: { app: string; volume: string }[] } {
  return {
    databases: [POCKET_ID_DATABASE, ...apps.filter((app) => app.database).map((app) => databaseName(app.name))],
    volumes: apps.flatMap((app) => volumeNames(app).map((volume) => ({ app: app.name, volume }))),
  };
}

/**
 * Relations the database's own role made: an extension's own tables and views
 * (PostGIS's `spatial_ref_sys`) do not count. Read from the catalogs only.
 */
const OWN_RELATIONS = `SELECT count(*) AS count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')`;
/**
 * Pocket ID's accounts, counted by the superuser in a database Pocket ID's
 * role controls: only if \`users\` is a plain table, which runs no code of
 * that role when read (a view could call its functions, D75).
 */
const POCKET_ID_USERS_IS_TABLE = "SELECT count(*) AS count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'users' AND c.relkind = 'r'";
const POCKET_ID_USERS = "SELECT count(*) AS count FROM public.users";
const MINUTE = 60_000;
const TIMEOUT = 110 * MINUTE;
const [READ_CONTAINER, RESTIC_CONTAINER, LOAD_CONTAINER] = REBUILD_CONTAINERS as [string, string, string];

type Log = (message: string, fields?: Record<string, unknown>) => void;

export interface PlatformRestoreContext {
  runtime: Runtime;
  plan: BackupPlan;
  secrets: PlatformSecrets;
  apps: AppManifest[];
  marker: string;
  log: Log;
}

/**
 * The extensions a dump names. Its own role may have created trusted ones
 * itself (Pocket ID v2.19.2 creates `citext` and `pgcrypto`, observed): the
 * role cannot always create them again, so the platform does, as for the
 * declared ones, and only from the allowlist (D56). Read in a container with
 * no network.
 */
async function dumpExtensions(runtime: Runtime, dumpDir: string, database: string): Promise<string[]> {
  const result = await runOneOff(runtime, {
    name: LOAD_CONTAINER,
    image: PLATFORM_IMAGES.postgres,
    cmd: ["sh", "-c", 'pg_restore --list "/dumps/$1.dump" | sed -n "s/^[0-9]*; [0-9]* [0-9]* EXTENSION - \\([a-z0-9_]*\\) .*$/\\1/p"', "sh", database],
    mounts: [{ type: "bind", source: dumpDir, target: "/dumps", readOnly: true }],
    networks: {},
  }, 10 * MINUTE);
  if (result.exitCode !== 0) throw new Error(`reading the dump of ${database} failed (exit ${result.exitCode}): ${lastLine(result.logs)}`);
  const names = result.logs.split("\n").map((line) => line.trim()).filter((line) => /^[a-z0-9_]+$/.test(line));
  const refused = names.filter((name) => !(ALLOWED_EXTENSIONS as readonly string[]).includes(name));
  if (refused.length > 0) throw new Error(`the dump of ${database} uses extensions the platform does not allow: ${refused.join(", ")}`);
  return names;
}

function parseJsonLine<T>(output: string): T {
  const line = output.split("\n").find((entry) => entry.startsWith("{"));
  if (!line) throw new Error(`restic gave no answer: ${lastLine(output)}`);
  return JSON.parse(line) as T;
}

/** Paths the copy holds directly under a directory (`restic ls`, read only). */
async function listed(context: PlatformRestoreContext, snapshot: string, directory: string): Promise<Set<string>> {
  const result = await runRestic(context.runtime, context.plan, 10 * MINUTE, ["ls", "--no-lock", "--json", snapshot, directory], [], READ_CONTAINER);
  if (result.exitCode !== 0) throw new Error(`restic ls failed (exit ${result.exitCode}): ${lastLine(result.logs)}`);
  const names = new Set<string>();
  const pattern = new RegExp(`"path":"${directory.replace(/\//g, "\\/")}\\/([^"/]+)"`);
  for (const line of result.logs.split("\n")) {
    const match = pattern.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/**
 * Brings the whole platform's data back on a server waiting for it. Every
 * restic call reads with `--no-lock`: a rebuild writes nothing to the
 * repository, and a test server never may.
 */
export async function restorePlatform(context: PlatformRestoreContext, options: PlatformRestoreOptions): Promise<void> {
  const { runtime, plan, secrets, apps, log } = context;
  const { stateDir } = runtime;
  const state = readRebuildState(context.marker, stateDir);
  // Never on a running platform: only on a server that waits for its data.
  if (!state) throw new Error(`this server is not being rebuilt (no ${context.marker}): use restore-app to restore one app`);
  if (!state.waiting) throw new Error("this server's data was already restored: use restore-app to restore one app");

  const snapshots = await listSnapshots(runtime, plan, READ_CONTAINER);
  if (options.list) {
    for (const entry of snapshots) log("copy", { id: entry.short_id, time: entry.time, tags: entry.tags ?? [] });
    return;
  }
  const progress = readProgress(stateDir);
  const chosen = chooseRebuildSnapshot(snapshots, options.snapshot ?? progress?.snapshot);
  if (progress && !chosen.id.startsWith(progress.snapshot) && chosen.short_id !== progress.snapshot) {
    throw new Error(`an earlier run started from copy ${progress.snapshot}: finish with that one (--snapshot ${progress.snapshot})`);
  }
  const { databases, volumes } = rebuildTargets(apps);
  const dumps = await listed(context, chosen.id, "/source/dumps");
  const inCopy = await listed(context, chosen.id, "/source/volumes");
  if (!dumps.has(`${POCKET_ID_DATABASE}.dump`)) throw new Error(`copy ${chosen.short_id} holds no dump of Pocket ID: choose another one`);
  const missingDumps = databases.filter((database) => !dumps.has(`${database}.dump`));
  const missingVolumes = volumes.filter((entry) => !inCopy.has(entry.volume)).map((entry) => entry.volume);
  const size = await runRestic(runtime, plan, 10 * MINUTE, ["stats", "--no-lock", "--json", "--mode", "restore-size", chosen.id], [], READ_CONTAINER);
  if (size.exitCode !== 0) throw new Error(`restic stats failed (exit ${size.exitCode}): ${lastLine(size.logs)}`);
  const bytes = parseJsonLine<{ total_size: number }>(size.logs).total_size;
  log("rebuild plan", {
    mode: state.mode,
    copy: chosen.short_id,
    taken: chosen.time,
    size: `${(bytes / 1073741824).toFixed(2)} GiB`,
    databases: databases.filter((database) => !missingDumps.includes(database)),
    volumes: volumes.map((entry) => entry.volume).filter((volume) => !missingVolumes.includes(volume)),
    ...(missingDumps.length + missingVolumes.length > 0 ? { startEmpty: [...missingDumps, ...missingVolumes] } : {}),
  });
  if (!options.yes) {
    log("nothing changed: add --yes to restore");
    return;
  }
  const { bavail, bsize } = statfsSync(stateDir);
  // The dumps on disk, then loaded into Postgres, plus the files.
  if (!dumpsFit(bytes * 2, bavail * bsize)) throw new Error(`not enough free disk to restore ${Math.ceil(bytes / 1048576)} MiB`);

  // No app named: a restart during it must not mark an app as half restored (lock.ts).
  const lock = { job: "restore" as const, startedAt: Date.now() };
  const holder = acquireLock(stateDir, lock);
  if (holder) throw new Error(`a ${holder.job}${holder.app ? ` of ${holder.app}` : ""} is running: try again once it is over`);
  const work = join(stateDir, "rebuild", "work");
  const record: Progress = progress ?? { snapshot: chosen.short_id, databases: [], volumes: [] };
  const started = Date.now();
  try {
    writeJson(progressFile(stateDir), record);
    await joinPlatformNetworks(runtime);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "backup", "cache"), { recursive: true, mode: 0o700 });
    const server = postgresServer(secrets);

    await checked("restic restore of the dumps", runRestic(
      runtime, plan, TIMEOUT,
      ["restore", "--no-lock", chosen.id, "--include", "/source/dumps", "--target", "/restore"],
      [{ type: "bind", source: work, target: "/restore" }],
      RESTIC_CONTAINER,
    ));
    const dumpDir = join(work, "source", "dumps");
    for (const database of databases) {
      if (missingDumps.includes(database)) continue;
      if (!existsSync(join(dumpDir, `${database}.dump`))) throw new Error(`the dump of ${database} did not come back from the copy`);
      const app = apps.find((entry) => databaseName(entry.name) === database);
      const password = deriveSecret(secrets.master_secret, `db:${database}`);
      const extensions = [...new Set([...(app?.database?.extensions ?? []), ...(await dumpExtensions(runtime, dumpDir, database))])];
      await ensureDatabase(server, { name: database, password, extensions });
      // Never into a database that holds data: this only fills empty ones. A
      // database this restore started is loaded in one transaction, so it is
      // either whole (done) or still empty (to load again).
      const started = record.databases.includes(database);
      if ((await countIn(server, database, OWN_RELATIONS)) > 0) {
        if (started) continue;
        throw new Error(`${database} already holds tables, and this restore did not load them: refusing to load over them`);
      }
      if (!started) {
        record.databases.push(database);
        writeJson(progressFile(stateDir), record);
      }
      const begin = Date.now();
      await loadDump(runtime, database, database, dumpDir, password, LOAD_CONTAINER);
      log("database restored", { database, relations: await countIn(server, database, OWN_RELATIONS), seconds: Math.round((Date.now() - begin) / 1000) });
    }
    rmSync(work, { recursive: true, force: true });

    for (const { volume } of volumes) {
      if (missingVolumes.includes(volume)) continue;
      // Only into a volume no container used yet, or one this restore started.
      if (!record.volumes.includes(volume) && (await runtime.docker.volumeExists(volume))) {
        throw new Error(`the volume ${volume} already exists, and this restore did not create it: refusing to write into it`);
      }
      record.volumes.push(volume);
      writeJson(progressFile(stateDir), record);
      const begin = Date.now();
      const result = await runRestic(
        runtime, plan, TIMEOUT,
        ["restore", "--no-lock", `${chosen.id}:/source/volumes`, "--target", "/restore", "--include", `/${volume}`],
        [{ type: "volume", source: volume, target: `/restore/${volume}` }],
        RESTIC_CONTAINER,
      );
      if (result.exitCode !== 0) throw new Error(`restic restore of ${volume} failed (exit ${result.exitCode}): ${lastLine(result.logs)}`);
      log("volume restored", { volume, summary: lastLine(result.logs), seconds: Math.round((Date.now() - begin) / 1000) });
    }

    // Compared with the real server by `bivy rebuild`, which can read both.
    if ((await countIn(server, POCKET_ID_DATABASE, POCKET_ID_USERS_IS_TABLE)) !== 1) throw new Error("Pocket ID came back without its users table");
    const users = await countIn(server, POCKET_ID_DATABASE, POCKET_ID_USERS);
    writeJson(restoredFile(stateDir), { snapshot: chosen.short_id, taken: chosen.time, restoredAt: new Date().toISOString() });
    rmSync(progressFile(stateDir), { force: true });
    log("platform restored", {
      copy: chosen.short_id,
      pocketIdUsers: users,
      seconds: Math.round((Date.now() - started) / 1000),
      ...(missingDumps.length + missingVolumes.length > 0 ? { startEmpty: [...missingDumps, ...missingVolumes] } : {}),
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}. Pocket ID and the apps stay stopped; run restore-platform again to carry on.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    releaseLock(stateDir, lock);
  }
}

