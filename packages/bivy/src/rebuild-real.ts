import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AUTH_SUBDOMAIN, type AppManifest, type PlatformConfig, type SshKeys } from "@bivouac/manifest";
import { repositoryPath } from "./github.js";
import { HetznerError, orderableTypes, type Hetzner, type Image, type PrimaryIp, type Server } from "./hetzner.js";
import { keyPart, withHostKey, type HostKeyPair } from "./hostkey.js";
import { firstAddress } from "./ignition.js";
import {
  DEFAULT_SERVER_TYPE,
  RebuildError,
  TEST_LABEL,
  bringBack,
  instanceOf,
  must,
  newestFlatcar,
  readState,
  saveState,
  scannedKey,
  step,
  waitUntil,
  type CommonDependencies,
  type RunState,
} from "./rebuild.js";
import type { Remote } from "./remote.js";

/**
 * `bivy rebuild` (D91): the real platform brought back from the latest
 * nightly copy, on the same Primary IPs, so the DNS does not change.
 *
 * In place (Hetzner's `rebuild` action) when the server `bivouac` still
 * exists, otherwise a new server in the Primary IPs' location. It never runs
 * without a plan the owner has read and a typed confirmation, and it never
 * runs as a side effect of anything else: running it is a decision of its
 * own (rule 5). `--plan` only reads.
 */

export const SERVER_NAME = "bivouac";
const MINIMUM = { memory: 4, disk: 40 };
/** The reconciler's copy of GitHub's host keys (D54), inside its image. */
const GITHUB_KNOWN_HOSTS = "/app/packages/reconciler/github_known_hosts";

export interface RealDependencies extends CommonDependencies {
  instance?: () => { platform: PlatformConfig; sshKeys: SshKeys; apps: AppManifest[] };
  hetzner: Hetzner;
  newHostKey: () => HostKeyPair;
  ignition: (ipv6: string) => string;
  /** An HTTPS request to the platform under its real name, certificate checked. */
  probeReal: (host: string, path: string) => { status: number; body: string };
  /** The IPv4 addresses a name resolves to, through the Mac's resolver. */
  resolve: (name: string) => Promise<string[]>;
  /** Asks the owner a question in the terminal and returns the answer. */
  ask: (question: string) => Promise<string>;
  /** Why the instance checkout cannot be trusted (uncommitted changes, behind origin/main), if it cannot. */
  checkout?: () => string[];
}

export interface RealOptions {
  root: string;
  /** Only read, print the plan, and stop. */
  plan: boolean;
  /** For a new server only, when no CX23 can be ordered in the IPs' location. */
  serverType?: string | undefined;
  /** The old server does not answer: accept losing what was written since its last copy. */
  withoutFreshBackup: boolean;
  /** Forget a rebuild that stopped before the server was erased. */
  abandon?: boolean;
}

export interface RebuildPlan {
  kind: "in place" | "new server";
  server?: { id: number; type: string; protection: boolean };
  location: string;
  serverType: string;
  /** Hourly price incl. VAT, for a new server. */
  hourly?: number;
  ipv4: { id: number; ip: string };
  ipv6: { id: number; ip: string };
  firewall?: { id: number; name: string };
  image: Image;
  /** What the old server says of its backups, or why it could not be read. */
  backup: { lastSuccessAt?: string; locked: boolean; marker: boolean } | { unreachable: string };
  /** Anything here stops the rebuild before it changes anything. */
  problems: string[];
}

export interface RealState extends RunState {
  kind: "in place" | "new server";
  serverId?: number;
  serverType: string;
  location: string;
  image: number;
  ipv4Id: number;
  ipv6Id: number;
  firewallId?: number;
  /** Set just before the rebuild or the creation is sent: a lost answer is looked up, never sent again blindly. */
  requesting?: string;
  /** The server's newest action before the rebuild was sent: a rebuild action after it is ours. */
  lastActionId?: number;
  /** Set as soon as Hetzner accepted the rebuild or the creation: never sent twice. */
  serverRequested?: boolean;
  /** The old server could not make a fresh backup, and the owner accepted it. */
  withoutFreshBackup?: boolean;
  /** Pocket ID's public signing keys before the rebuild, to compare after. */
  signingKeys?: string;
  knownHostsBackup?: string;
}

