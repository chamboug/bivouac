import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { AUTH_SUBDOMAIN, loadInstance, type AppManifest, type PlatformConfig, type SshKeys } from "@bivouac/manifest";
import { GitHub, repositoryPath } from "./github.js";
import { Hetzner, orderableTypes, type FirewallRule, type Image, type Labels } from "./hetzner.js";
import { HOST_KEY_PATH, keyPart, withHostKey, type HostKeyPair } from "./hostkey.js";
import { buildButane, compileButane, firstAddress } from "./ignition.js";
import type { Remote } from "./remote.js";

/**
 * `bivy rebuild --test` (D91): a temporary copy of the platform, rebuilt
 * from the latest nightly copy on a server billed by the hour, checked, then
 * destroyed. It never touches the real server, its IPs, the DNS, or the
 * backup repository other than to read.
 *
 * It runs in steps recorded in a state file, so an interruption is resumed,
 * or cleaned up with `--cleanup`. The server's SSH host key is known in
 * advance: `bivy` places a provisional one with the Ignition config, and the
 * server replaces it with its own over the first, verified, connection,
 * before anything else is sent (hostkey.ts).
 */

/** Every resource a test creates carries it; only resources carrying it are ever deleted. */
export const TEST_LABEL = "bivouac-rebuild-test";
/** Tried in this order when no location is given: the server type decides. */
export const LOCATIONS = ["fsn1", "nbg1", "hel1"];
export const DEFAULT_SERVER_TYPE = "cx23";
const MINIMUM = { memory: 4, disk: 40 };
const RECONCILER = "docker exec bivouac-reconciler node packages/reconciler/dist/main.js";

/** What a test and a real rebuild both record, step by step. */
export interface RunState {
  run: string;
  startedAt: string;
  ipv6Network?: string;
  ipv4?: string;
  /** The provisional host key placed with the Ignition config (public part only). */
  provisionalKey?: string;
  /** The host key the server made itself, recorded over a verified connection. */
  hostKey?: string;
  done: string[];
  timings: Record<string, number>;
}

export interface TestState extends RunState {
  location: string;
  serverType: string;
  hourly: number;
  image: number;
  firewallId?: number;
  ipv6Id?: number;
  serverId?: number;
  ipv4Id?: number;
  deployKeyId?: number;
}

/** What the steps shared by a test and a real rebuild need. */
export type CommonDependencies = Pick<RebuildDependencies, "remote" | "scanHostKey" | "ageKey" | "stateFile" | "knownHosts" | "log" | "sleep" | "now">;

