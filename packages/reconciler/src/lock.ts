import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One job at a time touches the backups: the nightly backup (with its
 * clean-up and restore test) or the restore of one app. They run in
 * different processes (the restore through `docker exec`), so the lock is a
 * file created only if it does not exist yet.
 */
export interface JobLock {
  job: "backup" | "restore";
  /** For a restore: the app being restored, which passes leave alone meanwhile. */
  app?: string;
  startedAt: number;
}

export const lockFile = (stateDir: string) => join(stateDir, "backup", "lock.json");
export const interruptedFile = (stateDir: string) => join(stateDir, "backup", "restore-interrupted.json");

/** Takes the lock, or returns the job holding it. */
export function acquireLock(stateDir: string, lock: JobLock): JobLock | undefined {
  const path = lockFile(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readLock(stateDir) ?? lock;
  }
}

export function readLock(stateDir: string): JobLock | undefined {
  try {
    return JSON.parse(readFileSync(lockFile(stateDir), "utf8")) as JobLock;
  } catch {
    return undefined;
  }
}

export function releaseLock(stateDir: string): void {
  rmSync(lockFile(stateDir), { force: true });
}

/** The app a running restore has stopped, which a pass must not touch. */
export function appBeingRestored(stateDir: string): string | undefined {
  const lock = readLock(stateDir);
  return lock?.job === "restore" ? lock.app : undefined;
}

/**
 * At the reconciler's start nothing else can be running: a restore runs
 * inside its container, and stopped with it. A lock left behind is removed;
 * if it was a restore, the app's data may be half restored, so its app is
 * kept stopped and reported until a restore of it completes.
 */
export function clearStaleLock(stateDir: string): JobLock | undefined {
  const lock = readLock(stateDir);
  if (!lock && !existsSync(lockFile(stateDir))) return undefined;
  if (lock?.job === "restore" && lock.app) {
    writeFileSync(interruptedFile(stateDir) + ".new", JSON.stringify(lock), { mode: 0o600 });
    renameSync(interruptedFile(stateDir) + ".new", interruptedFile(stateDir));
  }
  releaseLock(stateDir);
  return lock;
}

/** The app whose restore was interrupted, if any. */
export function interruptedRestore(stateDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(interruptedFile(stateDir), "utf8")) as JobLock).app;
  } catch {
    return undefined;
  }
}
