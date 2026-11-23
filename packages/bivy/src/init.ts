import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_SUBDOMAIN, isPublicAddress, loadInstance, repositorySchema } from "@bivouac/manifest";
import { parse, parseDocument, stringify } from "yaml";
import { type AgeIdentity, keyFile, newAgeIdentity } from "./age.js";
import { AskError, type Asker } from "./ask.js";
import { type PartDependencies, type PartName, type PartResult, PARTS, addToPlatformYml, askPart } from "./configure.js";
import { type DnsProvider, type PublicDns, dnsProblems, fqdn, propagated, wantedRecords } from "./dns.js";
import { repositoryPath } from "./github.js";
import { keyPart, withHostKey, type HostKeyPair } from "./hostkey.js";
import { firstAddress } from "./ignition.js";
import { RebuildError, bringBack, instanceIdentity, must, readState, saveState, scannedKey, step, waitUntil, type CommonDependencies, type RunState } from "./rebuild.js";
import { ownerAddsDeployKey, withLock } from "./rebuild-real.js";
import type { Remote } from "./remote.js";
import { MINIMUM, PLATFORM_NAME, type ServerProvider } from "./server-provider.js";
import type { Sops } from "./sops.js";

/**
 * `bivy init` (D93, D99): from an empty Hetzner project and a domain to a
 * running platform, following the brief's steps and runbook sections 2 to
 * 10. It never erases anything: a project that already holds a platform is
 * for `bivy rebuild`.
 *
 * First the questions, which change nothing anywhere; every answer is
 * recorded, so an interrupted run asks nothing twice. Then the steps, each
 * done once. Three moments need a person at a terminal, never a flag: the
 * typed confirmation before anything billed is created, the age key and
 * restic password shown once, and the typed consent before the DNS is
 * written (rule 5).
 */

export const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "template");
const RECONCILER = "docker exec bivouac-reconciler node packages/reconciler/dist/main.js";
const NEW_REPO_LINK = "https://github.com/new?name=bivouac-platform&visibility=private&owner=@me&description=Bivouac+instance";
const LOCATIONS: Record<string, string> = { fsn1: "Falkenstein, Germany", nbg1: "Nuremberg, Germany", hel1: "Helsinki, Finland", ash: "Ashburn, USA", hil: "Hillsboro, USA", sin: "Singapore" };

export class InitError extends Error {}

export interface InitAnswers {
  dir: string;
  zone: string;
  domain: string;
  location: string;
  serverType: string;
  hourly: number;
  disk: number;
  dns: string;
  /** The private key bivy logs in with; its public part goes into ssh-keys.yml. */
  sshKey: string;
  sshPublicKey: string;
  repository: string;
  parts: Record<PartName, boolean>;
}

export interface InitState extends RunState {
  /** Every question's answer, by flag name: an interrupted run replays them instead of asking. */
  recorded: Record<string, string>;
  answers?: InitAnswers;
  confirmed?: boolean;
  recipient?: string;
  /** Credential files to remove once the secrets are pushed. */
  spent?: string[];
  image?: number;
  ipv4Id?: number;
  ipv6Id?: number;
  firewallId?: number;
  serverId?: number;
}

