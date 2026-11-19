import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AskError, type Asker, terminalAsker } from "./ask.js";
import { ConfigureError, PARTS, type PartName, configurePart } from "./configure.js";
import { CredentialError } from "./credentials.js";
import { ManualDns, publicDns, type DnsProvider } from "./dns.js";
import { Hetzner } from "./hetzner.js";
import { newHostKey } from "./hostkey.js";
import { InitError, init, showOnce, summary, type InitDependencies } from "./init.js";
import { OvhDns, ovhKeysLink } from "./ovh.js";
import { RebuildError, curlProbe, instanceIdentity } from "./rebuild.js";
import { loadInstance } from "@bivouac/manifest";
import { checkoutProblems } from "./rebuild-real.js";
import { SshRemote, scanHostKey } from "./remote.js";
import { HetznerProvider } from "./server-provider.js";
import { checkSmtp } from "./smtp.js";
import { dockerSops } from "./sops.js";
import { printBanner } from "./banner.js";
import { buildButane, compileButane } from "./ignition.js";

/**
 * `bivy init` and `bivy configure <part>`: their own flags, kept apart from
 * cli.ts so the other commands' code stays as it is.
 */

export const INIT_USAGE = `
  init                        make a new platform, from an empty Hetzner project and a
                              domain (D99). Asks its questions; each one also has a flag:
      --dir <folder>  --zone <example.org>  --domain <apps.example.org>
      --location <fsn1>  --server-type <cx23>  --dns <ovh|manual>
      --ssh-key <file>  --repository <git@github.com:you/repo.git>
      --backups <now|later>  --alerts <now|later>  --mail <now|later>
      --backup-provider <b2|s3>  --backup-region  --backup-endpoint  --backup-bucket
      --smtp-host  --smtp-user  --smtp-from
                              Credentials are typed (hidden) or read from ~/.config/bivouac/.
                              Three moments need a terminal: the cost confirmation, the
                              keys shown once, and the consent before the DNS is written.
  configure <part> [dir]      add backups, alerts or mail to a platform that has none yet`;

const STRING_FLAGS = ["dir", "zone", "domain", "location", "server-type", "dns", "ssh-key", "repository", "backups", "alerts", "mail", "backup-provider", "backup-region", "backup-endpoint", "backup-bucket", "smtp-host", "smtp-user", "smtp-from"] as const;

const config = (file: string) => join(homedir(), ".config", "bivouac", file);
const AGE_KEY_FILE = join(homedir(), ".config", "sops", "age", "keys.txt");
const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function git(dir: string, args: string[]) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

async function publicIpv4(): Promise<string> {
  const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new InitError(`api.ipify.org answered HTTP ${response.status}: cannot tell this machine's IPv4`);
  return (await response.text()).trim();
}

function partDeps(ask: Asker) {
  return { ask, config, fetch: globalThis.fetch, checkSmtp: (account: Parameters<typeof checkSmtp>[0]) => checkSmtp(account), now: Date.now };
}

async function hetznerFrom(ask: Asker): Promise<Hetzner> {
  const token = await ask.secret({
    path: config("hetzner-token"),
    what: "the Hetzner token",
    hint: "bivy needs a Hetzner API token (Read & Write) of an EMPTY project made for the platform: Hetzner Console → New project → Security → API tokens.",
  });
  return new Hetzner(token);
}

async function dnsProvider(id: string, ask: Asker, zone: string): Promise<DnsProvider> {
  if (id === "manual") return new ManualDns(console.log);
  if (id !== "ovh") throw new InitError(`no DNS provider '${id}'`);
  const hint = `bivy needs OVH keys limited to the zone ${zone} (D49). Create them here, with "Unlimited" validity:\n  ${ovhKeysLink(zone)}`;
  const applicationKey = await ask.secret({ path: config("ovh-application-key"), what: "the OVH application key", hint });
  const applicationSecret = await ask.secret({ path: config("ovh-application-secret"), what: "the OVH application secret" });
  const consumerKey = await ask.secret({ path: config("ovh-consumer-key"), what: "the OVH consumer key" });
  return new OvhDns({ applicationKey, applicationSecret, consumerKey });
}

function sshKeys(): { path: string; publicKey: string }[] {
  const dir = join(homedir(), ".ssh");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".pub") && existsSync(join(dir, file.slice(0, -4))))
    .map((file) => ({ path: join(dir, file.slice(0, -4)), publicKey: readFileSync(join(dir, file), "utf8").trim() }))
    .filter((entry) => /^(ssh-ed25519|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) /.test(entry.publicKey));
}

