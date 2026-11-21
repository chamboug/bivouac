import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_CONTAINERS, PLATFORM_IMAGES } from "@bivouac/manifest";
import { BACKUP_CONTAINER, POCKET_ID_USERS, POCKET_ID_USERS_IS_TABLE, RESTIC_HOST, checked, dumpDatabase, lastLine, runRestic, type BackupPlan } from "./backup.js";
import { POCKET_ID_DATABASE, joinPlatformNetworks, postgresServer, type Runtime } from "./base.js";
import { waitHealthy } from "./containers.js";
import { POCKET_ID_RESTORE, acquireLock, interruptedFile, interruptedRestore, markInterrupted, readLock, releaseLock } from "./lock.js";
import { countIn, createRestoreTarget, databaseExists, databasesBytes, swapDatabases, type PostgresServer } from "./postgres.js";
import { dumpExtensions } from "./rebuild.js";
import { PRE_RESTORE_TAG, chooseSnapshot, diskNeeded, freeDisk, listSnapshots, loadDump, parseRestoreArgs, previousName, restoringName } from "./restore.js";
import { deriveSecret, type PlatformSecrets } from "./secrets.js";

/**
 * Bringing Pocket ID's database back to a nightly copy (runbook section 22),
 * for an update of Pocket ID that broke it: an older Pocket ID refuses a
 * database a newer one migrated, so putting the previous reconciler back is
 * not enough (D109). Beside the running reconciler, like restore-app:
 *
 *   docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-pocket-id [options]
 *
 * Without `--yes` it only says what it would do. The same steps as
 * restore-app (restore.ts), for one database and no volume:
 *
 *   1. Pocket ID is stopped; passes leave it stopped and stop after Postgres
 *      (pass.ts), so the apps and Caddy stay as they run;
 *   2. its current database is sent to restic, tagged `pre-restore` and
 *      `platform:pocket-id`: the restore can be undone;
 *   3. the copy's dump is loaded beside the live database, as Pocket ID's own
 *      role, never as superuser, then the two are swapped in one transaction;
 *      the replaced one is kept, renamed;
 *   4. Pocket ID is started again and its health checked. A container on
 *      another image than the running reconciler names (one left from before
 *      the previous version came back, while passes held it) is removed
 *      instead: the next pass creates it on the right image.
 *
 * The person chooses the order: if an update is the cause, the previous
 * reconciler must run first, or the new Pocket ID migrates the restored
 * database again. The plan gives what they need to see it.
 */

const MINUTE = 60_000;
const TIMEOUT = 90 * MINUTE;
// The containers of restore-app: one restore at a time, and they are already cleared after a restart (backup.ts).
const [RESTIC_CONTAINER, DUMP_CONTAINER, LOAD_CONTAINER] = ["bivouac-restore-app", "bivouac-restore-app-dump", "bivouac-restore-app-load"] as const;
export const POCKET_ID_TAG = "platform:pocket-id";

export interface PocketIdRestoreOptions {
  list: boolean;
  snapshot?: string;
  before?: number;
  yes: boolean;
}

export function parsePocketIdRestoreArgs(args: string[]): PocketIdRestoreOptions {
  if (args.includes("--only")) throw new Error("--only is for apps: Pocket ID has only a database");
  const { list, snapshot, before, yes } = parseRestoreArgs(["pocket-id", ...args]);
  return { list, yes, ...(snapshot ? { snapshot } : {}), ...(before !== undefined ? { before } : {}) };
}

type Log = (message: string, fields?: Record<string, unknown>) => void;

export interface PocketIdRestoreContext {
  runtime: Runtime;
  plan: BackupPlan;
  secrets: PlatformSecrets;
  log: Log;
  now?: () => Date;
}

/**
 * Pocket ID's accounts, read as superuser in a database its role controls:
 * only once the catalog says `users` is a plain table (a view could run that
 * role's code, D75). Undefined when it is not one, or there is no database.
 */
async function accounts(server: PostgresServer, database: string): Promise<number | undefined> {
  if ((await countIn(server, database, POCKET_ID_USERS_IS_TABLE)) !== 1) return undefined;
  return countIn(server, database, POCKET_ID_USERS);
}