export interface RebuildDependencies {
  /** The instance repo, read and validated (by default from the directory given). */
  instance?: () => { platform: PlatformConfig; sshKeys: SshKeys; apps: AppManifest[] };
  hetzner: Hetzner;
  /** Created when first needed: the token is only asked for then. */
  github: () => GitHub;
  remote: (host: string) => Remote;
  scanHostKey: (host: string) => { line: string; fingerprint: string } | undefined;
  /** A provisional host key for the server; its private part is only ever sent as user-data. */
  newHostKey: () => HostKeyPair;
  /** The Mac's public IPv4, the only address the test server lets in. */
  publicIpv4: () => Promise<string>;
  /** The Ignition config, for a server whose IPv6 is this address. */
  ignition: (ipv6: string) => string;
  /** The age key's content, read only when it is placed. */
  ageKey: () => Buffer;
  /** An HTTPS request to the test server, under a name of the platform. */
  probe: (host: string, address: string, path: string) => { status: number; body: string };
  /** The same request to the real platform, read only. */
  probeReal: (host: string, path: string) => { status: number; body: string };
  stateFile: string;
  knownHosts: string;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface TestOptions {
  root: string;
  location?: string | undefined;
  serverType?: string | undefined;
  keep: boolean;
}

export class RebuildError extends Error {}

export function readState<T extends RunState = TestState>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function saveState(path: string, state: RunState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.new`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

export function instanceOf(root: string): { platform: PlatformConfig; sshKeys: SshKeys; apps: AppManifest[] } {
  const instance = loadInstance(root);
  if (instance.errors.length > 0 || !instance.platform || !instance.sshKeys) {
    throw new RebuildError(`the instance repo is invalid: run 'bivy validate ${root}' first`);
  }
  if (!instance.platform.backup) throw new RebuildError("platform.yml names no backup: there is nothing to rebuild from");
  return { platform: instance.platform, sshKeys: instance.sshKeys, apps: instance.apps };
}

/** The newest Flatcar snapshot (D65): x86, available, the highest version. */
export function newestFlatcar(images: Image[]): Image {
  const version = (image: Image) => (image.labels["flatcar-version"] ?? "0").split(".").map(Number);
  const usable = images
    .filter((image) => image.status === "available" && image.architecture === "x86" && image.labels.os === "flatcar")
    .sort((a, b) => {
      const [x, y] = [version(a), version(b)];
      for (let index = 0; index < Math.max(x.length, y.length); index++) {
        const difference = (x[index] ?? 0) - (y[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return a.id - b.id;
    });
  const newest = usable.at(-1);
  if (!newest) throw new RebuildError("no Flatcar snapshot is available in the Hetzner project (runbook section 4)");
  return newest;
}

/**
 * Only the age identity the instance's secrets are encrypted for, not every
 * key in the file (it may hold others). SOPS key files carry each key's
 * public key in a comment just above it (`# public key: age1…`).
 */
export function instanceIdentity(keyFile: string, sopsConfig: string): Buffer {
  const recipients: string[] = sopsConfig.match(/age1[0-9a-z]{58}/g) ?? [];
  const lines = keyFile.split("\n");
  for (const [index, line] of lines.entries()) {
    const recipient = /^# public key: (age1[0-9a-z]{58})$/.exec(line.trim())?.[1];
    const secret = lines[index + 1]?.trim();
    if (recipient && recipients.includes(recipient) && secret && /^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(secret)) {
      return Buffer.from(`# public key: ${recipient}\n${secret}\n`);
    }
  }
  throw new RebuildError("the age key file holds no key for the recipients of .sops.yaml (each key needs its '# public key:' line)");
}

const RUN_PATTERN = /^\d{12}-[0-9a-f]{4}$/;
const SNAPSHOT_PATTERN = /^[0-9a-f]{8,64}$/;

/** Only the Mac may reach the test server: it holds a full copy of the data. */
export function testFirewallRules(ipv4: string): FirewallRule[] {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4)?.slice(1).map(Number);
  if (!octets || octets.some((octet) => octet > 255)) throw new RebuildError(`'${ipv4}' is not an IPv4 address`);
  const source = [`${ipv4}/32`];
  return [
    { description: "SSH", direction: "in", protocol: "tcp", port: "22", source_ips: source },
    { description: "HTTP", direction: "in", protocol: "tcp", port: "80", source_ips: source },
    { description: "HTTPS", direction: "in", protocol: "tcp", port: "443", source_ips: source },
    { description: "HTTP/3", direction: "in", protocol: "udp", port: "443", source_ips: source },
  ];
}

export const step = async (deps: CommonDependencies, state: RunState, name: string, work: () => Promise<void>) => {
  if (state.done.includes(name)) return;
  const begin = deps.now();
  deps.log(`· ${name}`);
  await work();
  state.done.push(name);
  state.timings[name] = Math.round((deps.now() - begin) / 1000);
  saveState(deps.stateFile, state);
};

/** Runs a command on the server and fails loudly, without ever printing what was sent to it. */
export function must(remote: Remote, what: string, command: string, options: { input?: string | Buffer; timeoutMs?: number } = {}): string {
  const result = remote.run(command, options);
  if (result.status !== 0) throw new RebuildError(`${what} failed (exit ${result.status}): ${result.stderr.trim().split("\n").pop() ?? ""}`);
  return result.stdout;
}

export async function waitUntil(deps: Pick<CommonDependencies, "now" | "sleep">, what: string, timeoutMs: number, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  while (!(await check())) {
    if (deps.now() > deadline) throw new RebuildError(`${what}: still not there after ${Math.round(timeoutMs / 60_000)} minutes`);
    await deps.sleep(10_000);
  }
}

/** JSON lines a reconciler command printed. */
export function jsonLines(output: string): { message: string; [key: string]: unknown }[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { message: string }];
      } catch {
        return [];
      }
    });
}