/** The rebuild trusts the instance checkout (SSH keys, versions, apps): it must be exactly origin/main. */
export function checkoutProblems(root: string): string[] {
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (git("fetch", "--quiet", "origin").status !== 0) return [`git fetch failed in ${root}`];
  const dirty = git("status", "--porcelain").stdout.split("\n").filter((line) => line.trim() && !line.endsWith(".DS_Store"));
  const problems = dirty.length > 0 ? [`${root} has uncommitted changes: ${dirty.slice(0, 3).join(", ")}`] : [];
  if (git("rev-parse", "HEAD").stdout.trim() !== git("rev-parse", "origin/main").stdout.trim()) problems.push(`${root} is not exactly origin/main: pull first`);
  return problems;
}

const isOurs = (labels: Record<string, string>) => TEST_LABEL in labels;

/** Reads everything a rebuild depends on. Changes nothing, anywhere. */
export async function planRebuild(deps: RealDependencies, options: RealOptions): Promise<RebuildPlan> {
  const { hetzner } = deps;
  const { platform } = (deps.instance ?? (() => instanceOf(options.root)))();
  const problems: string[] = [];
  const image = newestFlatcar(await hetzner.snapshots("os=flatcar"));
  const named = (await hetzner.servers()).filter((server) => server.name === SERVER_NAME && !isOurs(server.labels));
  if (named.length > 1) throw new RebuildError(`${named.length} servers are named '${SERVER_NAME}': which one is the platform cannot be told`);
  const server: Server | undefined = named[0];
  const ips = (await hetzner.primaryIps()).filter((ip) => !isOurs(ip.labels));

  let ipv4: PrimaryIp | undefined;
  let ipv6: PrimaryIp | undefined;
  if (server) {
    ipv4 = ips.find((ip) => ip.id === server.public_net.ipv4?.id);
    ipv6 = ips.find((ip) => ip.id === server.public_net.ipv6?.id);
    if (!ipv4) problems.push(`server ${server.id} has no Primary IPv4`);
    if (!ipv6) problems.push(`server ${server.id} has no Primary IPv6 (runbook section 7)`);
  } else {
    const free = (type: "ipv4" | "ipv6") => ips.filter((ip) => ip.type === type && ip.assignee_id === null);
    const [v4s, v6s] = [free("ipv4"), free("ipv6")];
    if (v4s.length !== 1 || v6s.length !== 1) {
      problems.push(`no server '${SERVER_NAME}', and not exactly one unassigned Primary IPv4 and IPv6 (found ${v4s.length} and ${v6s.length}): say which by hand`);
    } else {
      [ipv4, ipv6] = [v4s[0], v6s[0]];
    }
  }
  if (ipv4 && ipv4.auto_delete) problems.push(`the Primary IPv4 ${ipv4.ip} has auto_delete: set it to false first (runbook section 7)`);
  if (ipv6 && ipv6.auto_delete) problems.push(`the Primary IPv6 ${ipv6.ip} has auto_delete: set it to false first`);
  const location = server?.location?.name ?? ipv4?.location?.name ?? "";
  if (!server && ipv6?.location?.name && ipv6.location.name !== location) problems.push("the Primary IPv4 and IPv6 are in different locations");

  // The DNS must already point to this IPv4: a rebuild never touches it.
  const auth = `${AUTH_SUBDOMAIN}.${platform.domain}`;
  let resolved: string[] = [];
  try {
    resolved = await deps.resolve(auth);
  } catch (error) {
    problems.push(`${auth} does not resolve: ${(error as Error).message}`);
  }
  if (ipv4 && resolved.length > 0 && !resolved.includes(ipv4.ip)) problems.push(`${auth} points to ${resolved.join(", ")}, not to the Primary IPv4 ${ipv4.ip}`);

  const firewalls = (await hetzner.firewalls()).filter((firewall) => firewall.name === SERVER_NAME && !isOurs(firewall.labels));
  const firewall = firewalls[0];
  if (!firewall) problems.push(`no firewall '${SERVER_NAME}': create it first (runbook section 6, owner's consent)`);
  else if (server && !server.public_net.firewalls.some((entry) => entry.id === firewall.id)) problems.push(`the firewall '${SERVER_NAME}' is not applied to server ${server.id}`);

  let serverType = server?.server_type.name ?? options.serverType ?? DEFAULT_SERVER_TYPE;
  let hourly: number | undefined;
  if (!server) {
    const offers = orderableTypes(await hetzner.serverTypes(), location, MINIMUM);
    const wanted = offers.find((offer) => offer.name === serverType);
    if (wanted) hourly = wanted.hourly;
    else {
      problems.push(`${serverType} cannot be ordered in ${location || "the IPs' location"}. Choose with --server-type, keeping the IPs and the DNS: ${offers.slice(0, 4).map((offer) => `${offer.name} €${offer.hourly}/h`).join(", ") || "none"}. Another location means new IPs and a DNS change: not done by bivy`);
    }
  } else if (options.serverType && options.serverType !== serverType) {
    problems.push("--server-type is for a new server only: a rebuild in place keeps the server's type");
  }
  if (server && !server.protection.delete) problems.push(`server ${server.id} has no delete protection: something is off, look first`);

  let backup: RebuildPlan["backup"];
  if (!server || !ipv4) backup = { unreachable: "no server" };
  else {
    const answer = deps.remote(ipv4.ip).run("sudo cat /var/lib/bivouac/backup/state.json; echo; sudo test -e /var/lib/bivouac/backup/lock.json && echo LOCKED; sudo test -e /etc/bivouac/rebuild.json && echo MARKER; true", { timeoutMs: 60_000 });
    if (answer.status !== 0) backup = { unreachable: answer.stderr.trim().split("\n").pop() ?? `exit ${answer.status}` };
    else {
      const last = /"lastSuccessAt":(\d+)/.exec(answer.stdout)?.[1];
      backup = {
        ...(last ? { lastSuccessAt: new Date(Number(last)).toISOString() } : {}),
        locked: answer.stdout.includes("LOCKED"),
        marker: answer.stdout.includes("MARKER"),
      };
      if (backup.locked) problems.push("a backup or a restore holds the lock on the old server: wait for it");
      if (backup.marker) problems.push("the old server already has a rebuild marker: look first");
      if (!last) problems.push("the old server has never made a backup");
    }
  }
  if ("unreachable" in backup && server) {
    // SSH may fail on this Mac's side (a wrong key, an old known_hosts): a platform that still answers must not be erased.
    const answer = deps.probeReal(auth, "/.well-known/jwks.json");
    if (answer.status === 200) problems.push(`${auth} still answers while SSH does not: fix SSH from this Mac rather than erasing a working server`);
  }
  problems.push(...(deps.checkout?.() ?? []));
  if ("unreachable" in backup && !options.withoutFreshBackup) {
    problems.push(`the old server cannot make a fresh backup (${backup.unreachable}): run again with --without-fresh-backup to accept losing what was written since its last nightly copy`);
  }

  return {
    kind: server ? "in place" : "new server",
    ...(server ? { server: { id: server.id, type: server.server_type.name, protection: server.protection.delete } } : {}),
    location,
    serverType,
    ...(hourly !== undefined ? { hourly } : {}),
    ipv4: ipv4 ? { id: ipv4.id, ip: ipv4.ip } : { id: 0, ip: "?" },
    ipv6: ipv6 ? { id: ipv6.id, ip: ipv6.ip } : { id: 0, ip: "?" },
    ...(firewall ? { firewall: { id: firewall.id, name: firewall.name } } : {}),
    image,
    backup,
    problems,
  };
}

