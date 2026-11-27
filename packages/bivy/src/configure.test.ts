import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstance } from "@bivouac/manifest";
import { parse, stringify } from "yaml";
import { keyFile, newAgeIdentity } from "./age.js";
import { AskError, type Asker, terminalAsker } from "./ask.js";
import { type ConfigureDependencies, addToPlatformYml, configurePart, configured } from "./configure.js";
import { TEMPLATE } from "./init.js";
import { SopsError, dockerSops } from "./sops.js";

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;
const USER_KEY = readFileSync(join(import.meta.dirname, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** An instance repo as bivy init leaves it, without the optional parts. */
function instance() {
  const home = mkdtempSync(join(tmpdir(), "bivy-configure-"));
  dirs.push(home);
  const root = join(home, "instance");
  cpSync(TEMPLATE, root, { recursive: true });
  const identity = newAgeIdentity();
  writeFileSync(join(root, ".sops.yaml"), `creation_rules:\n  - path_regex: ^secrets/.*\\.sops\\.yaml$\n    age: ${identity.recipient}\n`);
  writeFileSync(join(root, "ssh-keys.yml"), stringify({ keys: [{ name: "first-machine", key: USER_KEY }] }));
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "platform.sops.yaml"), dockerSops.encrypt(stringify({ master_secret: "m".repeat(64), pocket_id: { encryption_key: "e".repeat(44), static_api_key: "s".repeat(64) } }), identity.recipient));
  const bare = join(home, "github.git");
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, "-c", "user.name=Owner", "-c", "user.email=owner@example.org", ...args], { encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  for (const args of [["init", "--quiet", "-b", "main"], ["add", "-A"], ["commit", "--quiet", "-m", "init"], ["remote", "add", "origin", bare], ["push", "--quiet", "origin", "main"]]) git(args);
  const config = join(home, "config");
  mkdirSync(config);
  return { root, bare, git, config, key: Buffer.from(keyFile(identity, new Date())) };
}

function asker(answers: Record<string, string>, secrets: Record<string, string>): Asker {
  return {
    tty: true,
    select: async (flag) => answers[flag] as never,
    text: async (flag, _message, options = {}) => answers[flag] ?? options.initial ?? "",
    secret: async (spec) => {
      const value = secrets[spec.path.split("/").pop() ?? ""] ?? "";
      writeFileSync(spec.path, value, { mode: 0o600 });
      return value;
    },
    typed: async () => true,
    log: () => {},
  };
}