/** Chooses where the test server goes, and records it before anything is created. */
async function newState(deps: RebuildDependencies, options: TestOptions): Promise<TestState> {
  const { hetzner } = deps;
  (deps.instance ?? (() => instanceOf(options.root)))();
  const image = newestFlatcar(await hetzner.snapshots("os=flatcar"));
  const wanted = options.serverType ?? DEFAULT_SERVER_TYPE;
  const types = await hetzner.serverTypes();
  const locations = options.location ? [options.location] : LOCATIONS;
  const choice = locations
    .map((location) => ({ location, type: orderableTypes(types, location, MINIMUM).find((entry) => entry.name === wanted) }))
    .find((entry) => entry.type);
  if (!choice?.type) {
    const offers = locations.map((location) => `${location}: ${orderableTypes(types, location, MINIMUM).slice(0, 3).map((entry) => `${entry.name} €${entry.hourly}/h`).join(", ") || "none"}`);
    throw new RebuildError(`${wanted} cannot be ordered in ${locations.join(", ")}; choose --server-type and --location among:\n  ${offers.join("\n  ")}`);
  }
  const stamp = new Date(deps.now()).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const state: TestState = {
    run: `${stamp}-${randomBytes(2).toString("hex")}`,
    startedAt: new Date(deps.now()).toISOString(),
    location: choice.location,
    serverType: choice.type.name,
    hourly: choice.type.hourly,
    image: image.id,
    done: [],
    timings: {},
  };
  saveState(deps.stateFile, state);
  deps.log(`Test ${state.run}: ${state.serverType} in ${state.location} (€${state.hourly}/hour incl. VAT), Flatcar ${image.labels["flatcar-version"]}.`);
  return state;
}

/** Creates the temporary resources, each step once, up to a server whose SSH answers. */
async function create(deps: RebuildDependencies, state: TestState): Promise<void> {
  const { hetzner } = deps;
  const labels: Labels = { [TEST_LABEL]: state.run };
  const name = `${TEST_LABEL}-${state.run}`;

  await step(deps, state, "firewall, open to this Mac only", async () => {
    const firewall = await hetzner.createFirewall(name, testFirewallRules(await deps.publicIpv4()), labels);
    state.firewallId = firewall.id;
  });
  await step(deps, state, "temporary IPv6", async () => {
    const ip = await hetzner.createPrimaryIpv6(name, state.location, labels);
    state.ipv6Id = ip.id;
    state.ipv6Network = ip.ip;
  });
  await step(deps, state, "server", async () => {
    if (!state.ipv6Network || state.ipv6Id === undefined || state.firewallId === undefined) throw new RebuildError("the state file is incomplete: run --cleanup");
    if (state.serverId !== undefined) {
      // Created by an interrupted run: wait for it rather than create another.
      await waitUntil(deps, "the server", 10 * 60_000, async () => (await hetzner.server(state.serverId as number))?.status === "running");
      if (state.ipv4Id !== undefined) await hetzner.labelPrimaryIp(state.ipv4Id, labels);
      return;
    }
    // The only secret ever sent as user-data: a host key replaced at the first connection (D91).
    const hostKey = deps.newHostKey();
    const userData = withHostKey(deps.ignition(firstAddress(state.ipv6Network)), hostKey);
    state.provisionalKey = keyPart(hostKey.publicKey);
    const { server, action } = await hetzner.createServer({
      name,
      server_type: state.serverType,
      location: state.location,
      image: String(state.image),
      user_data: userData,
      labels,
      firewalls: [{ firewall: state.firewallId }],
      public_net: { enable_ipv4: true, enable_ipv6: true, ipv6: state.ipv6Id },
    });
    state.serverId = server.id;
    if (!server.public_net.ipv4) throw new RebuildError("the server was created without an IPv4");
    state.ipv4 = server.public_net.ipv4.ip;
    state.ipv4Id = server.public_net.ipv4.id;
    saveState(deps.stateFile, state);
    await hetzner.waitAction(action);
    // The IPv4 Hetzner created with the server: labelled too, so a cleanup finds it.
    if (state.ipv4Id !== undefined) await hetzner.labelPrimaryIp(state.ipv4Id, labels);
  });
  await step(deps, state, "SSH answers", async () => {
    const ipv4 = state.ipv4;
    if (!ipv4) throw new RebuildError("the server has no IPv4");
    let seen: string | undefined;
    await waitUntil(deps, "the server's SSH", 5 * 60_000, () => {
      const scanned = deps.scanHostKey(ipv4);
      if (scanned) seen = scannedKey(scanned.line);
      return scanned !== undefined;
    });
    // Not a proof (anyone on the path could answer), only an early, clear
    // failure: the proof is the verified connection that follows.
    if (seen !== state.provisionalKey) throw new RebuildError("the server does not present the host key placed with its Ignition config: nothing was sent");
  });
}

