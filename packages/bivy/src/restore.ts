import type { AppManifest } from "@bivouac/manifest";
import { Cancelled, type Guide, type Progress } from "./guide.js";
import { shellQuote } from "./ssh.js";

/**
 * `bivy restore <app>`, guided (D101): one app's data back to a nightly copy,
 * on the running server, without SSH by hand. All the work is the
 * reconciler's `restore-app` (D90, runbook section 14), run through SSH like
 * `bivy exec`; bivy only asks, shows the plan the server computes, takes the
 * typed confirmation and follows the steps.
 *
 * Every question has a flag or a safe default, so a script or Claude can
 * read the plan (`--plan`); the restore itself is confirmed by typing the
 * app's name in a terminal, never by a flag (rule 5).
 */

export class RestoreError extends Error {}

/** What a run of a command on the server gives back. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RestoreRemote {
  /** Runs a command on the server and waits for its end. */
  run(command: string): RunResult;
  /**
   * Runs a command on the server, giving each line of its output as it comes.
   * Nothing typed at the keyboard reaches it: a restore is never cut short
   * from here. Status 255 when SSH itself failed or the connection was lost.
   */
  stream(command: string, onLine: (line: string) => void): Promise<{ status: number; stderr: string }>;
}

export interface RestoreRequest {
  app?: string | undefined;
  snapshot?: string | undefined;
  before?: string | undefined;
  only?: string | undefined;
  /** Only read: show the plan, change nothing. */
  plan: boolean;
}

export interface RestoreDeps {
  apps: AppManifest[];
  remote: RestoreRemote;
  progress: Progress;
  log: (message: string) => void;
  /** Questions with the arrow keys: only when a person is at the terminal. */
  guide?: Guide | undefined;
  /** A line typed by a person at a terminal: the only way to confirm. */
  typed?: ((message: string) => Promise<string>) | undefined;
  /** For the dates shown; the computer's own by default. */
  timeZone?: string | undefined;
}

/** How many nightly copies the question offers; older ones by `--snapshot`. */
export const COPIES_OFFERED = 14;

const RECONCILER = "bivouac-reconciler";
const COPY_ID = /^[0-9a-f]{8,64}$/;

/** The command the server runs: the reconciler's own restore-app, its arguments quoted one by one. */
export function restoreAppCommand(app: string, args: readonly string[]): string {
  return ["docker", "exec", RECONCILER, "node", "packages/reconciler/dist/main.js", "restore-app", app, ...args].map(shellQuote).join(" ");
}

interface Line {
  message: string;
  [field: string]: unknown;
}

/** The reconciler writes one JSON object per line; anything else is left out. */
export function parseLines(output: string): Line[] {
  const lines: Line[] = [];
  for (const text of output.split("\n")) {
    const line = parseLine(text);
    if (line) lines.push(line);
  }
  return lines;
}

function parseLine(text: string): Line | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && typeof (value as Line).message === "string") return value as Line;
  } catch {
    // Not one of the reconciler's lines.
  }
  return undefined;
}

export interface Copy {
  id: string;
  time: string;
  tags: string[];
}

/** The plan restore-app announces without --yes. */
export interface Plan {
  copy: string;
  taken: string;
  restores: { database: boolean; files: boolean };
  database: string;
  volumes: string[] | string;
  databaseBytes: number;
  neededBytes: number;
  freeBytes: number;
  busy?: string;
  interrupted: boolean;
  deployedAt?: string;
}

/** The server's reason for refusing, as restore-app logs it. */
function failure(result: RunResult): string {
  const failed = parseLines(result.stdout).find((line) => line.message === "restore failed");
  if (failed && typeof failed.error === "string") return failed.error;
  const last = result.stderr.trim().split("\n").at(-1);
  return result.status === 255 ? `cannot reach the server${last ? `: ${last}` : ""}` : (last ?? `exit ${result.status}`);
}