export interface InitDependencies extends Omit<CommonDependencies, "remote" | "ageKey"> {
  /** Built with the recorded answers first, then the flags (see cli). */
  asker: (recorded: Record<string, string>) => Asker;
  provider: () => Promise<ServerProvider>;
  dnsProvider: (id: string, ask: Asker, zone: string) => Promise<DnsProvider>;
  dnsProviders: { id: string; label: string }[];
  dns: PublicDns;
  sops: Sops;
  part: (ask: Asker) => PartDependencies;
  remote: (host: string, identity: string) => Remote;
  newHostKey: () => HostKeyPair;
  newAgeIdentity?: () => AgeIdentity;
  ignition: (dir: string, ipv6: string) => string;
  probeReal: (host: string, path: string) => { status: number; body: string };
  publicIpv4: () => Promise<string>;
  git: (dir: string, args: string[]) => { status: number; stdout: string; stderr: string };
  /** Public keys found in ~/.ssh (path of the private key, public line). */
  sshKeys: () => { path: string; publicKey: string }[];
  /** Makes a new key pair for this machine, asking its passphrase in the terminal; returns its public line. */
  makeSshKey: (path: string) => string;
  /** ~/.config/sops/age/keys.txt */
  ageKeyFile: string;
  /** Where a new SSH key for this machine goes (~/.ssh/bivouac). */
  newSshKeyPath: string;
  template?: string;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Wraps an Asker so every ordinary answer is recorded in the state, and saved at once. */
function recording(deps: InitDependencies, state: InitState): Asker {
  const base = deps.asker(state.recorded);
  const keep = <T extends string>(flag: string, value: T): T => {
    // Once confirmed, the recorded answers are what was agreed: never overwritten.
    if (state.confirmed) return value;
    state.recorded[flag] = value;
    saveState(deps.stateFile, state);
    return value;
  };
  return {
    ...base,
    select: async (flag, message, choices) => keep(flag, await base.select(flag, message, choices)),
    text: async (flag, message, options) => keep(flag, await base.text(flag, message, options)),
  };
}

function newRun(deps: InitDependencies): InitState {
  const now = deps.now();
  return { run: `${new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`, startedAt: new Date(now).toISOString(), recorded: {}, done: [], timings: {} };
}

/** The questions: nothing billed is created (the healthchecks.io checks, free, are made by name). Returns the answers and the parts' values (secrets in memory only). */
async function questions(deps: InitDependencies, state: InitState, ask: Asker): Promise<{ answers: InitAnswers; parts: Partial<Record<PartName, PartResult>> }> {
  const dir = await ask.text("dir", "Where should bivy write your platform's configuration (a new folder, which becomes a private GitHub repo)?", {
    initial: "bivouac-platform",
    check: (value) => (existsSync(value) && readdirSync(value).length > 0 && !state.done.includes("instance repo written") ? `${value} exists and is not empty` : undefined),
  });
  // Absolute, so a run resumed from another folder finds it.
  state.recorded.dir = resolve(dir);
  const zone = (await ask.text("zone", "Your domain name, as bought from a registrar:", { placeholder: "example.org", check: (value) => (HOSTNAME.test(value) ? undefined : "a domain name, like example.org") })).toLowerCase();
  const domain = (await ask.text("domain", `The platform's own part of it: each app gets <name>.<this>. The sign-in page will live at auth.<this>, for good (passkeys are bound to it).`, {
    initial: `apps.${zone}`,
    check: (value) => (HOSTNAME.test(value) && (value === zone || value.endsWith(`.${zone}`)) ? undefined : `a name ending in ${zone}`),
  })).toLowerCase();

  const provider = await deps.provider();
  // Once a server may have been sent by this run, the server step itself decides whether it is ours.
  const problems = state.provisionalKey ? [] : await provider.projectProblems();
  if (problems.length > 0) throw new InitError(`this Hetzner project cannot receive a new platform:\n  ${problems.join("\n  ")}`);
  // Once confirmed, the server is what was confirmed: today's offers (prices, availability) no longer matter.
  let chosen: { location: string; name: string; hourly: number; disk: number };
  if (state.confirmed && state.answers) {
    chosen = { location: state.answers.location, name: state.answers.serverType, hourly: state.answers.hourly, disk: state.answers.disk };
  } else {
    const offers = await provider.offers();
    if (offers.length === 0) throw new InitError(`no x86 server with at least ${MINIMUM.memory} GB can be ordered anywhere right now: try again later`);
    const location = await ask.select("location", "Where should the server be? (cheapest first)", offers.map((offer) => ({
      value: offer.location,
      label: `${offer.location}, ${LOCATIONS[offer.location] ?? "Hetzner"}`,
      hint: `from €${offer.types[0]?.hourly}/hour`,
    })));
    const types = offers.find((offer) => offer.location === location)?.types ?? [];
    const serverType = await ask.select("server-type", "Which server? 4 GB of memory is enough to start.", types.map((type) => ({
      value: type.name,
      label: `${type.name}: ${type.memory} GB memory, ${type.disk} GB disk`,
      hint: `€${type.hourly}/hour incl. VAT`,
    })));
    const offer = types.find((type) => type.name === serverType);
    if (!offer) throw new InitError(`${serverType} cannot be ordered in ${location}`);
    chosen = { location, name: offer.name, hourly: offer.hourly, disk: offer.disk };
  }
  const { location, name: serverType } = chosen;

  const dnsId = await ask.select("dns", `Who serves the DNS of ${zone}?`, deps.dnsProviders.map((entry) => ({ value: entry.id, label: entry.label })));
  const dns = await deps.dnsProvider(dnsId, ask, zone);
  const dnsCheck = await dns.check(zone);
  if (dnsCheck.length > 0) throw new InitError(dnsCheck.join("\n"));

  const found = deps.sshKeys();
  const fresh = deps.newSshKeyPath;
  const keyChoice = await ask.select("ssh-key", "Which SSH key logs in to the server from this machine? One key per machine (D11).", [
    ...(existsSync(fresh) ? [] : [{ value: fresh, label: `A new key for this machine (${fresh})`, hint: "recommended" }]),
    ...found.map((entry) => ({ value: entry.path, label: entry.path, hint: entry.publicKey.split(" ").slice(2).join(" ") })),
  ]);
  const sshPublicKey = found.find((entry) => entry.path === keyChoice)?.publicKey ?? (existsSync(`${keyChoice}.pub`) ? readFileSync(`${keyChoice}.pub`, "utf8").trim() : deps.makeSshKey(keyChoice));

  // Only before the repo is answered: a resumed run does not ask for it again.
  if (state.recorded.repository === undefined) ask.log(`Create an EMPTY PRIVATE repo for the configuration (no README, no licence), here:\n  ${NEW_REPO_LINK}`);
  const repository = await ask.text("repository", "Its SSH address (Code → SSH):", {
    placeholder: "git@github.com:you/bivouac-platform.git",
    check: (value) => (repositorySchema.safeParse(value).success ? undefined : "like git@github.com:you/bivouac-platform.git"),
  });
  if (!state.done.includes("pushed to GitHub")) {
    const remote = deps.git(".", ["ls-remote", repository]);
    if (remote.status !== 0) throw new InitError(`your git cannot read ${repository}: is your SSH key on GitHub, and the repo created (${NEW_REPO_LINK})? (${remote.stderr.trim().split("\n").pop() ?? ""})`);
    if (remote.stdout.trim()) throw new InitError(`${repository} is not empty: bivy init needs a new, empty repo`);
  }

  const parts: Partial<Record<PartName, PartResult>> = {};
  const chosenParts = {} as Record<PartName, boolean>;
  for (const part of PARTS) {
    const what = { backups: "Nightly backups (strongly advised before any real data)", alerts: "Alerts on your phone (Pushover and healthchecks.io)", mail: "Mail from the sign-in service (invitations)" }[part];
    const now = await ask.select(part, `${what}: set them up now?`, [{ value: "now", label: "Now" }, { value: "later", label: `Later, with 'bivy configure ${part}'` }]);
    chosenParts[part] = now === "now";
    if (chosenParts[part] && !state.done.includes("instance repo written")) parts[part] = await askPart(deps.part(ask), part, domain);
  }
  return { answers: { dir: resolve(dir), zone, domain, location, serverType, hourly: chosen.hourly, disk: chosen.disk, dns: dnsId, sshKey: keyChoice, sshPublicKey, repository, parts: chosenParts }, parts };
}

/** The platform's own secrets (D14, D57), generated here, never shown. */
function baseSecrets(): Record<string, unknown> {
  return {
    master_secret: randomBytes(32).toString("hex"),
    pocket_id: { encryption_key: randomBytes(32).toString("base64"), static_api_key: randomBytes(32).toString("hex") },
  };
}

/** The age key, made once: appended to the key file, which may hold others. */
function ageIdentity(deps: InitDependencies, state: InitState): void {
  if (state.recipient && existsSync(deps.ageKeyFile) && readFileSync(deps.ageKeyFile, "utf8").includes(`# public key: ${state.recipient}`)) return;
  const identity = (deps.newAgeIdentity ?? newAgeIdentity)();
  mkdirSync(dirname(deps.ageKeyFile), { recursive: true, mode: 0o700 });
  const before = existsSync(deps.ageKeyFile) ? readFileSync(deps.ageKeyFile, "utf8") : "";
  appendFileSync(deps.ageKeyFile, `${before && !before.endsWith("\n") ? "\n" : ""}${keyFile(identity, new Date(deps.now()))}`, { mode: 0o600 });
  // A file or folder that existed keeps its own modes otherwise.
  chmodSync(dirname(deps.ageKeyFile), 0o700);
  chmodSync(deps.ageKeyFile, 0o600);
  state.recipient = identity.recipient;
  saveState(deps.stateFile, state);
}

const ageKeyOf = (deps: InitDependencies, dir: string) => instanceIdentity(readFileSync(deps.ageKeyFile, "utf8"), readFileSync(join(dir, ".sops.yaml"), "utf8"));

function writeInstance(deps: InitDependencies, state: InitState, answers: InitAnswers, parts: Partial<Record<PartName, PartResult>>): void {
  if (existsSync(answers.dir) && readdirSync(answers.dir).length > 0) throw new InitError(`${answers.dir} exists and is not empty: nothing was written`);
  ageIdentity(deps, state);
  // Written aside, then moved into place: an interruption never leaves half a repo.
  const work = `${answers.dir}.bivy-${state.run}`;
  rmSync(work, { recursive: true, force: true });
  cpSync(deps.template ?? TEMPLATE, work, { recursive: true });
  const platformPath = join(work, "platform.yml");
  const document = parseDocument(readFileSync(platformPath, "utf8"));
  document.set("domain", answers.domain);
  document.set("repository", answers.repository);
  let platformText = document.toString({ lineWidth: 0 });
  const additions = Object.assign({}, ...Object.values(parts).map((part) => part.platform)) as Record<string, unknown>;
  if (Object.keys(additions).length > 0) platformText = addToPlatformYml(platformText, additions);
  writeFileSync(platformPath, platformText);
  writeFileSync(join(work, "ssh-keys.yml"), `# Public SSH keys allowed to log in to the server as \`core\`. One key per\n# machine and per use (D11, D12). Changing this list is a high-risk change.\n${stringify({ keys: [{ name: "first-machine", key: answers.sshPublicKey }] }, { lineWidth: 0 })}`);
  writeFileSync(join(work, ".sops.yaml"), [
    "# The age key the secrets are encrypted for. Its private part is on the",
    "# server, on the owner's machine and in their password manager: never in",
    "# Git or GitHub (D35, D36).",
    "creation_rules:",
    "  - path_regex: ^secrets/.*\\.sops\\.yaml$",
    `    age: ${state.recipient}`,
    "",
  ].join("\n"));
  const secrets = Object.assign(baseSecrets(), ...Object.values(parts).map((part) => part.secrets)) as Record<string, unknown>;
  mkdirSync(join(work, "secrets"), { recursive: true });
  writeFileSync(join(work, "secrets", "platform.sops.yaml"), deps.sops.encrypt(stringify(secrets, { lineWidth: 0 }), state.recipient as string));
  const instance = loadInstance(work);
  if (instance.errors.length > 0) {
    rmSync(work, { recursive: true, force: true });
    throw new InitError(`the generated configuration does not validate (a bug in bivy): ${instance.errors.map((error) => `${error.file}: ${error.message}`).join("; ")}`);
  }
  for (const args of [["init", "--quiet", "-b", "main"], ["add", "-A"], ["commit", "--quiet", "-m", "Bivouac instance, made by bivy init"]]) {
    const done = deps.git(work, args);
    if (done.status !== 0) throw new InitError(`git ${args[0]} failed in ${work}: ${done.stderr.trim()}`);
  }
  mkdirSync(dirname(answers.dir), { recursive: true });
  renameSync(work, answers.dir);
  state.spent = Object.values(parts).flatMap((part) => part.spent);
}

/** The values the owner keeps, read back from what was written: the age key from its file, the restic password decrypted. */
function valuesToKeep(deps: InitDependencies, answers: InitAnswers): { what: string; value: string }[] {
  const identity = ageKeyOf(deps, answers.dir);
  const secret = identity.toString("utf8").split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-")) ?? "";
  const plain = parse(deps.sops.decrypt(readFileSync(join(answers.dir, "secrets", "platform.sops.yaml"), "utf8"), identity)) as { backup?: { restic_password?: string } };
  return [
    { what: "The age master key (it opens every secret of the platform)", value: secret },
    ...(plain.backup?.restic_password ? [{ what: "The restic password (without it, the backups cannot be read)", value: plain.backup.restic_password }] : []),
  ];
}

/** Shows values once and waits for the typed word: terminal only (D38). */
export async function showOnce(ask: Asker, values: { what: string; value: string }[]): Promise<void> {
  if (!ask.tty) throw new AskError("bivy is about to show secrets to keep in your password manager: run the same command in a terminal (they are never shown to a script)");
  ask.log(["", "Keep these in your password manager NOW. bivy shows them this once; without them, a lost machine means a lost platform.", ...values.flatMap((entry) => ["", `  ${entry.what}:`, `    ${entry.value}`]), ""].join("\n"));
  while (!(await ask.typed("Type 'stored' once they are in your password manager:", "stored"))) ask.log("  not 'stored': nothing goes on until they are kept.");
  ask.log("  Also keep your GitHub account's recovery codes there (D38). You may clear this terminal's scrollback now.");
}

function setSetupFrom(dir: string, address: string | undefined): void {
  const path = join(dir, "platform.yml");
  const document = parseDocument(readFileSync(path, "utf8"));
  if (address) document.setIn(["auth", "setupFrom"], address);
  else {
    document.deleteIn(["auth", "setupFrom"]);
    const auth = document.get("auth") as { items?: unknown[] } | undefined;
    if (auth && Array.isArray(auth.items) && auth.items.length === 0) document.delete("auth");
  }
  writeFileSync(path, document.toString({ lineWidth: 0 }));
}

function commitAndPush(deps: InitDependencies, dir: string, message: string): void {
  for (const args of [["add", "platform.yml"], ["commit", "--quiet", "-m", message], ["push", "--quiet", "origin", "HEAD:main"]]) {
    const done = deps.git(dir, args);
    if (done.status !== 0 && !(args[0] === "commit" && /nothing to commit/.test(done.stdout + done.stderr))) throw new InitError(`git ${args[0]} failed in ${dir}: ${done.stderr.trim().split("\n").pop() ?? ""}`);
  }
}

export async function init(deps: InitDependencies): Promise<InitState> {
  // A first run on a new machine: the folder the lock and the state live in does not exist yet.
  mkdirSync(dirname(deps.stateFile), { recursive: true, mode: 0o700 });
  return withLock(`${deps.stateFile}.lock`, async () => {
    const state = readState<InitState>(deps.stateFile) ?? newRun(deps);
    saveState(deps.stateFile, state);
    if (state.done.length > 0) deps.log(`Carrying on with bivy init ${state.run} (${state.done.length} steps done; delete ${deps.stateFile} to start over).`);
    return run(deps, state);
  }).catch((error: unknown) => {
    if (error instanceof RebuildError && /another bivy rebuild is running/.test(error.message)) throw new InitError(`another bivy init is running (${deps.stateFile}.lock); if none is, remove that file`);
    throw error;
  });
}

async function run(deps: InitDependencies, state: InitState): Promise<InitState> {
  const c: CommonDependencies = {
    ...deps,
    remote: (host) => deps.remote(host, state.answers?.sshKey ?? ""),
    ageKey: () => ageKeyOf(deps, state.answers?.dir ?? "."),
  };
  // bivy keeps one platform's credentials and host key per machine user: a second one would mix them up.
  if (!state.done.includes("server") && existsSync(deps.knownHosts)) {
    throw new InitError(`this machine already reaches a platform (${deps.knownHosts}). bivy init makes a new one: run it as another user, or move ${dirname(deps.knownHosts)} aside first`);
  }
  // Without one, git makes up an address from the machine's name for every commit bivy makes (D99 trial).
  const unset = ["user.name", "user.email"].filter((key) => deps.git(".", ["config", key]).stdout.trim() === "");
  if (unset.length > 0) {
    throw new InitError(`git has no ${unset.join(" or ")} on this machine, and bivy commits to your instance repo in your name. Set them first, then run again:\n  git config --global user.name "Your Name"\n  git config --global user.email you@example.org\nGitHub's private address works too (GitHub → Settings → Emails).`);
  }
  const ask = recording(deps, state);
  const { answers, parts } = await questions(deps, state, ask);
  // What was confirmed is what gets built: a flag cannot change it afterwards (rule 5).
  if (state.confirmed && state.answers && JSON.stringify(answers) !== JSON.stringify(state.answers)) {
    const changed = (Object.keys(answers) as (keyof InitAnswers)[]).filter((key) => JSON.stringify(answers[key]) !== JSON.stringify(state.answers?.[key]));
    throw new InitError(`these answers differ from the ones you confirmed: ${changed.join(", ")}. Run again without changing them, or delete ${deps.stateFile} to start over`);
  }
  state.answers = answers;
  saveState(deps.stateFile, state);

  if (!state.confirmed) {
    const monthly = Math.round(answers.hourly * 720 * 100) / 100;
    ask.log([
      "",
      "bivy is about to create, in your Hetzner project:",
      `  - a server ${answers.serverType} in ${answers.location}: €${answers.hourly}/hour incl. VAT, about €${monthly} for a 30-day month;`,
      "  - a fixed IPv4 and IPv6 (the IPv4 about €0.50/month excl. VAT, the IPv6 free), kept even if the server goes;",
      "  - a firewall letting in SSH and the web only, and the Flatcar image if missing (a few cents).",
      `Then it pushes the configuration to ${answers.repository}, and asks again before touching the DNS of ${answers.zone}.`,
      `Parts left for later: ${PARTS.filter((part) => !answers.parts[part]).join(", ") || "none"}.`,
    ].join("\n"));
    while (!(await ask.typed(`Type the platform domain (${answers.domain}) to go ahead:`, answers.domain))) ask.log("  not the domain: type it again, or Ctrl-C to stop (nothing was created).");
    state.confirmed = true;
    saveState(deps.stateFile, state);
  }

  await step(c, state, "instance repo written", async () => writeInstance(deps, state, answers, parts));
  await step(c, state, "secrets kept safe", async () => showOnce(ask, valuesToKeep(deps, answers)));
  await step(c, state, "pushed to GitHub", async () => {
    const remote = deps.git(answers.dir, ["remote"]);
    if (!remote.stdout.split("\n").includes("origin")) deps.git(answers.dir, ["remote", "add", "origin", answers.repository]);
    const pushed = deps.git(answers.dir, ["push", "--quiet", "-u", "origin", "main"]);
    if (pushed.status !== 0) throw new InitError(`git push failed: ${pushed.stderr.trim().split("\n").pop() ?? ""}`);
    // Now only in the encrypted file, which the server and the age key read.
    for (const file of state.spent ?? []) rmSync(file, { force: true });
  });

  const provider = await deps.provider();
  await step(c, state, "Flatcar image", async () => {
    state.image = (await provider.flatcarImage(answers.location, answers.disk)).id;
  });
  await step(c, state, "fixed IP addresses", async () => {
    const { ipv4, ipv6 } = await provider.addresses(answers.location);
    Object.assign(state, { ipv4: ipv4.ip, ipv4Id: ipv4.id, ipv6Network: ipv6.network, ipv6Id: ipv6.id });
  });
  await step(c, state, "firewall", async () => {
    state.firewallId = (await provider.firewall()).id;
  });
  await step(c, state, "server", async () => {
    if (state.image === undefined || state.ipv4Id === undefined || state.ipv6Id === undefined || state.firewallId === undefined || !state.ipv6Network) throw new InitError("the state file is incomplete");
    const request = { type: answers.serverType, location: answers.location, image: state.image, ipv4Id: state.ipv4Id, ipv6Id: state.ipv6Id, firewallId: state.firewallId };
    const existing = await provider.find();
    if (existing) {
      // Only ours if this run may have sent it; the provisional key check that follows proves it.
      if (!state.provisionalKey) throw new InitError((await provider.projectProblems()).join("; ") || `a server '${PLATFORM_NAME}' already exists`);
      state.serverId = (await provider.server({ ...request, userData: undefined })).id;
      return;
    }
    // Never sent anywhere before: a fresh key for each attempt.
    const hostKey = deps.newHostKey();
    const userData = withHostKey(deps.ignition(answers.dir, firstAddress(state.ipv6Network)), hostKey);
    state.provisionalKey = keyPart(hostKey.publicKey);
    saveState(deps.stateFile, state);
    state.serverId = (await provider.server({ ...request, userData })).id;
  });
  const ipv4 = state.ipv4 as string;
  await step(c, state, "SSH answers", async () => {
    let seen: string | undefined;
    await waitUntil(deps, "the server's SSH", 10 * 60_000, () => {
      const scanned = deps.scanHostKey(ipv4);
      seen = scanned ? scannedKey(scanned.line) : undefined;
      return seen !== undefined;
    });
    // Not proof (anyone on the path could answer): the verified connection that follows is.
    if (seen !== state.provisionalKey && !state.hostKey) throw new InitError("the server does not present the host key placed with its Ignition config: nothing was sent");
  });

  const instance = loadInstance(answers.dir);
  if (!instance.platform) throw new InitError(`${answers.dir}/platform.yml is invalid`);
  const platform = instance.platform;
  const remote = deps.remote(ipv4, answers.sshKey);
  await bringBack(c, state, {
    mode: "init",
    apps: [],
    deployKeyTitle: `${PLATFORM_NAME}-server`,
    deployKey: (server, title, key) => ownerAddsDeployKey(deps, platform, server, title, key),
  });

  const auth = `${AUTH_SUBDOMAIN}.${answers.domain}`;
  await step(c, state, "DNS", async () => {
    const dns = await deps.dnsProvider(answers.dns, ask, answers.zone);
    const problems = await dnsProblems(deps.dns, dns, answers.domain, answers.zone, ipv4);
    if (problems.length > 0) throw new InitError(`the DNS step stops here, nothing was written:\n  ${problems.join("\n  ")}`);
    // The provider's own view first: public DNS may not show a record it just got.
    const held = (await dns.existing(answers.zone, "_dmarc", "TXT")) ?? (await deps.dns.txt(`_dmarc.${answers.zone}`));
    const hasDmarc = held.some((value) => value.replace(/^"|"$/g, "").startsWith("v=DMARC1"));
    const records = wantedRecords(answers.domain, answers.zone, ipv4, hasDmarc);
    ask.log(["", `The DNS of ${answers.zone} gets:`, ...records.map((record) => `  ${fqdn(record.name, answers.zone)} ${record.type} ${record.value}`), "Nothing else is changed or removed. From then on, the sign-in page is public: its first-admin page stays refused until the next step (D15, D69)."].join("\n"));
    while (!(await ask.typed(`Type the platform domain (${answers.domain}) to write these records:`, answers.domain))) ask.log("  not the domain: type it again, or Ctrl-C to stop (the DNS is not touched; run again when ready).");
    await dns.apply(answers.zone, records);
    const label = `bivy-${randomBytes(3).toString("hex")}`;
    await waitUntil(deps, "public DNS", 60 * 60_000, () => propagated(deps.dns, answers.domain, ipv4, label));
    deps.log("  public DNS answers with the server's address");
    // Asks Let's Encrypt at once rather than at its next retry (D69).
    must(remote, "restarting Caddy", "docker restart bivouac-caddy >/dev/null");
    await waitUntil(deps, `${auth} with a valid certificate`, 15 * 60_000, () => deps.probeReal(auth, "/.well-known/jwks.json").status === 200);
    deps.log(`  ${auth} answers with a valid certificate`);
  });

  const users = () => Number(must(remote, "counting Pocket ID's users", "docker exec bivouac-postgres psql -U postgres -d bivouac_pocket_id -At -c 'select count(*) from users'").trim());
  await step(c, state, "first admin", async () => {
    if (users() === 0) {
      const address = await deps.publicIpv4();
      if (!isPublicAddress(address) || address.includes(":")) throw new InitError(`this machine's address ${address} is not a public IPv4: the first-admin page cannot be opened for it alone (D67)`);
      setSetupFrom(answers.dir, address);
      commitAndPush(deps, answers.dir, "Open Pocket ID's first-admin page to the owner's address (bivy init, D15)");
      deps.log("  opening the first-admin page to your address: the server picks the change up within a minute or two…");
      await waitUntil(deps, "the first-admin page", 10 * 60_000, () => deps.probeReal(auth, "/setup").status === 200);
      ask.log([
        "",
        `  ▶ Open https://${auth}/setup in your browser (from this machine's network, over IPv4),`,
        "    create your admin account, then add a second passkey that does not live in the same place",
        "    (phone and computer, or a synced passkey). Waiting for the account (up to an hour)…",
      ].join("\n"));
      await waitUntil(deps, "the admin account", 60 * 60_000, () => users() > 0);
      const account = must(remote, "reading the account", "docker exec bivouac-postgres psql -U postgres -d bivouac_pocket_id -At -c 'select username, email from users'").trim();
      // Typed by whoever opened the page: no terminal control characters.
      ask.log(`  account created: ${account.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").replace("|", ", ")}`);
      // Someone sharing this IPv4 (a carrier's NAT) could have been first: only the owner can tell.
      if (ask.tty && !(await ask.typed("If that account is yours, type 'done' once your passkeys are registered (two are safer: one on each device):", "done"))) {
        throw new InitError("not confirmed as yours: /setup is still open to your address. Look in Pocket ID's admin screen, then run again (it closes the page)");
      }
    }
    setSetupFrom(answers.dir, undefined);
    commitAndPush(deps, answers.dir, "Close Pocket ID's first-admin page (bivy init, D15)");
    deps.log("  closing the first-admin page again: the server picks the change up within a minute or two…");
    await waitUntil(deps, "the first-admin page closed", 10 * 60_000, () => deps.probeReal(auth, "/setup").status === 403);
    const count = users();
    if (count !== 1) throw new InitError(`Pocket ID has ${count} accounts, not one: someone else may have used the page. Look before anything else (D69)`);
    deps.log("  one admin account, and the first-admin page is closed again");
  });

  if (answers.parts.alerts) {
    await step(c, state, "alert tried", async () => {
      must(remote, "sending a test alert", `${RECONCILER} alert-test`);
      deps.log("  a test message is on its way to your phone");
    });
  }
  renameSync(deps.stateFile, `${deps.stateFile}.done-${state.run}`);
  return state;
}

/** The closing words: what works, what is left. */
export function summary(state: InitState): string {
  const answers = state.answers as InitAnswers;
  const later = PARTS.filter((part) => !answers.parts[part]);
  return [
    `✓ The platform runs on ${state.ipv4}: https://${AUTH_SUBDOMAIN}.${answers.domain}, configuration in ${answers.dir} (${repositoryPath(answers.repository)}).`,
    ...(later.length > 0 ? [`  Left for later: ${later.map((part) => `bivy configure ${part}`).join(", ")}${later.includes("backups") ? ". Without backups, keep no real data on it" : ""}.`] : []),
    ...(answers.parts.mail ? ["  Check the mail: Pocket ID → Application Configuration → Email → Send test email."] : []),
    ...(answers.parts.backups ? ["  The first backup runs tonight at 02:00 UTC (D74)."] : []),
    "  Reach the server with: bivy ssh " + answers.dir + ` --ssh-key ${answers.sshKey}`,
  ].join("\n");
}