/** `<host> ssh-ed25519 AAAA…` as ssh-keyscan prints it → `ssh-ed25519 AAAA…`. */
export function scannedKey(line: string): string {
  return keyPart(line.slice(line.indexOf(" ") + 1));
}

function writeKnownHosts(deps: CommonDependencies, state: RunState, key: string): void {
  const address = firstAddress(state.ipv6Network as string).replace(/\/64$/, "");
  mkdirSync(dirname(deps.knownHosts), { recursive: true, mode: 0o700 });
  writeFileSync(deps.knownHosts, `${state.ipv4},${address} ${key}\n`, { mode: 0o600 });
}

/** How a test and a real rebuild differ while the platform comes back. */
export interface BringBack {
  mode: "test" | "rebuild";
  apps: AppManifest[];
  /** Makes the server's deploy key readable by GitHub: through the API for a test, by the owner for a real rebuild. */
  deployKey: (remote: Remote, title: string, publicKey: string) => Promise<void>;
  /** The deploy key's title on GitHub. */
  deployKeyTitle: string;
}

/**
 * From a server presenting its provisional host key to a restored, running
 * copy of the platform: the steps a test and a real rebuild share.
 */
export async function bringBack(deps: CommonDependencies, state: RunState, how: BringBack): Promise<void> {
  const { apps } = how;
  const ipv4 = state.ipv4;
  if (!ipv4 || !state.ipv6Network) throw new RebuildError("the state file is incomplete");
  if (!RUN_PATTERN.test(state.run)) throw new RebuildError(`the state file names an odd run '${state.run}'`);
  const remote = deps.remote(ipv4);

  await step(deps, state, "host key replaced", async () => {
    const provisional = state.provisionalKey;
    if (!provisional) throw new RebuildError("no provisional host key was recorded");
    // Interrupted once the new key was recorded: only that key is trusted
    // from then on. Never fall back to the provisional key, which the
    // user-data still holds: whoever reads it could make the new key's
    // connection fail on purpose and pose as the server (rule 6 review).
    if (state.hostKey) {
      writeKnownHosts(deps, state, state.hostKey);
      if (remote.run("true").status !== 0) {
        throw new RebuildError("the server does not answer with the host key recorded for it: nothing more was sent. Do not run again: find out why first (D91)");
      }
      return;
    }
    // Every connection below is checked against the provisional key, which
    // only this Mac and the user-data know, until the swap.
    writeKnownHosts(deps, state, provisional);
    const key = HOST_KEY_PATH;
    const fresh = keyPart(must(remote, "making the server's own host key", `sudo rm -f ${key}.new ${key}.new.pub && sudo ssh-keygen -q -t ed25519 -N '' -C bivouac-server -f ${key}.new && sudo cat ${key}.new.pub`));
    if (fresh === provisional) throw new RebuildError("the server's new host key is the provisional one");
    state.hostKey = fresh;
    saveState(deps.stateFile, state);
    // sshd is started per connection on Flatcar (sshd.socket, Accept=yes):
    // the next connection reads the new key, no restart needed.
    must(remote, "putting the server's own host key in place", `sudo mv -f ${key}.new.pub ${key}.pub && sudo mv -f ${key}.new ${key}`);
    writeKnownHosts(deps, state, fresh);
    must(remote, "connecting with the server's own host key", "true");
    const seen = deps.scanHostKey(ipv4);
    if (!seen || scannedKey(seen.line) !== fresh) throw new RebuildError("the server still presents another host key");
    deps.log("  the server replaced its provisional host key");
  });
  await step(deps, state, "first-boot checks", async () => {
    const out = must(remote, "first-boot checks", "grep -E '^(ID|VERSION)=' /etc/os-release; sudo test -d /etc/bivouac && echo bivouac-dir; systemctl is-active bivouac-reconciler; sudo nft list table inet bivouac_metadata >/dev/null && echo metadata-block");
    // os-release quotes its values (`ID="flatcar"`, seen on the first real run).
    const lines = out.split("\n").map((line) => line.trim().replace(/^(ID|VERSION)="(.*)"$/, "$1=$2"));
    for (const expected of ["ID=flatcar", "bivouac-dir", "metadata-block"]) {
      if (!lines.includes(expected)) throw new RebuildError(`first-boot check: '${expected}' missing`);
    }
  });
  const marker = JSON.stringify({ mode: how.mode });
  await step(deps, state, `rebuild marker (${how.mode} mode)`, async () => {
    // Before the deploy key and the age key: the first pass that can read Git must see it.
    must(remote, "placing the marker", "sudo sh -c 'umask 077; cat > /etc/bivouac/rebuild.json.tmp && mv /etc/bivouac/rebuild.json.tmp /etc/bivouac/rebuild.json'", { input: `${marker}\n` });
    if (must(remote, "reading the marker", "sudo cat /etc/bivouac/rebuild.json").trim() !== marker) throw new RebuildError("the marker did not arrive intact");
  });
  await step(deps, state, "deploy key", async () => {
    const title = how.deployKeyTitle;
    if (!/^[A-Za-z0-9._-]+$/.test(title)) throw new RebuildError(`odd deploy key title '${title}'`);
    const key = must(remote, "creating the deploy key", `sudo test -e /etc/bivouac/deploy_key || sudo ssh-keygen -q -t ed25519 -N '' -C ${title} -f /etc/bivouac/deploy_key; sudo cat /etc/bivouac/deploy_key.pub`).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ /.test(key)) throw new RebuildError("the server gave no public deploy key");
    await how.deployKey(remote, title, key);
  });
  await step(deps, state, "age key", async () => {
    const key = deps.ageKey();
    if (!key.includes("AGE-SECRET-KEY-")) throw new RebuildError("the age key file holds no age key");
    const local = createHash("sha256").update(key).digest("hex");
    // Already there from an interrupted run: only the same key is accepted.
    const present = remote.run("sudo test -e /etc/bivouac/age.key").status === 0;
    if (!present) {
      must(remote, "placing the age key", 'sudo test -e /etc/bivouac/age.key && exit 3; sudo sh -c "umask 077; cat > /etc/bivouac/age.key.tmp && mv /etc/bivouac/age.key.tmp /etc/bivouac/age.key"', { input: key });
    }
    const there = must(remote, "checking the age key", "sudo sha256sum /etc/bivouac/age.key").split(" ")[0];
    if (local !== there) {
      remote.run("sudo rm -f /etc/bivouac/age.key");
      throw new RebuildError("the age key on the server differs from this one: removed");
    }
  });
  await step(deps, state, "Postgres, alone", async () => {
    await waitUntil(deps, "Postgres", 10 * 60_000, () => remote.run("docker inspect -f '{{.State.Health.Status}}' bivouac-postgres").stdout.trim() === "healthy");
    const others = remote.run("docker ps --format '{{.Names}}' --filter label=bivouac.managed=true").stdout.split("\n").filter(Boolean);
    if (others.some((name) => name !== "bivouac-postgres")) throw new RebuildError(`containers started before the data was back: ${others.join(", ")}`);
  });
  await step(deps, state, "restore the latest nightly copy", async () => {
    const plan = jsonLines(must(remote, "restore-platform (plan)", `${RECONCILER} restore-platform`, { timeoutMs: 10 * 60_000 }));
    const described = plan.find((line) => line.message === "rebuild plan");
    if (!described || typeof described.copy !== "string" || !SNAPSHOT_PATTERN.test(described.copy)) throw new RebuildError(`restore-platform gave no plan: ${JSON.stringify(plan.at(-1))}`);
    deps.log(`  copy ${described.copy} taken ${String(described.taken)}, ${String(described.size)}`);
    const result = remote.run(`${RECONCILER} restore-platform --yes --snapshot ${described.copy}`, { timeoutMs: 120 * 60_000 });
    const lines = jsonLines(result.stdout);
    for (const line of lines) if (line.message !== "rebuild plan") deps.log(`  ${JSON.stringify(line)}`);
    if (result.status !== 0 || !lines.some((line) => line.message === "platform restored")) {
      throw new RebuildError(`restore-platform failed: ${JSON.stringify(lines.at(-1) ?? result.stderr.trim())}`);
    }
  });
  await step(deps, state, "Pocket ID and the apps", async () => {
    const expected = ["bivouac-pocket-id", "bivouac-caddy", ...apps.map((app) => `bivouac-app-${app.name}`)];
    await waitUntil(deps, "Pocket ID and the apps", 15 * 60_000, () => {
      const names = remote.run("docker ps --format '{{.Names}} {{.Status}}' --filter label=bivouac.managed=true").stdout;
      return expected.every((name) => new RegExp(`^${name} Up`, "m").test(names)) && !/\(health: starting\)|\(unhealthy\)/.test(names);
    });
  });
}

