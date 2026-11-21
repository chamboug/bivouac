import { parseLines, size, when, type RunResult } from "./restore.js";

/**
 * `bivy status` and `bivy backup` (D104): what Claude checked by hand over
 * SSH at the start of every session, and the backup asked for before any
 * change that can lose data (D89), each as one command the owner can run
 * too. The work is the reconciler's own `main.js status` and `backup-now`,
 * run beside it with `docker exec`, as `bivy restore` does.
 */

const RECONCILER = "bivouac-reconciler";
const MAIN = "packages/reconciler/dist/main.js";
/** The exit status of the commands below when the reconciler predates them. */
export const TOO_OLD = 3;

/**
 * Runs a command of main.js, only if the reconciler knows it: an older
 * version would take an unknown command for its main loop and start a second
 * reconciler beside the first. Its compiled code names every command it knows.
 */
export function reconcilerCommand(command: "status" | "backup-now", args: readonly string[] = []): string {
  const known = `docker exec ${RECONCILER} grep -qF '"backup-now"' ${MAIN}`;
  const run = ["docker", "exec", RECONCILER, "node", MAIN, command, ...args].join(" ");
  return `if ${known}; then exec ${run}; else echo 'this reconciler predates bivy status and bivy backup' >&2; exit ${TOO_OLD}; fi`;
}

export interface ContainerState {
  name: string;
  kind: "app" | "platform";
  image: string;
  state: string;
  health: string | null;
  startedAt: string;
  restarts: number;
  oomKilled: boolean;
  memory: { usedBytes: number; limitBytes: number } | null;
}

export interface PlatformState {
  generatedAt: string;
  reconciler: { image: string | null; startedAt: string | null };
  lastPass: { at: string; status: string; commit?: string; changes: string[]; failures: { app: string; message: string }[] } | null;
  containers: ContainerState[];
  backup: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    restoreTestWeekPassed: number | null;
    restoreError: string | null;
    maintenanceError: string | null;
  } | null;
  incidents: { key: string; message: string; since: string | null }[];
  host: {
    bootedAt?: string | null;
    disk: { totalBytes: number; availableBytes: number };
    memory: { totalBytes: number | null; availableBytes: number | null };
    swap: { totalBytes: number | null; freeBytes: number | null };
  };
}

export class StatusError extends Error {}