export function describePlan(plan: RebuildPlan, domain: string): string {
  const lines = [
    plan.kind === "in place"
      ? `Rebuild IN PLACE of server ${plan.server?.id} (${plan.serverType}, ${plan.location}): its disk is ERASED, then the platform comes back from the backups.`
      : `NEW server '${SERVER_NAME}', ${plan.serverType} in ${plan.location} (€${plan.hourly ?? "?"}/hour incl. VAT).`,
    `  IPs kept: ${plan.ipv4.ip} and ${plan.ipv6.ip}; DNS of ${domain} unchanged.`,
    `  Firewall: ${plan.firewall ? plan.firewall.name : "missing"}. Image: Flatcar ${plan.image.labels["flatcar-version"] ?? "?"} (snapshot ${plan.image.id}).`,
    "unreachable" in plan.backup
      ? `  The old server does not answer (${plan.backup.unreachable}): what was written since its last nightly copy is LOST. If Pocket ID is only restarting (about a minute, D68), wait and plan again.`
      : `  Last backup of the old server: ${plan.backup.lastSuccessAt ?? "none"}. A fresh one is made first; nothing is erased if it fails.`,
    "  Afterwards: you add the new server's read-only deploy key on GitHub when asked, and remove the old one at the end.",
  ];
  if (plan.problems.length > 0) lines.push("", "Stops here:", ...plan.problems.map((problem) => `  ✗ ${problem}`));
  return lines.join("\n");
}