/** The test's own steps around the shared ones. */
async function restore(deps: RebuildDependencies, state: TestState, options: TestOptions): Promise<void> {
  const { platform, apps } = (deps.instance ?? (() => instanceOf(options.root)))();
  const ipv4 = state.ipv4;
  if (!ipv4) throw new RebuildError("the state file is incomplete: run --cleanup");
  try {
    await bringBack(deps, state, {
      mode: "test",
      apps,
      deployKeyTitle: `${TEST_LABEL}-${state.run}`,
      deployKey: async (_remote, title, key) => {
        const added = await deps.github().addDeployKey(title, key);
        state.deployKeyId = added.id;
      },
    });
  } catch (error) {
    if (error instanceof RebuildError && !/--cleanup/.test(error.message)) throw new RebuildError(`${error.message}\nThe test server can be deleted with --cleanup.`);
    throw error;
  }
  await step(deps, state, "checks against the real platform", async () => {
    const auth = `${AUTH_SUBDOMAIN}.${platform.domain}`;
    const jwks = "/.well-known/jwks.json";
    const test = deps.probe(auth, ipv4, jwks);
    const real = deps.probeReal(auth, jwks);
    const keys = (body: string) => JSON.stringify((JSON.parse(body) as { keys: { kid: string; n?: string; x?: string }[] }).keys.map((key) => [key.kid, key.n ?? key.x]).sort());
    if (test.status !== 200 || real.status !== 200 || keys(test.body) !== keys(real.body)) {
      throw new RebuildError("Pocket ID on the test server does not publish the real signing keys: its data or ENCRYPTION_KEY did not come back");
    }
    deps.log("  Pocket ID publishes the same signing keys as the real server");
    for (const app of apps) {
      if (app.health === false) continue;
      const answer = deps.probe(`${app.name}.${platform.domain}`, ipv4, app.health);
      if (answer.status !== 200) throw new RebuildError(`${app.name} answers ${answer.status} on ${app.health}`);
      deps.log(`  ${app.name}: ${app.health} answers 200 through Caddy`);
    }
  });
}