function makeSshKey(path: string): string {
  if (!tty) throw new AskError(`a new SSH key is made in a terminal (its passphrase is yours to choose): run bivy init in one, or pass --ssh-key <file>`);
  const made = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", path, "-C", `bivouac-${homedir().split("/").pop() ?? "machine"}`], { stdio: "inherit" });
  if (made.status !== 0) throw new InitError("ssh-keygen did not make the key");
  console.log(`If you gave it a passphrase, add it to the agent now (bivy never asks for it): ssh-add ${process.platform === "darwin" ? "--apple-use-keychain " : ""}${path}`);
  return readFileSync(`${path}.pub`, "utf8").trim();
}

export async function initCli(argv: string[]): Promise<number> {
  const options = Object.fromEntries(STRING_FLAGS.map((flag) => [flag, { type: "string" as const }]));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { ...options, help: { type: "boolean", short: "h" } } });
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return 1;
  }
  const { positionals, values } = parsed;
  const flags = Object.fromEntries(STRING_FLAGS.map((flag) => [flag, (values as Record<string, unknown>)[flag] as string | undefined]).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const [command, ...rest] = positionals;
  if (values.help) {
    console.log(INIT_USAGE);
    return 0;
  }
  try {
    if (command === "configure") return await configure(rest, flags);
    printBanner();
    // An answer already given wins over a flag: what was confirmed is what gets built.
    const asker = (recorded: Record<string, string>) => {
      for (const [flag, value] of Object.entries(flags)) {
        if (recorded[flag] !== undefined && recorded[flag] !== value) console.log(`--${flag} ignored: '${recorded[flag]}' was answered before (delete ${config("init.json")} to start over).`);
      }
      return terminalAsker({ ...flags, ...recorded }, tty);
    };
    let hetzner: Hetzner | undefined;
    const deps: InitDependencies = {
      asker,
      provider: async () => {
        const ask = asker({});
        hetzner ??= await hetznerFrom(ask);
        return new HetznerProvider(hetzner, {
          ask,
          run: (cmd, args, opts = {}) => {
            const result = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...opts.env }, stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : "pipe", maxBuffer: 16 * 1024 * 1024 });
            return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
          },
          fetchText: async (url) => {
            const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (!response.ok) throw new InitError(`${url} answered HTTP ${response.status}`);
            return response.text();
          },
          config,
          log: console.log,
        }, sleep);
      },
      dnsProvider,
      dnsProviders: [{ id: "ovh", label: new OvhDns({ applicationKey: "", applicationSecret: "", consumerKey: "" }).label }, { id: "manual", label: new ManualDns(console.log).label }],
      dns: publicDns(),
      sops: dockerSops,
      part: partDeps,
      remote: (host, identity) => new SshRemote(host, identity, config("known_hosts")),
      scanHostKey,
      newHostKey: () => newHostKey(),
      ignition: (dir, ipv6) => {
        const instance = loadInstance(dir);
        if (instance.errors.length > 0 || !instance.platform || !instance.sshKeys) throw new InitError(`${dir} does not validate: run 'bivy validate ${dir}'`);
        return compileButane(buildButane(dir, instance.platform, instance.sshKeys, ipv6));
      },
      probeReal: (host, path) => curlProbe(host, undefined, path, false),
      publicIpv4,
      git,
      sshKeys,
      makeSshKey,
      ageKeyFile: AGE_KEY_FILE,
      newSshKeyPath: join(homedir(), ".ssh", "bivouac"),
      stateFile: config("init.json"),
      knownHosts: config("known_hosts"),
      log: console.log,
      sleep,
      now: Date.now,
    };
    const state = await init(deps);
    console.log(`\n${summary(state)}`);
    return 0;
  } catch (error) {
    if (error instanceof InitError || error instanceof AskError || error instanceof CredentialError || error instanceof ConfigureError || error instanceof RebuildError) {
      console.error(`✗ ${error.message}`);
      if (command === "init" && existsSync(config("init.json"))) console.error("Run the same command again to carry on: answers given and steps done are kept.");
      return 1;
    }
    throw error;
  }
}

async function configure(args: string[], flags: Record<string, string>): Promise<number> {
  const [part, directory = "."] = args;
  if (!part || !PARTS.includes(part as PartName)) {
    console.error(`Which part? bivy configure <${PARTS.join("|")}> [dir]`);
    return 1;
  }
  const root = resolve(directory);
  const ask = terminalAsker(flags, tty);
  const summaryText = await configurePart({
    ...partDeps(ask),
    sops: dockerSops,
    identity: () => instanceIdentity(readFileSync(AGE_KEY_FILE, "utf8"), readFileSync(join(root, ".sops.yaml"), "utf8")),
    checkout: () => checkoutProblems(root),
    git: (gitArgs) => git(root, gitArgs),
    showOnce: (values) => showOnce(ask, values),
  }, root, part as PartName);
  console.log(`✓ Pushed: ${summaryText}. The reconciler applies it within a minute.`);
  return 0;
}
