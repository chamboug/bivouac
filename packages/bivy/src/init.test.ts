import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstance } from "@bivouac/manifest";
import { parse } from "yaml";
import { AskError, type Asker } from "./ask.js";
import type { DnsProvider, DnsRecord, PublicDns } from "./dns.js";
import { HOST_KEY_PATH } from "./hostkey.js";
import { type InitDependencies, type InitState, init, summary } from "./init.js";
import type { CommandOutput, Remote } from "./remote.js";
import type { Offer, ServerProvider } from "./server-provider.js";
import { dockerSops } from "./sops.js";

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

const PROVISIONAL = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprovisional\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAAprovisional bivouac-provisional" };
const OWN_KEY = "ssh-ed25519 AAAAown bivouac-server";
const REPOSITORY = "git@github.com:example/bivouac-platform.git";
const USER_KEY = readFileSync(join(import.meta.dirname, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();

class FakeProvider implements ServerProvider {
  calls: string[] = [];
  problems: string[] = [];
  servers = 0;
  userData = "";
  failServerOnce = false;
  /** Hetzner refuses the creation once (a type no longer available): nothing is created. */
  refuseServerOnce = false;
  userDatas: (string | undefined)[] = [];
  async projectProblems() {
    this.calls.push("projectProblems");
    return this.problems;
  }
  async offers(): Promise<Offer[]> {
    return [{ location: "fsn1", types: [{ name: "cx23", hourly: 0.01056, memory: 4, disk: 40 }] }];
  }
  async flatcarImage() {
    this.calls.push("flatcarImage");
    return { id: 10, version: "4757.2.3" };
  }
  async addresses() {
    this.calls.push("addresses");
    return { ipv4: { id: 2, ip: "203.0.113.10" }, ipv6: { id: 3, network: "2001:db8:1::/64" } };
  }
  async firewall() {
    this.calls.push("firewall");
    return { id: 4 };
  }
  async find() {
    return this.servers > 0 ? { id: 1 } : undefined;
  }
  async server(request: { userData: string | undefined }) {
    this.calls.push("server");
    this.userDatas.push(request.userData);
    if (this.refuseServerOnce) {
      this.refuseServerOnce = false;
      throw new Error("server type unavailable");
    }
    if (this.servers === 0) {
      if (!request.userData) throw new Error("created without user-data");
      this.servers = 1;
      this.userData = request.userData;
      if (this.failServerOnce) {
        this.failServerOnce = false;
        throw new Error("fetch failed");
      }
      return { id: 1, created: true };
    }
    return { id: 1, created: false };
  }
}

/** The new server: Flatcar, then the base the reconciler starts. */
class FakeServer implements Remote {
  commands: string[] = [];
  presented = PROVISIONAL.publicKey;
  deployKeyAdded = false;
  users = 0;
  ageKey = Buffer.alloc(0);
  knownHosts = () => "";
  run(command: string, options: { input?: string | Buffer } = {}): CommandOutput {
    if (!this.knownHosts().includes(this.presented.split(" ").slice(0, 2).join(" "))) return { status: 255, stdout: "", stderr: "Host key verification failed." };
    this.commands.push(command);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (command.includes(`-f ${HOST_KEY_PATH}.new`) && command.includes("ssh-keygen")) return ok(`${OWN_KEY}\n`);
    if (command.includes(`mv -f ${HOST_KEY_PATH}.new ${HOST_KEY_PATH}`)) {
      this.presented = OWN_KEY;
      return ok("");
    }
    if (command.startsWith("grep -E")) return ok('ID="flatcar"\nbivouac-dir\nactive\nmetadata-block\nPermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers core\n');
    if (command.includes("deploy_key.pub")) return ok("ssh-ed25519 AAAAdeploy bivouac-server\n");
    if (command.includes("ls-remote")) {
      if (!this.deployKeyAdded) {
        this.deployKeyAdded = true;
        return { status: 128, stdout: "", stderr: "Permission denied (publickey)." };
      }
      return ok("abc\trefs/heads/main\n");
    }
    if (command.includes("git-receive-pack")) return ok("ERROR: The key you are authenticating with has been marked as read only.\n");
    if (command === "sudo test -e /etc/bivouac/age.key") return { status: this.ageKey.length > 0 ? 0 : 1, stdout: "", stderr: "" };
    if (command.includes("cat > /etc/bivouac/age.key.tmp")) {
      this.ageKey = Buffer.from(options.input ?? "");
      return ok("");
    }
    if (command.includes("sha256sum /etc/bivouac/age.key")) return ok(`${createHash("sha256").update(this.ageKey).digest("hex")}  /etc/bivouac/age.key\n`);
    if (command.includes("docker ps")) return ok("bivouac-postgres Up 2 minutes (healthy)\nbivouac-pocket-id Up 1 minute (healthy)\nbivouac-caddy Up 1 minute (healthy)\n");
    if (command.includes("select count(*) from users")) return ok(`${this.users}\n`);
    if (command.includes("select username, email from users")) return ok("owner|owner@example.org\n");
    return ok("");
  }
}

interface Script {
  answers: Record<string, string>;
  typed: string[];
  secrets?: Record<string, string>;
  tty?: boolean;
}

function scriptedAsker(script: Script, log: (message: string) => void, asked: string[]): (recorded: Record<string, string>) => Asker {
  return (recorded) => ({
    tty: script.tty ?? true,
    async select(flag, _message, choices) {
      const value = recorded[flag] ?? script.answers[flag];
      asked.push(flag);
      if (value === undefined) throw new AskError(`no answer for ${flag}`);
      if (!choices.some((choice) => choice.value === value)) throw new AskError(`--${flag} must be one of: ${choices.map((choice) => choice.value).join(", ")}`);
      return value as never;
    },
    async text(flag, _message, options = {}) {
      const value = recorded[flag] ?? script.answers[flag] ?? options.initial;
      asked.push(flag);
      if (value === undefined) throw new AskError(`no answer for ${flag}`);
      const problem = options.check?.(value);
      if (problem) throw new AskError(`--${flag}: ${problem}`);
      return value;
    },
    async secret(spec) {
      const value = script.secrets?.[spec.path.split("/").pop() ?? ""];
      if (!value) throw new AskError(`no secret ${spec.path}`);
      if (!existsSync(spec.path)) writeFileSync(spec.path, value, { mode: 0o600 });
      return value;
    },
    async typed(message, expected) {
      if (!(script.tty ?? true)) throw new AskError(`${message} needs a terminal`);
      const answer = script.typed.shift();
      asked.push(`typed:${expected}`);
      return answer === expected;
    },
    log,
  });
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(script: Script, overrides: Partial<InitDependencies> = {}) {
  const home = mkdtempSync(join(tmpdir(), "bivy-init-"));
  dirs.push(home);
  // Not created: a newcomer's machine has no ~/.config/bivouac yet.
  const config = join(home, "config");
  // The empty private repo the owner created on GitHub.
  const bare = join(home, "github.git");
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
  const provider = new FakeProvider();
  const server = new FakeServer();
  const knownHosts = join(config, "known_hosts");
  server.knownHosts = () => (existsSync(knownHosts) ? readFileSync(knownHosts, "utf8") : "");
  const written: DnsRecord[] = [];
  const dnsProvider: DnsProvider = {
    id: "manual",
    label: "manual",
    check: async () => [],
    existing: async () => undefined,
    apply: async (_zone, records) => {
      written.push(...records);
    },
  };
  const publicDns: PublicDns = {
    a: async (name) => (written.length > 0 || name.startsWith("taken.") ? ["203.0.113.10"] : []),
    aaaa: async () => [],
    txt: async () => [],
    caa: async () => [],
  };
  const dir = join(home, "bivouac-platform");
  const logs: string[] = [];
  const asked: string[] = [];
  let clock = Date.parse("2026-11-19T09:00:00Z");
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, "-c", `url.${bare}.insteadOf=${REPOSITORY}`, "-c", "user.name=Owner", "-c", "user.email=owner@example.org", ...args], { encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  const setupOpen = () => existsSync(join(dir, "platform.yml")) && readFileSync(join(dir, "platform.yml"), "utf8").includes("setupFrom");
  const deps: InitDependencies = {
    asker: scriptedAsker({ ...script, answers: { dir, zone: "example.org", location: "fsn1", "server-type": "cx23", dns: "manual", "ssh-key": join(home, "id_ed25519"), repository: REPOSITORY, backups: "later", alerts: "later", mail: "later", ...script.answers } }, (message) => logs.push(message), asked),
    provider: async () => provider,
    dnsProvider: async () => dnsProvider,
    dnsProviders: [{ id: "manual", label: "manual" }],
    dns: publicDns,
    sops: dockerSops,
    part: (ask) => ({ ask, config: (name) => join(config, name), fetch: (async () => new Response("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>")) as unknown as typeof fetch, checkSmtp: async () => {}, now: () => clock }),
    remote: () => server,
    scanHostKey: () => ({ line: `203.0.113.10 ${server.presented.split(" ").slice(0, 2).join(" ")}`, fingerprint: "SHA256:any" }),
    newHostKey: () => PROVISIONAL,
    ignition: (_dir, ipv6) => `{"ignition":{"version":"3.4.0"},"ipv6":"${ipv6}"}`,
    probeReal: (_host, path) => {
      if (path === "/setup") {
        if (setupOpen()) {
          server.users = 1; // the owner creates the admin
          return { status: 200, body: "" };
        }
        return { status: 403, body: "" };
      }
      return { status: written.length > 0 ? 200 : 0, body: "{}" };
    },
    publicIpv4: async () => "198.51.100.7",
    git,
    sshKeys: () => [{ path: join(home, "id_ed25519"), publicKey: USER_KEY }],
    makeSshKey: () => {
      throw new Error("not in tests");
    },
    ageKeyFile: join(home, "age", "keys.txt"),
    newSshKeyPath: join(home, "bivouac"),
    stateFile: join(config, "init.json"),
    knownHosts,
    log: (message) => logs.push(message),
    sleep: async () => {
      clock += 10_000;
    },
    now: () => clock,
    ...overrides,
  };
  return { deps, provider, server, written, logs, asked, dir, bare, config, home, git };
}

const typedAll = () => ["apps.example.org", "stored", "apps.example.org", "done"];

describeWithDocker("bivy init", () => {
  it("goes from an empty project to a running platform, asking for consent three times", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    const state = await init(run.deps);

    // The instance repo, pushed to the empty repo, valid, its secrets encrypted for the new age key.
    const instance = loadInstance(run.dir);
    expect(instance.errors).toEqual([]);
    expect(instance.platform?.domain).toBe("apps.example.org");
    expect(instance.platform?.repository).toBe(REPOSITORY);
    expect(instance.platform?.auth).toBeUndefined();
    expect(instance.sshKeys?.keys.map((entry) => entry.key)).toEqual([USER_KEY]);
    const recipient = /age1[0-9a-z]{58}/.exec(readFileSync(join(run.dir, ".sops.yaml"), "utf8"))?.[0];
    expect(readFileSync(run.deps.ageKeyFile, "utf8")).toContain(`# public key: ${recipient}`);
    const plain = parse(dockerSops.decrypt(readFileSync(join(run.dir, "secrets", "platform.sops.yaml"), "utf8"), readFileSync(run.deps.ageKeyFile))) as Record<string, unknown>;
    expect(Object.keys(plain).sort()).toEqual(["master_secret", "pocket_id"]);
    // The first-admin page was opened for this machine's address only, then closed again.
    const log = run.git(run.bare, ["log", "--format=%s", "main"]).stdout.trim().split("\n");
    expect(log).toEqual(["Close Pocket ID's first-admin page (bivy init, D15)", "Open Pocket ID's first-admin page to the owner's address (bivy init, D15)", "Bivouac instance, made by bivy init"]);
    expect(run.git(run.bare, ["show", "main~1:platform.yml"]).stdout).toContain("setupFrom: 198.51.100.7");

    // Hetzner: the order of the runbook, and the server's user-data holds the provisional key only.
    expect(run.provider.calls).toEqual(["projectProblems", "flatcarImage", "addresses", "firewall", "server"]);
    expect(run.provider.userData).toContain(Buffer.from(PROVISIONAL.privateKey).toString("base64"));
    expect(run.provider.userData).toContain("2001:db8:1::1/64");
    expect(readFileSync(run.deps.knownHosts, "utf8")).toContain(OWN_KEY.split(" ").slice(0, 2).join(" "));
    // The server: the age key arrived intact, no rebuild marker, no restore.
    expect(run.server.ageKey.toString()).toContain(`# public key: ${recipient}`);
    expect(run.server.commands.some((command) => command.includes("rebuild.json") || command.includes("restore-platform"))).toBe(false);
    expect(run.server.commands).toContain("docker restart bivouac-caddy >/dev/null");

    // DNS: the wildcard and a DMARC, written only after the typed consent.
    expect(run.written).toEqual([{ type: "A", name: "*.apps", value: "203.0.113.10", ttl: 3600 }, { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none", ttl: 3600 }]);
    expect(run.asked.filter((entry) => entry.startsWith("typed:"))).toEqual(["typed:apps.example.org", "typed:stored", "typed:apps.example.org", "typed:done"]);

    // The age key is shown once, and the state file never holds a secret.
    const secret = readFileSync(run.deps.ageKeyFile, "utf8").split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-")) as string;
    expect(run.logs.filter((line) => line.includes(secret))).toHaveLength(1);
    const kept = readdirSync(run.config).find((file) => file.startsWith("init.json.done-")) as string;
    const stateText = readFileSync(join(run.config, kept), "utf8");
    for (const value of [secret, String(plain.master_secret)]) expect(stateText).not.toContain(value);
    expect(existsSync(run.deps.stateFile)).toBe(false);
    expect(summary(state)).toContain("bivy configure backups, bivy configure alerts, bivy configure mail. Without backups, keep no real data on it");
  }, 120_000);

  it("creates nothing without the typed confirmation", async () => {
    const run = setup({ answers: {}, typed: ["apps.example.com"] });
    await expect(init(run.deps)).rejects.toThrow(/not confirmed: nothing was created/);
    expect(run.provider.calls).toEqual(["projectProblems"]);
    expect(existsSync(run.dir)).toBe(false);
  });

  it("never asks a script to agree: the cost confirmation needs a terminal", async () => {
    const run = setup({ answers: {}, typed: [], tty: false });
    await expect(init(run.deps)).rejects.toThrow(/needs a terminal/);
    expect(run.provider.calls).toEqual(["projectProblems"]);
  });

  it("stops on a project that already holds a platform, before asking anything billed", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    run.provider.problems = ["the project already has a server 'bivouac'"];
    await expect(init(run.deps)).rejects.toThrow(/cannot receive a new platform/);
    expect(run.asked).not.toContain("location");
  });

  it("refuses to run where another platform's host key is kept", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    mkdirSync(run.config, { recursive: true });
    writeFileSync(run.deps.knownHosts, "203.0.113.99 ssh-ed25519 AAAAother\n");
    await expect(init(run.deps)).rejects.toThrow(/already reaches a platform/);
    expect(run.asked).toEqual([]);
  });

  it("carries on after an interruption: no question asked twice, no second server", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    run.provider.failServerOnce = true;
    await expect(init(run.deps)).rejects.toThrow(/fetch failed/);
    const typedBefore = run.asked.filter((entry) => entry.startsWith("typed:")).length;
    run.asked.length = 0;
    // The second run has no scripted answers left: everything comes from the state file.
    run.deps.asker = scriptedAsker({ answers: {}, typed: ["apps.example.org", "done"] }, () => {}, run.asked);
    await init(run.deps);
    expect(typedBefore).toBe(2);
    expect(run.asked.filter((entry) => entry.startsWith("typed:"))).toEqual(["typed:apps.example.org", "typed:done"]);
    expect(run.provider.servers).toBe(1);
    // The resumed run found the server it had sent, and sent no other.
    expect(run.provider.userDatas[1]).toBeUndefined();
  }, 120_000);

  it("makes a fresh host key when Hetzner refused the server, and never creates one without its Ignition", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    run.provider.refuseServerOnce = true;
    let keys = 0;
    run.deps.newHostKey = () => ({ ...PROVISIONAL, publicKey: keys++ === 0 ? "ssh-ed25519 AAAAfirst bivouac-provisional" : PROVISIONAL.publicKey });
    await expect(init(run.deps)).rejects.toThrow(/unavailable/);
    run.deps.asker = scriptedAsker({ answers: {}, typed: ["apps.example.org", "done"] }, () => {}, []);
    await init(run.deps);
    expect(keys).toBe(2);
    expect(run.provider.userDatas.every((data) => data && data.includes("ignition"))).toBe(true);
  }, 120_000);

  it("builds what was confirmed: no other answer and no new offer counts afterwards", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    run.provider.refuseServerOnce = true;
    await expect(init(run.deps)).rejects.toThrow(/unavailable/);
    // The type is no longer offered anywhere: the confirmed one still goes ahead.
    run.provider.offers = async () => [];
    run.deps.asker = (recorded) => scriptedAsker({ answers: {}, typed: [] }, () => {}, [])({ ...recorded, domain: "other.example.org" });
    await expect(init(run.deps)).rejects.toThrow(/differ from the ones you confirmed: domain/);
    expect(run.provider.servers).toBe(0);
    run.deps.asker = scriptedAsker({ answers: {}, typed: ["apps.example.org", "done"] }, () => {}, []);
    const state = await init(run.deps);
    expect(state.answers?.serverType).toBe("cx23");
  }, 120_000);

  it("writes no DNS record over one that points elsewhere", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    run.deps.dns = { ...run.deps.dns, a: async (name) => (name.startsWith("auth.") ? ["192.0.2.1"] : []) };
    await expect(init(run.deps)).rejects.toThrow(/auth.apps.example.org already resolves to 192.0.2.1/);
    expect(run.written).toEqual([]);
  }, 120_000);

  it("stops when the first-admin page was used by someone else as well", async () => {
    const run = setup({ answers: {}, typed: typedAll() });
    const probe = run.deps.probeReal;
    run.deps.probeReal = (host, path) => {
      const answer = probe(host, path);
      if (path === "/setup" && answer.status === 200) run.server.users = 2;
      return answer;
    };
    await expect(init(run.deps)).rejects.toThrow(/Pocket ID has 2 accounts, not one/);
  }, 120_000);

  it("sets up the backups during init, shows the restic password once, and forgets the storage keys", async () => {
    const run = setup({
      answers: { backups: "now", "backup-provider": "b2", "backup-region": "eu-central-003", "backup-bucket": "my-backups" },
      typed: typedAll(),
      secrets: { "backup-key-id": "key-id", "backup-secret-key": "secret-key" },
    });
    await init(run.deps);
    const instance = loadInstance(run.dir);
    expect(instance.errors).toEqual([]);
    expect(instance.platform?.backup?.repository).toBe("s3:https://s3.eu-central-003.backblazeb2.com/my-backups");
    const plain = parse(dockerSops.decrypt(readFileSync(join(run.dir, "secrets", "platform.sops.yaml"), "utf8"), readFileSync(run.deps.ageKeyFile))) as { backup: Record<string, string> };
    expect(plain.backup.b2_key_id).toBe("key-id");
    expect(plain.backup.b2_application_key).toBe("secret-key");
    expect(run.logs.filter((line) => line.includes(plain.backup.restic_password as string))).toHaveLength(1);
    expect(existsSync(join(run.config, "backup-key-id"))).toBe(false);
    expect(existsSync(join(run.config, "backup-secret-key"))).toBe(false);
  }, 120_000);
});

describe("bivy init without Docker", () => {
  it("leaves no state behind when a typed confirmation is refused before anything", async () => {
    const run = setup({ answers: {}, typed: ["nope"] });
    await expect(init(run.deps)).rejects.toThrow(/not confirmed/);
    const state = JSON.parse(readFileSync(run.deps.stateFile, "utf8")) as InitState;
    // The answers are kept for the next run; nothing else happened.
    expect(state.recorded.zone).toBe("example.org");
    expect(state.done).toEqual([]);
  });
});