/** The copies of the backup repository, newest first. */
export function readCopies(output: string): Copy[] {
  return parseLines(output)
    .filter((line) => line.message === "copy" && typeof line.id === "string" && typeof line.time === "string")
    .map((line) => ({ id: line.id as string, time: line.time as string, tags: Array.isArray(line.tags) ? (line.tags as string[]) : [] }))
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export function readPlan(output: string): Plan {
  const line = parseLines(output).find((entry) => entry.message === "restore plan");
  if (!line) throw new RestoreError("the server gave no restore plan");
  // Fields added with bivy restore: an older reconciler does not give them.
  if (typeof line.freeBytes !== "number" || typeof line.neededBytes !== "number" || typeof line.restores !== "object") {
    throw new RestoreError("the server's reconciler is too old for bivy restore: let it move to the latest version first");
  }
  // Echoed back in the command that changes data: checked here as well as on the server.
  if (typeof line.copy !== "string" || !COPY_ID.test(line.copy)) throw new RestoreError("the server's plan names no valid copy");
  if (typeof line.taken !== "string" || Number.isNaN(Date.parse(line.taken))) throw new RestoreError("the server's plan gives no valid date for its copy");
  return line as unknown as Plan;
}

/** A date as the person reads it: "Thu 19 Nov, 03:12". */
export function when(time: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) })
    .format(new Date(time));
}

const GIB = 1024 ** 3;
export const size = (bytes: number) => (bytes < GIB ? `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB` : `${(bytes / GIB).toFixed(1)} GB`);

const hasDatabase = (app: AppManifest) => app.database !== undefined;
const hasFiles = (app: AppManifest) => Object.keys(app.volumes ?? {}).length > 0;

/** One step of the run on the server: what is shown while it lasts. */
class Steps {
  private current: { sentence: string; began: number } | undefined;

  constructor(private readonly progress: Progress) {}

  start(sentence: string): void {
    this.done();
    this.current = { sentence, began: Date.now() };
    this.progress.start(sentence);
  }

  done(): void {
    if (!this.current) return;
    this.progress.stop(this.current.sentence, Math.round((Date.now() - this.current.began) / 1000));
    this.current = undefined;
  }

  fail(why: string): void {
    if (this.current) this.progress.fail(`${this.current.sentence}: ${why}`);
    else this.progress.fail(why);
    this.current = undefined;
  }
}