export async function restorePocketId(context: PocketIdRestoreContext, options: PocketIdRestoreOptions): Promise<void> {
  const { runtime, plan, secrets, log } = context;
  const { docker, stateDir } = runtime;
  const database = POCKET_ID_DATABASE;
  const container = PLATFORM_CONTAINERS.pocketId;

  const snapshots = await listSnapshots(runtime, plan);
  if (options.list) {
    for (const entry of snapshots) log("copy", { id: entry.short_id, time: entry.time, tags: entry.tags ?? [] });
    return;
  }
  const chosen = chooseSnapshot(snapshots, options);
  const now = (context.now ?? (() => new Date()))();
  const previous = previousName(database, now);
  const server = postgresServer(secrets);
  await joinPlatformNetworks(runtime);
  const exists = await databaseExists(server, database);
  const databaseBytes = exists ? await databasesBytes(server, [database]) : 0;
  const neededBytes = diskNeeded(databaseBytes, true);
  const freeBytes = freeDisk(stateDir);
  const busy = readLock(stateDir);
  const running = await docker.inspectContainer(container);
  // What a person (or bivy restore) needs to decide, read before anything changes.
  // The same fields as restore-app's plan, and what Pocket ID runs now.
  log("restore plan", {
    app: "pocket-id",
    copy: chosen.short_id,
    taken: chosen.time,
    database: `${database} (the current one kept as ${previous})`,
    volumes: "untouched",
    restores: { database: true, files: false },
    databaseBytes,
    neededBytes,
    freeBytes,
    ...(busy ? { busy: `${busy.job}${busy.app ? ` of ${busy.app === POCKET_ID_RESTORE ? "Pocket ID" : busy.app}` : ""}` } : {}),
    interrupted: interruptedRestore(stateDir, POCKET_ID_RESTORE),
    ...(running?.Created ? { deployedAt: running.Created, image: running.Config.Image } : {}),
    pocketId: running ? (running.State.Running ? (running.State.Health?.Status ?? "running") : running.State.Status) : "missing",
    ...(exists ? { users: (await accounts(server, database)) ?? null } : {}),
  });
  if (!options.yes) {
    log("nothing changed: add --yes to restore");
    return;
  }
  if (freeBytes < neededBytes) {
    throw new Error(`not enough free disk: about ${(neededBytes / 1024 ** 3).toFixed(1)} GiB needed, ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free. Nothing was changed`);
  }

  const lock = { job: "restore" as const, app: POCKET_ID_RESTORE, startedAt: now.getTime() };
  const holder = acquireLock(stateDir, lock);
  if (holder) throw new Error(`a ${holder.job}${holder.app ? ` of ${holder.app}` : ""} is running: try again once it is over`);
  for (const name of [BACKUP_CONTAINER, `${BACKUP_CONTAINER}-dump`, "bivouac-restore-test"]) {
    if (await docker.inspectContainer(name)) {
      releaseLock(stateDir, lock);
      throw new Error(`${name} is running: try again once the backup is over`);
    }
  }
  const work = join(stateDir, "backup", "restore-app");
  const resuming = interruptedRestore(stateDir, POCKET_ID_RESTORE);
  /**
   * A pass that read no lock just before it was taken may still be starting
   * Pocket ID: checked again right before its database changes.
   */
  const ensureStopped = async () => {
    if ((await docker.inspectContainer(container))?.State.Running) {
      throw new Error(`${container} was started by someone else meanwhile: run the restore again`);
    }
  };
  let safety: string | undefined;
  let done = false;
  /** Set once the live database is about to change: a failure past it keeps Pocket ID stopped. */
  let changing = false;
  let users: number | undefined;
  /** Removed rather than started: its image is not the one the reconciler names. */
  let recreate = false;
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "dumps"), { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "backup", "cache"), { recursive: true, mode: 0o700 });
    const wasRunning = running?.State.Running === true;
    if ((await docker.inspectContainer(container))?.State.Running) await docker.stopContainer(container);
    log("app stopped", { app: "pocket-id", wasRunning });

    // 1. The safety copy: nothing is changed unless it was sent.
    if (await databaseExists(server, database)) await dumpDatabase(runtime, database, join(work, "dumps"), TIMEOUT, DUMP_CONTAINER);
    const sent = await runRestic(
      runtime,
      plan,
      TIMEOUT,
      ["backup", "--host", RESTIC_HOST, "--tag", PRE_RESTORE_TAG, "--tag", POCKET_ID_TAG, "/source"],
      [{ type: "bind", source: join(work, "dumps"), target: "/source/dumps", readOnly: true }],
      RESTIC_CONTAINER,
    );
    if (sent.exitCode !== 0) throw new Error(`the safety copy failed (exit ${sent.exitCode}): ${lastLine(sent.logs)}`);
    safety = (await listSnapshots(runtime, plan))
      .filter((entry) => entry.tags?.includes(PRE_RESTORE_TAG) && entry.tags.includes(POCKET_ID_TAG))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      .at(-1)?.short_id;
    if (!safety) throw new Error("the safety copy cannot be found in the repository");
    log("safety copy sent", { copy: safety });

    // 2. The copy's dump, loaded beside the live database, then swapped.
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
    if (!existsSync(join(dumps, `${database}.dump`))) throw new Error(`copy ${chosen.short_id} holds no dump of Pocket ID: choose another one`);
    // Pocket ID creates trusted extensions itself (citext, pgcrypto): the platform does, from the allowlist (D56).
    const extensions = await dumpExtensions(runtime, dumps, database, LOAD_CONTAINER);
    const incoming = restoringName(database);
    await createRestoreTarget(server, incoming, database, extensions);
    await loadDump(runtime, database, incoming, dumps, deriveSecret(secrets.master_secret, `db:${database}`), LOAD_CONTAINER);
    users = await accounts(server, incoming);
    if (users === undefined) throw new Error("the copy's Pocket ID database has no plain users table: refusing to put it in place");
    // Everyone would be locked out, with the first-admin page closed (D15).
    const today = exists ? await accounts(server, database) : undefined;
    if (users === 0 && (today ?? 0) > 0) throw new Error(`the copy holds no account, and Pocket ID has ${today} today: refusing to put it in place`);
    await ensureStopped();
    changing = true;
    await swapDatabases(server, database, incoming, previous);
    log("database restored", { database, kept: previous, users });
    rmSync(interruptedFile(stateDir, POCKET_ID_RESTORE), { force: true });
    const current = await docker.inspectContainer(container);
    if (current && current.Config.Image !== PLATFORM_IMAGES.pocketId) {
      // Started as it is, the image that broke it would migrate the restored database again.
      await docker.removeContainer(container);
      recreate = true;
      log("pocket id container removed", { image: current.Config.Image, next: PLATFORM_IMAGES.pocketId });
    }
    done = true;
  } catch (error) {
    if (changing || resuming) markInterrupted(stateDir, POCKET_ID_RESTORE, now.getTime());
    const undo = safety ? ` Safety copy of the database before this restore: ${safety}.` : "";
    log("restore stopped", { changed: changing || resuming });
    throw new Error(`${(error as Error).message}.${changing || resuming ? " Pocket ID stays stopped: run the restore again, or restore the safety copy." : " Nothing was changed."}${undo}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    releaseLock(stateDir, lock);
    // Started again whether or not it ran before: a pass would start it anyway.
    // Not after a failure that changed it, nor while an earlier one is still unfinished.
    if (!recreate && (done || (!changing && !resuming))) await docker.startContainer(container).catch((error: Error) => log("app not started again", { error: error.message }));
  }
  log("restore done", {
    app: "pocket-id",
    copy: chosen.short_id,
    undo: `restore-pocket-id --snapshot ${safety} --yes`,
    previousDatabase: previous,
    users,
  });
  try {
    // A container removed above comes back with the reconciler's next pass, within its interval.
    await waitHealthy(docker, container, runtime.healthTimeout + (recreate ? 180 : 0));
  } catch (error) {
    throw new Error(
      `the database is back, but Pocket ID is not healthy: ${(error as Error).message}. If an update broke it, a reconciler with the previous Pocket ID must run first (runbook section 22), then this restore runs again`,
    );
  }
}