/** Backs up the platform's known_hosts once, then writes only the new server's key there. */
function backUpKnownHosts(deps: RealDependencies, state: RealState): void {
  if (state.knownHostsBackup) return;
  const backup = `${deps.knownHosts}.before-rebuild-${state.run}`;
  if (existsSync(deps.knownHosts)) copyFileSync(deps.knownHosts, backup);
  state.knownHostsBackup = backup;
  saveState(deps.stateFile, state);
}

const SAFE_IMAGE = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/;

/**
 * The owner adds the server's deploy key on GitHub (D66, D91): a key added
 * with a temporary token would go away with that token. Waits until the
 * server can read the repo, and checks GitHub refuses it any write.
 */
async function ownerAddsDeployKey(deps: RealDependencies, platform: PlatformConfig, remote: Remote, title: string, key: string): Promise<void> {
  const repository = repositoryPath(platform.repository);
  const image = platform.reconciler.image;
  if (!SAFE_IMAGE.test(image)) throw new RebuildError(`odd reconciler image '${image}'`);
  const ssh = `ssh -i /k -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${GITHUB_KNOWN_HOSTS}`;
  const run = `sudo docker run --rm --cap-drop NET_RAW --security-opt no-new-privileges -v /etc/bivouac/deploy_key:/k:ro`;
  const reads = `${run} --entrypoint git -e GIT_SSH_COMMAND='${ssh}' ${image} ls-remote ${platform.repository} refs/heads/main`;
  const writes = `${run} -i --entrypoint ssh ${image} ${ssh.slice(4)} git@github.com "git-receive-pack '${repository}.git'" </dev/null 2>&1; true`;
  deps.log(`
  ▶ Add this deploy key on GitHub: https://github.com/${repository}/settings/keys/new
      Title: ${title}
      Key:   ${key}
    and leave "Allow write access" UNCHECKED. Waiting for it (up to an hour)…`);
  await waitUntil(deps, "the deploy key on GitHub", 60 * 60_000, () => remote.run(reads, { timeoutMs: 5 * 60_000 }).status === 0);
  const answer = remote.run(writes, { timeoutMs: 5 * 60_000 }).stdout;
  if (!/marked as read only/i.test(answer)) {
    // A key that can write gets the list of refs (pkt-lines: four hex digits, then a commit).
    if (/^[0-9a-f]{4}[0-9a-f]{40} /m.test(answer)) {
      throw new RebuildError(`the deploy key '${title}' can write to the repo: delete it on GitHub, add it again with "Allow write access" unchecked, and run again`);
    }
    throw new RebuildError(`could not check that the deploy key is read-only (${answer.trim().split("\n").pop() ?? "no answer"}): run again`);
  }
  deps.log("  the server reads the repo, and GitHub refuses it any write");
}

const jwksKeys = (body: string) => JSON.stringify((JSON.parse(body) as { keys: { kid: string; n?: string; x?: string }[] }).keys.map((key) => [key.kid, key.n ?? key.x]).sort());

const erased = (entry: RealState) => entry.serverRequested === true || entry.requesting !== undefined;

export async function rebuildReal(deps: RealDependencies, options: RealOptions): Promise<RealState | RebuildPlan> {
  const { platform } = (deps.instance ?? (() => instanceOf(options.root)))();

  if (options.plan) {
    const state = readState<RealState>(deps.stateFile);
    // Only ever reads, whatever state a rebuild is in.
    if (state) deps.log(`A rebuild is under way (${state.run}): ${erased(state) ? "the server was already sent for rebuilding; run without --plan to carry on" : "it stopped before anything was erased"}. Steps done: ${state.done.join(", ") || "none"}.\n`);
    const plan = await planRebuild(deps, options);
    deps.log(describePlan(plan, platform.domain));
    return plan;
  }
  // The state is read inside the lock: another run cannot change it meanwhile.
  return withLock(`${deps.stateFile}.lock`, async () => {
    const state = readState<RealState>(deps.stateFile);
    if (!options.abandon) return run(deps, options, state);
    if (!state) throw new RebuildError("no rebuild under way: nothing to abandon");
    if (erased(state)) throw new RebuildError("the server may already have been sent for rebuilding: run without --abandon, which finds out and carries on, or stops saying nothing was erased");
    rmSync(deps.stateFile);
    deps.log(`Rebuild ${state.run} abandoned: nothing had been erased.`);
    return state;
  });
}