describeWithDocker("bivy configure", () => {
  it("adds the mail to a platform that has none, checked against the server, then commits and pushes", async () => {
    const repo = instance();
    let checked: unknown;
    const deps: ConfigureDependencies = {
      ask: asker({ "smtp-host": "smtp.example.org", "smtp-user": "contact@example.org" }, { "smtp-password": "mail-password" }),
      config: (name) => join(repo.config, name),
      fetch: globalThis.fetch,
      checkSmtp: async (account) => {
        checked = account;
      },
      now: Date.now,
      sops: dockerSops,
      identity: () => repo.key,
      checkout: () => [],
      git: repo.git,
      showOnce: async () => {
        throw new Error("nothing to show for the mail");
      },
    };
    expect(configured(repo.root, "mail")).toBe(false);
    expect(await configurePart(deps, repo.root, "mail")).toContain("smtp.example.org");
    expect(checked).toEqual({ host: "smtp.example.org", port: 587, user: "contact@example.org", password: "mail-password" });
    expect(loadInstance(repo.root).platform?.mail).toEqual({ host: "smtp.example.org", port: 587, from: "contact@example.org", user: "contact@example.org" });
    const plain = parse(dockerSops.decrypt(readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8"), repo.key)) as Record<string, unknown>;
    expect(plain.mail).toEqual({ password: "mail-password" });
    expect(plain.master_secret).toBe("m".repeat(64));
    expect(spawnSync("git", ["-C", repo.bare, "log", "--format=%s", "main"], { encoding: "utf8" }).stdout.trim().split("\n")[0]).toBe("bivy configure mail");
    expect(existsSync(join(repo.config, "smtp-password"))).toBe(false);
    expect(readFileSync(join(repo.root, "platform.yml"), "utf8")).toContain("# Base domain of the platform");

    // Already there: bivy never changes it.
    await expect(configurePart(deps, repo.root, "mail")).rejects.toThrow(/already set up/);
  }, 120_000);

  it("pushes nothing from a checkout that is not exactly origin/main", async () => {
    const repo = instance();
    const deps = {
      ask: asker({}, {}), config: (name: string) => join(repo.config, name), fetch: globalThis.fetch, checkSmtp: async () => {}, now: Date.now,
      sops: dockerSops, identity: () => repo.key, checkout: () => ["uncommitted changes"], git: repo.git, showOnce: async () => {},
    };
    await expect(configurePart(deps, repo.root, "alerts")).rejects.toThrow(/cannot be pushed as is: uncommitted changes/);
  }, 120_000);

  it("says plainly what stops it, before any secret is shown, and writes nothing", async () => {
    const repo = instance();
    const secretsBefore = readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8");
    let shown = false;
    const base = {
      config: (name: string) => join(repo.config, name), checkSmtp: async () => {}, now: Date.now,
      sops: dockerSops, identity: () => repo.key, checkout: () => [], git: repo.git,
      showOnce: async () => {
        shown = true;
      },
    };
    const refused = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(configurePart({ ...base, ask: asker({}, { "pushover-token": "t", "pushover-user": "u", "healthchecks-api-key": "k" }), fetch: refused }, repo.root, "alerts"))
      .rejects.toThrow(/healthchecks.io GET \/channels\/: the API key is wrong or read-only .*\. Fix it, or delete .*healthchecks-api-key to type the key again/);
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(configurePart({ ...base, ask: asker({}, {}), fetch: offline }, repo.root, "alerts")).rejects.toThrow(/could not reach healthchecks.io: fetch failed/);

    const mail = asker({ "smtp-host": "smtp.example.org", "smtp-user": "contact@example.org" }, { "smtp-password": "p" });
    const noKey = () => readFileSync(join(repo.config, "keys.txt"));
    await expect(configurePart({ ...base, ask: mail, fetch: globalThis.fetch, identity: noKey }, repo.root, "mail")).rejects.toThrow(/no age key at .*keys\.txt: the secrets cannot be decrypted/);

    // Docker down: found before the restic password is shown, which would otherwise be kept for nothing.
    const emptyBucket = (async () => new Response("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>")) as typeof fetch;
    const noDocker = { ...dockerSops, decrypt: () => {
      throw new SopsError("could not run Docker (is it installed and started?): spawn docker ENOENT");
    } };
    const backups = asker({ "backup-provider": "b2", "backup-region": "eu-central-003", "backup-bucket": "a-bucket" }, { "backup-key-id": "id", "backup-secret-key": "secret" });
    await expect(configurePart({ ...base, ask: backups, fetch: emptyBucket, sops: noDocker }, repo.root, "backups")).rejects.toThrow(/could not run Docker .*\. Nothing was written/);
    expect(shown).toBe(false);
    expect(readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8")).toBe(secretsBefore);
  }, 120_000);
});

describe("platform.yml", () => {
  it("gets new keys with its comments kept, never a key twice", () => {
    const text = "# comment\ndomain: apps.example.org # here\n";
    expect(addToPlatformYml(text, { backup: { repository: "s3:https://s3.example.com/b" } })).toBe("# comment\ndomain: apps.example.org # here\nbackup:\n  repository: s3:https://s3.example.com/b\n");
    expect(() => addToPlatformYml(text, { domain: "x" })).toThrow(/already has 'domain'/);
  });

  it("asks nothing it cannot ask: a script gets the flag to pass, and never a consent", async () => {
    const script = terminalAsker({ dns: "manual" }, false, () => {});
    expect(await script.select("dns", "Who serves the DNS?", [{ value: "ovh", label: "" }, { value: "manual", label: "" }])).toBe("manual");
    await expect(script.select("location", "Where?", [{ value: "fsn1", label: "" }])).rejects.toThrow(/Pass --location <fsn1>/);
    await expect(terminalAsker({ dns: "other" }, false).select("dns", "?", [{ value: "ovh", label: "" }])).rejects.toThrow(/--dns must be one of: ovh/);
    await expect(script.typed("Type the platform domain", "apps.example.org")).rejects.toThrow(AskError);
  });
});