export async function restoreCommand(deps: RestoreDeps, request: RestoreRequest): Promise<number> {
  try {
    return await restore(deps, request);
  } catch (error) {
    if (error instanceof Cancelled) {
      deps.log("Stopped: nothing was changed.");
      return 1;
    }
    if (error instanceof RestoreError) {
      deps.log(`✗ ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function restore(deps: RestoreDeps, request: RestoreRequest): Promise<number> {
  const { remote, guide, log } = deps;
  if (request.snapshot !== undefined && !COPY_ID.test(request.snapshot)) throw new RestoreError("--snapshot takes a copy's ID, as the list of copies shows it");
  if (request.snapshot !== undefined && request.before !== undefined) throw new RestoreError("--snapshot and --before cannot be used together");
  if (request.only !== undefined && request.only !== "database" && request.only !== "files") throw new RestoreError("--only takes 'database' or 'files'");

  // 1. Which app: only those with data to bring back.
  const candidates = deps.apps.filter((app) => hasDatabase(app) || hasFiles(app)).sort((a, b) => a.name.localeCompare(b.name));
  let app = candidates.find((entry) => entry.name === request.app);
  if (request.app !== undefined && !app) {
    const known = deps.apps.some((entry) => entry.name === request.app);
    throw new RestoreError(known ? `${request.app} has no database and no volume: nothing to restore` : `no app '${request.app}' in this instance. Apps with data: ${candidates.map((entry) => entry.name).join(", ") || "none"}`);
  }
  if (!app) {
    if (!guide) throw new RestoreError(`which app? bivy restore <app>. Apps with data: ${candidates.map((entry) => entry.name).join(", ") || "none"}`);
    if (candidates.length === 0) throw new RestoreError("no app of this instance has a database or a volume");
    const name = await guide.select("Which app's data should go back to a backup copy?", candidates.map((entry) => ({ value: entry.name, label: entry.name })));
    app = candidates.find((entry) => entry.name === name) as AppManifest;
  }
  const name = app.name;

  // 2. Which copy: from the server's own list, unless named.
  let snapshot = request.snapshot;
  if (snapshot === undefined && request.before === undefined && guide) {
    const listed = remote.run(restoreAppCommand(name, ["--list"]));
    if (listed.status !== 0) throw new RestoreError(`cannot read the backup copies: ${failure(listed)}`);
    const nightly = readCopies(listed.stdout).filter((copy) => copy.tags.includes("nightly")).slice(0, COPIES_OFFERED);
    if (nightly.length === 0) throw new RestoreError("the server has no nightly copy yet");
    snapshot = await guide.select(
      `Which nightly copy? (your computer's time; older ones: --snapshot <id>)`,
      nightly.map((copy, index) => ({ value: copy.id, label: when(copy.time, deps.timeZone), hint: index === 0 ? `the latest, ${copy.id}` : copy.id })),
    );
  }

  // 3. Which part, when the app has both.
  let only = request.only as "database" | "files" | undefined;
  if (only === undefined && guide && hasDatabase(app) && hasFiles(app)) {
    const part = await guide.select("What should go back to that copy?", [
      { value: "both", label: "The database and the files", hint: "they then match each other" },
      { value: "database", label: "The database only" },
      { value: "files", label: "The files only" },
    ]);
    only = part === "both" ? undefined : part;
  }

  // 4. The plan, as the server computes it: nothing changes yet.
  const choice = [
    ...(snapshot ? ["--snapshot", snapshot] : request.before ? ["--before", request.before] : []),
    ...(only ? ["--only", only] : []),
  ];
  const planned = remote.run(restoreAppCommand(name, choice));
  if (planned.status !== 0) throw new RestoreError(failure(planned));
  const plan = readPlan(planned.stdout);
  const taken = when(plan.taken, deps.timeZone);

  log("");
  log(`Restoring ${name} to the copy ${plan.copy}, taken ${taken}:`);
  if (plan.restores.database) log(`  · the database goes back to that copy; today's is kept aside, as ${plan.database.replace(/^.* kept as (\S+)\)$/, "$1")}`);
  if (plan.restores.files) log(`  · the files (${Array.isArray(plan.volumes) ? plan.volumes.join(", ") : plan.volumes}) go back to that copy: files added since are removed, the others put back as they were`);
  log(`  · what was written in ${name} since ${taken} will no longer be in the app. It is not lost: a safety copy`);
  log("    of today's data is sent first, so this restore can be undone");
  log(`  · ${name} is stopped meanwhile: usually under a minute, longer for a large volume`);
  log(`  · disk: about ${size(plan.neededBytes)} needed, ${size(plan.freeBytes)} free`);

  if (plan.busy) throw new RestoreError(`a ${plan.busy} is running on the server: try again once it is over. Nothing was changed.`);
  if (plan.freeBytes < plan.neededBytes) throw new RestoreError("not enough free disk on the server for this restore. Nothing was changed.");
  if (plan.interrupted) {
    if (only) throw new RestoreError(`an earlier restore of ${name} was interrupted: only a restore of all its data (without --only) starts it again. Nothing was changed.`);
    log(`  · an earlier restore of ${name} was interrupted: the app has been stopped since, and this one starts it again`);
  }

  // 5. A newer version than the copy: if it is what damaged the data, it would damage it again.
  if (plan.deployedAt && Date.parse(plan.deployedAt) > Date.parse(plan.taken)) {
    log("");
    log(`! ${name} was deployed again on ${when(plan.deployedAt, deps.timeZone)}, after this copy (a new version, or new settings).`);
    log("  If that update is what damaged the data, first put the previous image back in");
    log(`  apps/${name}.yml and wait for its deployment: otherwise it would damage the restored data again.`);
    if (guide) {
      const go = await guide.select("Carry on?", [
        { value: "carry on", label: "Carry on: the update is not the cause", hint: "data deleted by mistake, for instance" },
        { value: "stop", label: "Stop here: I'll put the previous version back first" },
      ]);
      if (go === "stop") throw new Cancelled();
    }
  }

  if (request.plan) {
    log("");
    log(`Nothing was changed (--plan). To restore: bivy restore ${name} --snapshot ${plan.copy}${only ? ` --only ${only}` : ""}, in a terminal.`);
    return 0;
  }
  if (!deps.typed) throw new RestoreError("a restore replaces live data: it is confirmed by typing in a terminal, and there is none here. Nothing was changed.");

  // 6. The typed confirmation (rule 5).
  log("");
  const answer = await deps.typed(`To replace ${name}'s data with the copy of ${taken}, type the app's name (${name}):`);
  if (answer.trim() !== name) throw new RestoreError("not confirmed: nothing was changed.");

  // 7. The restore itself, on exactly the copy of the plan: a nightly copy finishing meanwhile changes nothing.
  return run(deps, name, plan, only);
}

async function run(deps: RestoreDeps, name: string, plan: Plan, only: "database" | "files" | undefined): Promise<number> {
  const { log } = deps;
  const steps = new Steps(deps.progress);
  const volumes = Array.isArray(plan.volumes) ? plan.volumes.length : 0;
  let restoredVolumes = 0;
  let safety: string | undefined;
  let kept: string | undefined;
  let error: string | undefined;
  let finished = false;
  /** Whether live data was touched before a failure: the server says so; unknown counts as yes. */
  let changed = true;
  const startFiles = () => steps.start(volumes > 1 ? `Bringing the files back (${volumes} volumes)` : "Bringing the files back");

  log("");
  log("A restore cannot be stopped halfway: once begun, it carries on on the server to its end.");
  steps.start(`Stopping ${name}`);
  const result = await deps.remote.stream(restoreAppCommand(name, ["--snapshot", plan.copy, "--yes", ...(only ? ["--only", only] : [])]), (text) => {
    const line = parseLine(text);
    if (!line) return;
    switch (line.message) {
      case "app stopped":
        steps.start(`Sending a safety copy of ${name}'s current data`);
        break;
      case "safety copy sent":
        safety = typeof line.copy === "string" && COPY_ID.test(line.copy) ? line.copy : undefined;
        if (plan.restores.database) steps.start("Bringing the database back");
        else startFiles();
        break;
      case "database restored":
        kept = typeof line.kept === "string" ? line.kept : undefined;
        if (plan.restores.files) startFiles();
        else steps.done();
        break;
      case "volume restored":
        if (++restoredVolumes >= volumes) steps.done();
        break;
      case "restore done":
        finished = true;
        steps.start(`Starting ${name} and waiting for its health check`);
        break;
      case "restore stopped":
        changed = line.changed !== false;
        break;
      case "restore failed":
        error = typeof line.error === "string" ? line.error : "the restore failed";
        break;
    }
  });

  const undo = safety ? `bivy restore ${name} --snapshot ${safety}${only ? ` --only ${only}` : ""}` : undefined;
  if (result.status === 0 && finished) {
    steps.done();
    log("");
    log(`✓ ${name} is back to the copy of ${when(plan.taken, deps.timeZone)}.`);
    if (undo) log(`  To undo it: ${undo}`);
    if (kept) log(`  The replaced database is kept as ${kept}: not backed up, it takes room on the disk until you ask to drop it.`);
    return 0;
  }
  if (error) {
    steps.fail(error);
    if (undo && changed) log(`  The data from before this restore is in the safety copy ${safety}: ${undo} puts it back.`);
    return 1;
  }
  steps.fail(result.status === 255 ? "the connection to the server was lost" : `the server stopped without a word (exit ${result.status})`);
  log(`  The restore may still be running on the server. In a few minutes, bivy restore ${name} --plan says`);
  log("  whether it is still running, or was interrupted (the app then stays stopped until a restore completes).");
  log("  If it still says a restore is running long after, see the runbook, section 14 (\"If it stops halfway\").");
  if (undo) log(`  The data from before this restore is in the safety copy ${safety}.`);
  return 1;
}