/**
 * Hetzner refused the request (4xx): nothing was sent, the run may start over.
 * Anything else (no answer, 5xx) may have been carried out: looked up next time.
 */
async function refusedOrSent<T>(deps: RealDependencies, state: RealState, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof HetznerError && error.status !== undefined && error.status >= 400 && error.status < 500) {
      delete state.requesting;
      saveState(deps.stateFile, state);
    }
    throw error;
  }
}

/** One run at a time: two terminals must never act on the same rebuild. */
async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    // Left by a run that was killed (Ctrl-C does not run the clean-up): taken over if its process is gone.
    const pid = Number(existsSync(path) ? readFileSync(path, "utf8").trim() : Number.NaN);
    let alive = !Number.isInteger(pid) || pid <= 0;
    if (!alive) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) throw new RebuildError(`another bivy rebuild is running (${path}); if none is, remove that file`);
    rmSync(path, { force: true });
    fd = openSync(path, "wx", 0o600);
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return await work();
  } finally {
    rmSync(path, { force: true });
  }
}

async function run(deps: RealDependencies, options: RealOptions, found: RealState | undefined): Promise<RealState> {
  const { hetzner } = deps;
  const { platform, apps } = (deps.instance ?? (() => instanceOf(options.root)))();
  let state = found;
  // Every run, resumed or not: Ignition (SSH keys), versions and apps come from this checkout.
  const checkout = () => {
    const problems = deps.checkout?.() ?? [];
    if (problems.length > 0) throw new RebuildError(`the instance checkout cannot be trusted: ${problems.join("; ")}`);
  };
  checkout();
  if (state && state.kind === "in place" && state.serverId !== undefined && !state.serverRequested) {
    // Killed while the protection was lifted: put it back before anything else.
    const server = await hetzner.server(state.serverId);
    if (server && !server.protection.delete) {
      await hetzner.waitAction(await hetzner.changeServerProtection(server.id, true));
      deps.log(`  delete and rebuild protection of server ${server.id} put back`);
    }
  }
  if (state && !erased(state)) {
    // Stopped before anything was erased: a new plan, a new confirmation and a new backup, never an old "yes".
    deps.log(`An earlier rebuild (${state.run}) stopped before anything was erased: starting over.`);
    rmSync(deps.stateFile);
    state = undefined;
  }

  if (!state) {
    const plan = await planRebuild(deps, options);
    deps.log(describePlan(plan, platform.domain));
    if (plan.problems.length > 0) throw new RebuildError("the plan has problems: nothing was changed");
    const answer = await deps.ask(`\nThis cannot be undone. Type the platform's domain (${platform.domain}) to go ahead: `);
    if (answer.trim() !== platform.domain) throw new RebuildError("not confirmed: nothing was changed");
    const now = deps.now();
    state = {
      run: `${new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`,
      startedAt: new Date(now).toISOString(),
      kind: plan.kind,
      ...(plan.server ? { serverId: plan.server.id } : {}),
      serverType: plan.serverType,
      location: plan.location,
      image: plan.image.id,
      ipv4: plan.ipv4.ip,
      ipv4Id: plan.ipv4.id,
      ipv6Network: plan.ipv6.ip,
      ipv6Id: plan.ipv6.id,
      ...(plan.firewall ? { firewallId: plan.firewall.id } : {}),
      done: "unreachable" in plan.backup ? ["fresh backup"] : [],
      ...("unreachable" in plan.backup ? { withoutFreshBackup: true } : {}),
      timings: {},
    };
    saveState(deps.stateFile, state);
  } else {
    deps.log(`Carrying on with rebuild ${state.run} (${state.done.length} steps done).`);
  }
  const current = state;
  const ipv4 = current.ipv4 as string;

  await step(deps, current, "fresh backup", async () => {
    // Stop, make the backup due, start (runbook section 12); the reconciler
    // reads its state at startup. Nothing is erased if this fails.
    const remote = deps.remote(ipv4);
    // Compared with the server's own earlier values, never with this Mac's clock.
    const read = () => {
      const out = must(remote, "reading the backup state", "sudo cat /var/lib/bivouac/backup/state.json; echo; sudo test -e /var/lib/bivouac/backup/lock.json && echo LOCKED; true");
      const parsed = JSON.parse(out.split("\n")[0] ?? "{}") as { lastSuccessAt?: number; lastAttemptAt?: number; lastError?: string };
      return { ...parsed, locked: out.includes("LOCKED") };
    };
    const before = read();
    must(remote, "asking for a backup now", `if sudo test -e /var/lib/bivouac/backup/lock.json; then echo "a backup or a restore holds the lock" >&2; exit 3; fi; sudo systemctl stop bivouac-reconciler && sudo sh -c 'umask 077; f=/var/lib/bivouac/backup/state.json; jq -c ".day=0" $f > $f.new && mv $f.new $f'; r=$?; sudo systemctl start bivouac-reconciler; exit $r`);
    deps.log("  waiting for the backup (a few minutes)…");
    await waitUntil(deps, "the fresh backup", 3 * 60 * 60_000, () => {
      const now = read();
      const tried = (now.lastAttemptAt ?? 0) > (before.lastAttemptAt ?? 0);
      // "it was interrupted" is written when a backup starts: only another message is a failure.
      if (tried && now.lastError !== undefined && now.lastError !== "it was interrupted") throw new RebuildError(`the fresh backup failed on the old server: ${now.lastError}. Nothing was erased`);
      // After the copy, the weekly clean-up or restore test may still hold the lock: let it finish.
      return (now.lastSuccessAt ?? 0) > (before.lastSuccessAt ?? 0) && !now.locked;
    });
  });

  await step(deps, current, "signing keys before", async () => {
    const answer = deps.probeReal(`${AUTH_SUBDOMAIN}.${platform.domain}`, "/.well-known/jwks.json");
    if (answer.status === 200) current.signingKeys = jwksKeys(answer.body);
    // Only when the old server is gone may the comparison be skipped; otherwise try again later.
    else if (current.withoutFreshBackup) deps.log(`  Pocket ID answers ${answer.status}: its signing keys cannot be compared afterwards`);
    else throw new RebuildError(`Pocket ID answers ${answer.status}, so its signing keys cannot be recorded: nothing was erased, run again in a minute`);
  });

  await step(deps, current, current.kind === "in place" ? "server rebuilt" : "server created", async () => {
    if (!current.ipv6Network) throw new RebuildError("the state file is incomplete");
    if (current.requesting && !current.serverRequested) {
      // Sent by an interrupted run whose answer was lost: look it up (by
      // Hetzner's own action IDs, no clock), never send it again blindly.
      if (current.kind === "in place") {
        const actions = await hetzner.serverActions(current.serverId as number);
        if (actions.some((action) => action.command === "rebuild_server" && action.id > (current.lastActionId ?? Number.MAX_SAFE_INTEGER))) current.serverRequested = true;
      } else {
        const created = (await hetzner.servers()).find((server) => server.name === SERVER_NAME && !isOurs(server.labels));
        if (created) {
          current.serverId = created.id;
          current.serverRequested = true;
        }
      }
      if (!current.serverRequested) {
        // Never sent: the confirmation and the backup are no longer fresh. Start over.
        delete current.requesting;
        current.done = current.done.filter((name) => name !== "fresh backup" && name !== "signing keys before");
        saveState(deps.stateFile, current);
        throw new RebuildError("the rebuild was never carried out by Hetzner: nothing was erased. Run again: it starts over with a new plan, confirmation and backup");
      }
      saveState(deps.stateFile, current);
    }
    if (!current.serverRequested) {
      checkout();
      backUpKnownHosts(deps, current);
      const hostKey = deps.newHostKey();
      const userData = withHostKey(deps.ignition(firstAddress(current.ipv6Network)), hostKey);
      current.provisionalKey = keyPart(hostKey.publicKey);
      saveState(deps.stateFile, current);
      if (current.kind === "in place") {
        const id = current.serverId as number;
        current.lastActionId = Math.max(0, ...(await hetzner.serverActions(id)).map((action) => action.id));
        // Delete and rebuild protection share one value (D65): lifted for the rebuild only, put back whatever happens.
        await hetzner.waitAction(await hetzner.changeServerProtection(id, false));
        try {
          current.requesting = new Date(deps.now()).toISOString();
          saveState(deps.stateFile, current);
          const action = await refusedOrSent(deps, current, () => hetzner.rebuildServer(id, String(current.image), userData));
          current.serverRequested = true;
          saveState(deps.stateFile, current);
          await hetzner.waitAction(action);
        } finally {
          await hetzner.waitAction(await hetzner.changeServerProtection(id, true));
        }
      } else {
        current.requesting = new Date(deps.now()).toISOString();
        saveState(deps.stateFile, current);
        const { server, action } = await refusedOrSent(deps, current, () => hetzner.createServer({
          name: SERVER_NAME,
          server_type: current.serverType,
          location: current.location,
          image: String(current.image),
          user_data: userData,
          labels: {},
          firewalls: current.firewallId === undefined ? [] : [{ firewall: current.firewallId }],
          public_net: { enable_ipv4: true, enable_ipv6: true, ipv4: current.ipv4Id, ipv6: current.ipv6Id },
        }));
        current.serverId = server.id;
        current.serverRequested = true;
        saveState(deps.stateFile, current);
        await hetzner.waitAction(action);
        await hetzner.waitAction(await hetzner.changeServerProtection(server.id, true));
      }
    } else if (current.serverId !== undefined) {
      // Requested by an interrupted run: never sent twice.
      await waitUntil(deps, "the server", 10 * 60_000, async () => (await hetzner.server(current.serverId as number))?.status === "running");
      const server = await hetzner.server(current.serverId);
      if (server && !server.protection.delete) await hetzner.waitAction(await hetzner.changeServerProtection(server.id, true));
    }
  });

  await step(deps, current, "SSH answers", async () => {
    // The old system may still answer for a moment: wait for the provisional key.
    let seen: string | undefined;
    await waitUntil(deps, "the server's provisional host key", 10 * 60_000, () => {
      const scanned = deps.scanHostKey(ipv4);
      seen = scanned ? scannedKey(scanned.line) : undefined;
      return seen === current.provisionalKey;
    });
  });

  await bringBack(deps, current, {
    mode: "rebuild",
    apps,
    deployKeyTitle: `${SERVER_NAME}-server-${current.run}`,
    deployKey: (remote, title, key) => ownerAddsDeployKey(deps, platform, remote, title, key),
  });

  await step(deps, current, "checks on the real names", async () => {
    // Real certificates from Let's Encrypt: they may take a minute or two.
    const auth = `${AUTH_SUBDOMAIN}.${platform.domain}`;
    let jwks = { status: 0, body: "" };
    await waitUntil(deps, `${auth} with a valid certificate`, 15 * 60_000, () => (jwks = deps.probeReal(auth, "/.well-known/jwks.json")).status === 200);
    if (current.signingKeys && jwksKeys(jwks.body) !== current.signingKeys) {
      throw new RebuildError("Pocket ID does not publish the signing keys it had before the rebuild: its data or ENCRYPTION_KEY did not come back");
    }
    deps.log(current.signingKeys ? "  Pocket ID publishes the same signing keys as before" : "  Pocket ID answers (no keys from before to compare)");
    for (const app of apps) {
      if (app.health === false) continue;
      const health = app.health;
      await waitUntil(deps, `${app.name}${health}`, 10 * 60_000, () => deps.probeReal(`${app.name}.${platform.domain}`, health).status === 200);
      deps.log(`  ${app.name}: ${health} answers 200 with a valid certificate`);
    }
  });

  await step(deps, current, "marker removed", async () => {
    // Once the data is back the marker changes nothing (D91): removed so the server looks like any other.
    must(deps.remote(ipv4), "removing the rebuild marker", "sudo test -e /var/lib/bivouac/rebuild/restored.json && sudo rm -f /etc/bivouac/rebuild.json");
  });

  renameSync(deps.stateFile, `${deps.stateFile}.done-${current.run}`);
  return current;
}
