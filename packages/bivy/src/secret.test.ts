import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { keyFile, newAgeIdentity } from "./age.js";
import type { AskSecret } from "./credentials.js";
import { instanceIdentity } from "./rebuild.js";
import { REFUSED, SETTABLE, SecretError, readValueFile, setSecret, valueProblem } from "./secret.js";
import { type Sops, dockerSops } from "./sops.js";

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

const PLAIN = {
  master_secret: "m".repeat(64),
  pocket_id: { encryption_key: "e".repeat(44), static_api_key: "s".repeat(64) },
  mail: { password: "old-mail-password" },
  backup: { restic_password: "restic-password", b2_key_id: "0031234567890", b2_application_key: "K003oldapplicationkey" },
  alerts: {
    pushover_token: "pushover-token",
    pushover_user: "pushover-user",
    healthchecks: { heartbeat: "https://hc-ping.com/1", backup: "https://hc-ping.com/2", restore: "https://hc-ping.com/3" },
  },
  // A value YAML would read as a number if it lost its quotes.
  ghcr: { username: "owner", token: "0123" },
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of an instance repo's secrets, made for the test: never the real one. */
function instance(sops: Sops = dockerSops) {
  const home = mkdtempSync(join(tmpdir(), "bivy-secret-"));
  dirs.push(home);
  const root = join(home, "instance");
  mkdirSync(join(root, "secrets"), { recursive: true });
  const identity = newAgeIdentity();
  const sopsConfig = `creation_rules:\n  - path_regex: ^secrets/.*\\.sops\\.yaml$\n    age: ${identity.recipient}\n`;
  writeFileSync(join(root, ".sops.yaml"), sopsConfig);
  writeFileSync(join(root, "secrets", "platform.sops.yaml"), sops.encrypt(stringify(PLAIN), identity.recipient));
  const key = instanceIdentity(keyFile(identity, new Date()), sopsConfig);
  // As the reconciler reads it: decrypted to JSON.
  const decrypt = () => JSON.parse(sops.decrypt(readFileSync(join(root, "secrets", "platform.sops.yaml"), "utf8"), key, "json")) as typeof PLAIN;
  const outside = join(home, "outside");
  mkdirSync(outside, { mode: 0o700 });
  return { home, root, key, decrypt, outside };
}

/** Answers hidden-input questions in order. */
const typing = (...answers: (string | undefined)[]): AskSecret => async () => answers.shift();

/** Everything written to the screen or a log during a run, to look for the value in. */
function captureOutput() {
  const seen: string[] = [];
  const keep = (chunk: unknown) => {
    seen.push(String(chunk));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(keep),
    vi.spyOn(process.stderr, "write").mockImplementation(keep),
    ...(["log", "error", "warn", "info", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation((...args) => void seen.push(args.map(String).join(" ")))),
  ];
  return { seen, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** Every file under a folder, its content as text. */
function contents(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
}

describe("which values bivy secret set changes", () => {
  it("refuses the master secret, Pocket ID's encryption key and the restic password, with the reason, before reading anything", async () => {
    for (const path of Object.keys(REFUSED)) {
      await expect(setSecret({ sops: dockerSops, identity: () => Buffer.from(""), ask: typing(), checkout: () => [], log: () => {} }, "/nowhere", path)).rejects.toThrow(/never changed by bivy/);
    }
    expect(REFUSED.master_secret).toContain("D14");
  });

  it("refuses a path it does not know, and lists the ones it does", async () => {
    await expect(setSecret({ sops: dockerSops, identity: () => Buffer.from(""), ask: typing(), checkout: () => [], log: () => {} }, "/nowhere", "sops.mac")).rejects.toThrow(/not a value bivy can change.*mail\.password/);
    expect(Object.keys(SETTABLE).every((path) => !(path in REFUSED))).toBe(true);
  });

  it("takes no inherited name for a path", async () => {
    for (const path of ["__proto__", "constructor", "toString"]) {
      await expect(setSecret({ sops: dockerSops, identity: () => Buffer.from(""), ask: typing(), checkout: () => [], log: () => {} }, "/nowhere", path)).rejects.toThrow(new RegExp(`^'${path}' is not a value bivy can change`));
    }
  });

  it("refuses to ask when nobody is at a terminal and no file is given", async () => {
    await expect(setSecret({ sops: dockerSops, identity: () => Buffer.from(""), ask: undefined, checkout: () => [], log: () => {} }, "/nowhere", "mail.password")).rejects.toThrow(/person at a terminal.*--from-file/);
  });

  it("says why a value cannot be used without ever quoting it", () => {
    const value = "not a url but secret";
    const problem = valueProblem("alerts.healthchecks.backup", value);
    expect(problem).toMatch(/https/);
    expect(problem).not.toContain(value);
    expect(valueProblem("mail.password", "two\nlines")).toMatch(/line break/);
    expect(valueProblem("mail.password", " padded")).toMatch(/space/);
    expect(valueProblem("mail.password", "")).toMatch(/empty/);
    expect(valueProblem("pocket_id.static_api_key", "short")).toMatch(/16/);
    expect(valueProblem("mail.password", "inner spaces are fine")).toBeUndefined();
  });
});

describe("the file a value is read from", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bivy-secret-file-"));
    dirs.push(home);
    mkdirSync(join(home, "instance"));
  });

  it("is read without its final line break when it is mode 600", () => {
    const file = join(home, "value");
    writeFileSync(file, "the-value\n", { mode: 0o600 });
    expect(readValueFile(file, join(home, "instance"))).toBe("the-value");
  });

  it("is refused when others can read it, when it is a link, or inside the instance repo", () => {
    const open = join(home, "open");
    writeFileSync(open, "the-value", { mode: 0o644 });
    chmodSync(open, 0o644);
    expect(() => readValueFile(open, join(home, "instance"))).toThrow(/mode 600/);
    const target = join(home, "target");
    writeFileSync(target, "the-value", { mode: 0o600 });
    symlinkSync(target, join(home, "link"));
    expect(() => readValueFile(join(home, "link"), join(home, "instance"))).toThrow(/not a link/);
    const inside = join(home, "instance", "value");
    writeFileSync(inside, "the-value", { mode: 0o600 });
    expect(() => readValueFile(inside, join(home, "instance"))).toThrow(/inside the instance repo/);
    expect(() => readValueFile(join(home, "missing"), join(home, "instance"))).toThrow(/does not exist/);
  });

  it("is refused inside the instance repo whatever the case of its path, and with a second name", () => {
    const inside = join(home, "instance", "value");
    writeFileSync(inside, "the-value", { mode: 0o600 });
    // macOS's disks ignore case: /Instance and /instance are one folder there.
    const caseless = existsSync(join(home, "INSTANCE"));
    if (caseless) expect(() => readValueFile(join(home, "INSTANCE", "value"), join(home, "instance"))).toThrow(/inside the instance repo/);
    const file = join(home, "value");
    writeFileSync(file, "the-value", { mode: 0o600 });
    linkSync(file, join(home, "second-name"));
    expect(() => readValueFile(file, join(home, "instance"))).toThrow(/hard links/);
  });
});

describeWithDocker("bivy secret set", () => {
  it("changes one value, typed twice, keeps every other one, and never shows it anywhere", async () => {
    const repo = instance();
    const value = `New-Secret-${randomBytes(12).toString("hex")}`;
    const before = readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8");
    const logged: string[] = [];
    const output = captureOutput();
    let result;
    try {
      result = await setSecret({ sops: dockerSops, identity: () => repo.key, ask: typing(value, value), checkout: () => [], log: (line) => logged.push(line) }, repo.root, "mail.password");
    } finally {
      output.restore();
    }
    expect(result).toEqual({ changed: true, effect: expect.stringMatching(/Pocket ID restarts.*D68/) });
    expect(repo.decrypt()).toEqual({ ...PLAIN, mail: { password: value } });
    // The keys keep their order, so the decrypted file reads as before.
    expect(JSON.stringify(Object.keys(repo.decrypt()))).toBe(JSON.stringify(Object.keys(PLAIN)));
    const after = readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8");
    expect(after).not.toBe(before);
    // Nothing on the screen, in a log, or in any file left behind holds it.
    for (const text of [...output.seen, ...logged, ...contents(repo.home)]) expect(text).not.toContain(value);
    expect(readdirSync(join(repo.root, "secrets"))).toEqual(["platform.sops.yaml"]);
    // The file keeps its mode, and stays a SOPS file for the same recipient.
    expect(statSync(join(repo.root, "secrets", "platform.sops.yaml")).isFile()).toBe(true);
  }, 120_000);

  it("reads the value from a file of mode 600, then deletes that file", async () => {
    const repo = instance();
    const value = `https://hc-ping.com/${randomBytes(8).toString("hex")}`;
    const file = join(repo.outside, "value");
    writeFileSync(file, `${value}\n`, { mode: 0o600 });
    const output = captureOutput();
    try {
      await setSecret({ sops: dockerSops, identity: () => repo.key, ask: undefined, checkout: () => [], log: () => {} }, repo.root, "alerts.healthchecks.backup", file);
    } finally {
      output.restore();
    }
    expect(existsSync(file)).toBe(false);
    expect(repo.decrypt().alerts).toEqual({ ...PLAIN.alerts, healthchecks: { ...PLAIN.alerts.healthchecks, backup: value } });
    for (const text of [...output.seen, ...contents(repo.home)]) expect(text).not.toContain(value);
  }, 120_000);

  it("keeps a value that looks like a number as text", async () => {
    const repo = instance();
    await setSecret({ sops: dockerSops, identity: () => repo.key, ask: typing("0456", "0456"), checkout: () => [], log: () => {} }, repo.root, "ghcr.token");
    expect(repo.decrypt()).toEqual({ ...PLAIN, ghcr: { username: "owner", token: "0456" } });
  }, 120_000);

  it("keeps values YAML readers disagree on as text, written in quotes", async () => {
    const repo = instance();
    for (const value of ["1_000", "<<", "0b101", "yes", "~", "*anchor", "- item", "a: b", "#hash", "'quoted'"]) {
      await setSecret({ sops: dockerSops, identity: () => repo.key, ask: typing(value, value), checkout: () => [], log: () => {} }, repo.root, "alerts.pushover_user");
      expect(repo.decrypt()).toEqual({ ...PLAIN, alerts: { ...PLAIN.alerts, pushover_user: value } });
    }
  }, 300_000);

  it("refuses a checkout that is behind main or holds other changes, before decrypting", async () => {
    const repo = instance();
    let decrypted = false;
    const sops: Sops = { encrypt: dockerSops.encrypt, decrypt: (...args) => ((decrypted = true), dockerSops.decrypt(...args)) };
    await expect(setSecret({ sops, identity: () => repo.key, ask: typing("a-value", "a-value"), checkout: () => ["instance is not exactly origin/main: pull first"], log: () => {} }, repo.root, "mail.password")).rejects.toThrow(/should not be changed now.*pull first/);
    expect(decrypted).toBe(false);
  }, 120_000);

  it("changes nothing when the value is the same, and still deletes the file", async () => {
    const repo = instance();
    const before = readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8");
    const file = join(repo.outside, "value");
    writeFileSync(file, PLAIN.backup.b2_key_id, { mode: 0o600 });
    const result = await setSecret({ sops: dockerSops, identity: () => repo.key, ask: undefined, checkout: () => [], log: () => {} }, repo.root, "backup.b2_key_id", file);
    expect(result.changed).toBe(false);
    expect(readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8")).toBe(before);
    expect(existsSync(file)).toBe(false);
  }, 120_000);

  it("changes nothing, and keeps the file, when the two typed values differ or the value is refused", async () => {
    const repo = instance();
    const before = readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8");
    const deps = { sops: dockerSops, identity: () => repo.key, checkout: () => [], log: () => {} };
    const typo = `Typed-${randomBytes(8).toString("hex")}`;
    const failure = await setSecret({ ...deps, ask: typing(typo, `${typo}x`) }, repo.root, "mail.password").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(SecretError);
    expect((failure as Error).message).toMatch(/differ/);
    expect((failure as Error).message).not.toContain(typo);
    const file = join(repo.outside, "value");
    const notUrl = `http://plain-${randomBytes(8).toString("hex")}`;
    writeFileSync(file, notUrl, { mode: 0o600 });
    const refused = await setSecret({ ...deps, ask: undefined }, repo.root, "alerts.healthchecks.heartbeat", file).catch((error: Error) => error);
    expect((refused as Error).message).toMatch(/https/);
    expect((refused as Error).message).not.toContain(notUrl);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8")).toBe(before);
  }, 120_000);

  it("stops before asking when the age key cannot open the file", async () => {
    const repo = instance();
    let asked = false;
    const other = Buffer.from(`${newAgeIdentity().secret}\n`);
    await expect(setSecret({ sops: dockerSops, identity: () => other, ask: async () => ((asked = true), "x"), checkout: () => [], log: () => {} }, repo.root, "mail.password")).rejects.toThrow(/could not decrypt/);
    expect(asked).toBe(false);
  }, 120_000);

  it("refuses a value not set yet, pointing to bivy configure", async () => {
    const repo = instance();
    const file = join(repo.root, "secrets", "platform.sops.yaml");
    const { ghcr: _ghcr, ...withoutGhcr } = PLAIN;
    writeFileSync(file, dockerSops.encrypt(stringify(withoutGhcr), (/age1[0-9a-z]{58}/.exec(readFileSync(join(repo.root, ".sops.yaml"), "utf8")) as RegExpExecArray)[0]));
    await expect(setSecret({ sops: dockerSops, identity: () => repo.key, ask: typing("a", "a"), checkout: () => [], log: () => {} }, repo.root, "ghcr.token")).rejects.toThrow(/no ghcr\.token yet.*bivy configure/);
  }, 120_000);

  it("refuses when .sops.yaml names another key than the file's", async () => {
    const repo = instance();
    writeFileSync(join(repo.root, ".sops.yaml"), `creation_rules:\n  - path_regex: ^secrets/.*\\.sops\\.yaml$\n    age: ${newAgeIdentity().recipient}\n`);
    await expect(setSecret({ sops: dockerSops, identity: () => repo.key, ask: typing("a", "a"), checkout: () => [], log: () => {} }, repo.root, "mail.password")).rejects.toThrow(/sort that out first/);
  }, 120_000);

  it("puts the previous file back when what was written does not decrypt to the expected values", async () => {
    const repo = instance();
    const before = readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8");
    let decrypts = 0;
    // A sops that loses another value on the way: the check after writing must catch it.
    const lossy: Sops = {
      encrypt: dockerSops.encrypt,
      decrypt: (encrypted, identity, output) => {
        const plain = dockerSops.decrypt(encrypted, identity, output);
        decrypts += 1;
        return decrypts === 1 ? plain : plain.replace(PLAIN.alerts.pushover_user, "changed-on-the-way");
      },
    };
    await expect(setSecret({ sops: lossy, identity: () => repo.key, ask: typing("new-password", "new-password"), checkout: () => [], log: () => {} }, repo.root, "mail.password")).rejects.toThrow(/previous file was put back/);
    expect(readFileSync(join(repo.root, "secrets", "platform.sops.yaml"), "utf8")).toBe(before);
    expect(readdirSync(join(repo.root, "secrets"))).toEqual(["platform.sops.yaml"]);
  }, 120_000);
});