/** Deletes what the test created: only what carries its label, never anything protected. */
export async function cleanup(deps: RebuildDependencies, githubToken: boolean): Promise<string[]> {
  const { hetzner } = deps;
  const state = readState(deps.stateFile);
  const problems: string[] = [];
  const selector = TEST_LABEL;
  const ours = (labels: Labels) => typeof labels[TEST_LABEL] === "string" && labels[TEST_LABEL] !== "";

  for (const server of await hetzner.servers(selector)) {
    if (!ours(server.labels) || server.protection.delete || server.name === "bivouac") {
      problems.push(`server ${server.id} (${server.name}) left alone: not a test server`);
      continue;
    }
    deps.log(`· deleting server ${server.name}`);
    await hetzner.waitAction(await hetzner.deleteServer(server.id));
  }
  for (const ip of await hetzner.primaryIps(selector)) {
    if (!ours(ip.labels) || ip.protection.delete) {
      problems.push(`Primary IP ${ip.id} left alone: not a test IP`);
      continue;
    }
    if (ip.assignee_id !== null) {
      problems.push(`Primary IP ${ip.ip} is still assigned to server ${ip.assignee_id}`);
      continue;
    }
    deps.log(`· deleting Primary IP ${ip.ip}`);
    await hetzner.deletePrimaryIp(ip.id);
  }
  for (const firewall of await hetzner.firewalls(selector)) {
    if (!ours(firewall.labels)) continue;
    deps.log(`· deleting firewall ${firewall.name}`);
    // Detached by the server's deletion, which may take a moment to show.
    for (let attempt = 0; ; attempt++) {
      try {
        await hetzner.deleteFirewall(firewall.id);
        break;
      } catch (error) {
        if (attempt >= 5) {
          problems.push(`firewall ${firewall.id}: ${(error as Error).message}`);
          break;
        }
        await deps.sleep(5000);
      }
    }
  }
  if (state?.deployKeyId !== undefined) {
    if (githubToken) {
      const github = deps.github();
      const key = (await github.deployKeys()).find((entry) => entry.id === state.deployKeyId);
      if (key && !key.title.startsWith(`${TEST_LABEL}-`)) problems.push(`deploy key ${key.id} (${key.title}) left alone: not a test key`);
      else if (key) {
        deps.log(`· removing deploy key ${key.title}`);
        await github.removeDeployKey(key.id);
      }
    } else {
      problems.push(`the deploy key '${TEST_LABEL}-${state.run}' is still on GitHub: remove it (repo Settings → Deploy keys), or run --cleanup with the GitHub token`);
    }
  }
  const left = [
    ...(await hetzner.servers(selector)).map((entry) => `server ${entry.name}`),
    ...(await hetzner.primaryIps(selector)).map((entry) => `Primary IP ${entry.ip}`),
    ...(await hetzner.firewalls(selector)).map((entry) => `firewall ${entry.name}`),
  ];
  problems.push(...left.map((entry) => `still there: ${entry}`));
  if (problems.length === 0) {
    rmSync(deps.knownHosts, { force: true });
    rmSync(deps.stateFile, { force: true });
  }
  return problems;
}

export async function rebuildTest(deps: RebuildDependencies, options: TestOptions): Promise<TestState> {
  const state = readState(deps.stateFile) ?? (await newState(deps, options));
  try {
    await create(deps, state);
  } catch (error) {
    throw new RebuildError(`${(error as Error).message}\nRun again to carry on, or --cleanup to delete what was created.`);
  }
  await restore(deps, state, options);
  return state;
}

/** curl through the system, so a name of the platform can be sent to another address. */
export function curlProbe(host: string, address: string | undefined, path: string, insecure: boolean): { status: number; body: string } {
  const result = spawnSync("curl", [
    "--silent", "--max-time", "20", "--write-out", "\n%{http_code}",
    ...(insecure ? ["--insecure"] : []),
    ...(address ? ["--resolve", `${host}:443:${address}`] : []),
    `https://${host}${path}`,
  ], { encoding: "utf8" });
  const lines = result.stdout.split("\n");
  return { status: Number(lines.pop()), body: lines.join("\n") };
}

export function ignitionFor(root: string): (ipv6: string) => string {
  return (ipv6) => {
    const { platform, sshKeys } = instanceOf(root);
    return compileButane(buildButane(root, platform, sshKeys, ipv6));
  };
}

export { repositoryPath };