/** The one JSON line `main.js status` prints. */
export function readState(result: RunResult): PlatformState {
  if (result.status === TOO_OLD) throw new StatusError("the server's reconciler is older than this command: move it to a newer version first (runbook section 8)");
  const line = result.stdout.split("\n").find((text) => text.startsWith("{\"generatedAt\""));
  if (result.status !== 0 || !line) {
    const said = parseLines(result.stdout).at(-1)?.message ?? result.stderr.trim().split("\n").at(-1) ?? "";
    throw new StatusError(`the server did not answer${said ? `: ${said}` : ""}`);
  }
  return JSON.parse(line) as PlatformState;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** A good backup is expected every night: past this, one was missed. */
const BACKUP_LATE_AFTER = 26 * HOUR;
/** A pass runs every minute (D2). */
const PASS_LATE_AFTER = 5 * 60_000;
/** Restarts count as a problem while the container's current start is this recent. */
const RESTARTS_RECENT_FOR = DAY;
/** The disk alert's threshold (D45). */
const DISK_FULL_SHARE = 0.8;

/** The scheduler's week number (backup.ts): weeks start on Monday, at the backup hour. */
const backupWeek = (now: number) => Math.floor((Math.floor((now - 2 * HOUR) / DAY) + 4) / 7);
const shortImage = (image: string | null) => (image ? (/:(sha-[0-9a-f]+)/.exec(image)?.[1] ?? image.split("@")[0] ?? image) : "unknown");

/**
 * The state as a person reads it, and what is worth a look: each problem in
 * one sentence. Nothing here changes anything.
 */
export function describeState(state: PlatformState, timeZone?: string): { lines: string[]; problems: string[] } {
  const now = Date.parse(state.generatedAt);
  const at = (time: string) => when(time, timeZone);
  const lines: string[] = [];
  const problems: string[] = [];

  const pass = state.lastPass;
  lines.push(`Reconciler  ${shortImage(state.reconciler.image)}${state.reconciler.startedAt ? `, up since ${at(state.reconciler.startedAt)}` : ""}`);
  if (!pass) {
    lines.push("            no pass recorded yet");
    problems.push("The reconciler has recorded no pass yet.");
  } else {
    lines.push(`            last pass ${at(pass.at)}: ${pass.status}${pass.commit ? ` at ${pass.commit.slice(0, 7)}` : ""}`);
    if (now - Date.parse(pass.at) > PASS_LATE_AFTER) problems.push(`No pass since ${at(pass.at)}: the reconciler may be stuck.`);
    if (pass.status === "failed" || pass.status === "invalid") problems.push(`The last pass ${pass.status === "invalid" ? "found the instance repo invalid" : "failed"}.`);
    for (const failure of pass.failures) problems.push(`${failure.app}: ${failure.message}`);
  }

  const { host } = state;
  const diskUsed = host.disk.totalBytes > 0 ? 1 - host.disk.availableBytes / host.disk.totalBytes : 0;
  lines.push(`Host        ${host.bootedAt ? `booted ${at(host.bootedAt)} · ` : ""}disk ${size(host.disk.availableBytes)} free of ${size(host.disk.totalBytes)}`
    + (host.memory.totalBytes ? ` · memory ${size(host.memory.availableBytes ?? 0)} free of ${size(host.memory.totalBytes)}` : "")
    + ` · swap ${host.swap.totalBytes ? size(host.swap.totalBytes) : "none"}`);
  if (diskUsed > DISK_FULL_SHARE) problems.push(`The disk is ${Math.round(diskUsed * 100)}% full.`);
  if (!host.swap.totalBytes) problems.push("No swap: the 2 GiB of zram did not come back (D94).");

  const backup = state.backup;
  if (!backup) {
    lines.push("Backups     none on record");
    problems.push("No backup on record on this server.");
  } else {
    const week = backup.restoreTestWeekPassed;
    const weeksAgo = week === null ? undefined : backupWeek(now) - week;
    const restore = weeksAgo === undefined ? "never passed" : weeksAgo === 0 ? "passed this week" : weeksAgo === 1 ? "passed last week" : `passed ${weeksAgo} weeks ago`;
    lines.push(`Backups     last good ${backup.lastSuccessAt ? at(backup.lastSuccessAt) : "never"} · restore test ${restore}`);
    if (!backup.lastSuccessAt || now - Date.parse(backup.lastSuccessAt) > BACKUP_LATE_AFTER) problems.push(`No good backup since ${backup.lastSuccessAt ? at(backup.lastSuccessAt) : "ever"}.`);
    if (backup.lastError) problems.push(`The last backup failed: ${backup.lastError}`);
    if (backup.restoreError) problems.push(`The last restore test failed: ${backup.restoreError}`);
    if (backup.maintenanceError) problems.push(`Cleaning up old backups failed: ${backup.maintenanceError}`);
    if (weeksAgo !== undefined && weeksAgo > 1) problems.push(`The weekly restore test has not passed for ${weeksAgo} weeks.`);
  }

  lines.push("Containers");
  const width = Math.max(0, ...state.containers.map((entry) => entry.name.length));
  for (const entry of state.containers) {
    const running = entry.state === "running";
    const healthy = running && (entry.health === null || entry.health === "healthy");
    const memory = entry.memory ? `${size(entry.memory.usedBytes)} of ${size(entry.memory.limitBytes)}` : "";
    const details = [running ? (entry.health ?? "running") : entry.state, `since ${at(entry.startedAt)}`, memory, entry.restarts > 0 ? `${entry.restarts} restart${entry.restarts > 1 ? "s" : ""}` : "", entry.oomKilled ? "killed for memory" : ""]
      .filter(Boolean).join(" · ");
    lines.push(`  ${healthy && !entry.oomKilled ? "✓" : "✗"} ${entry.name.padEnd(width)}  ${details}`);
    if (!running) problems.push(`${entry.name} is ${entry.state}.`);
    else if (!healthy) problems.push(`${entry.name} is ${entry.health}.`);
    if (entry.oomKilled) problems.push(`${entry.name} was killed for using too much memory.`);
    // Docker counts restarts since the container was created: old ones, of a
    // container up for more than a day since, are history, not a problem.
    if (entry.restarts > 0 && now - Date.parse(entry.startedAt) < RESTARTS_RECENT_FOR) problems.push(`${entry.name} restarted ${entry.restarts} time${entry.restarts > 1 ? "s" : ""}, the last at ${at(entry.startedAt)}.`);
  }

  for (const incident of state.incidents) problems.push(`Open incident${incident.since ? ` since ${at(incident.since)}` : ""}: ${incident.message}`);
  return { lines, problems: [...new Set(problems)] };
}

/** One line of `main.js backup-now`, as a sentence; undefined for a line that says nothing new. */
export function backupStep(line: { message: string; [field: string]: unknown }): string | undefined {
  switch (line.message) {
    case "backup requested":
      return `Backup asked for${line.restoreTest ? ", with a restore test" : ""}: it starts at the reconciler's next pass, within a minute`;
    case "joining the backup already asked for":
      return "A backup was already asked for: following that one";
    case "still waiting":
      return `Still waiting: ${String(line.reason ?? "")}`;
    case "backup starting":
      return "Backing up the databases and volumes to the backup repository";
    case "backup done":
      return line.restore === "passed" ? "Backup done, and the restore test passed" : "Backup done";
    case "restore test failed":
      return `The restore test failed: ${String(line.error ?? "")}`;
    case "backup failed":
    case "still running":
      return `${line.message === "still running" ? "No end yet" : "The backup failed"}: ${String(line.error ?? "")}`;
    default:
      return undefined;
  }
}
