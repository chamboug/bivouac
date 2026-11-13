import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { HOST_KEY_PATH, keyPart, newHostKey, secretsIn, withHostKey } from "./hostkey.js";
import { compileButane } from "./ignition.js";

const PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
const file = (path: string, source: string, compression?: string) => ({ path, contents: { source, ...(compression ? { compression } : {}) } });
const config = (...files: unknown[]) => JSON.stringify({ ignition: { version: "3.4.0" }, storage: { files } });
const decode = (source: string) => Buffer.from(source.replace(/^data:;base64,/, ""), "base64").toString("utf8");

describe("provisional host key (D91)", () => {
  it("is a fresh ED25519 pair each time, made by ssh-keygen", () => {
    const [a, b] = [newHostKey(), newHostKey()];
    expect(a.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(keyPart(a.publicKey)).toMatch(/^ssh-ed25519 AAAA/);
    expect(a.publicKey).not.toBe(b.publicKey);
    // The private key matches the public one.
    const dir = mkdtempSync(join(tmpdir(), "bivy-hostkey-test-"));
    try {
      writeFileSync(join(dir, "key"), a.privateKey, { mode: 0o600 });
      const derived = spawnSync("ssh-keygen", ["-y", "-f", join(dir, "key")], { encoding: "utf8" });
      expect(keyPart(derived.stdout)).toBe(keyPart(a.publicKey));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is added to the compiled Ignition config as the only secret, private file mode 600", () => {
    const key = { privateKey: PRIVATE, publicKey: "ssh-ed25519 AAAAx provisional" };
    const result = JSON.parse(withHostKey(config(file("/etc/motd", "data:,hello")), key)) as { storage: { files: { path: string; mode: number; overwrite: boolean; contents: { source: string } }[] } };
    const [motd, privateFile, publicFile] = result.storage.files;
    expect(motd?.path).toBe("/etc/motd");
    expect(privateFile).toMatchObject({ path: HOST_KEY_PATH, mode: 0o600, overwrite: true });
    expect(decode(privateFile?.contents.source ?? "")).toBe(PRIVATE);
    expect(publicFile).toMatchObject({ path: `${HOST_KEY_PATH}.pub`, mode: 0o644 });
    expect(decode(publicFile?.contents.source ?? "")).toBe("ssh-ed25519 AAAAx provisional\n");
    expect(secretsIn(JSON.stringify(result))).toEqual([HOST_KEY_PATH]);
  });

  it("refuses a config that already holds a secret or writes the host key itself", () => {
    const key = { privateKey: PRIVATE, publicKey: "ssh-ed25519 AAAAx p" };
    expect(() => withHostKey(config(file("/etc/x", `data:,${encodeURIComponent("AGE-SECRET-KEY-1ABC")}`)), key)).toThrow(/already holds a private key/);
    expect(() => withHostKey(config(file(HOST_KEY_PATH, "data:,nothing")), key)).toThrow(/must not write/);
    expect(() => withHostKey(config(), { ...key, privateKey: "x".repeat(40_000) })).toThrow();
  });
});

describe("private keys in an Ignition config, read after decoding", () => {
  it("are found percent-encoded, in base64 and gzip-compressed", () => {
    expect(secretsIn(config(file("/a", `data:,${encodeURIComponent(PRIVATE)}`)))).toEqual(["/a"]);
    expect(secretsIn(config(file("/b", `data:;base64,${Buffer.from(PRIVATE).toString("base64")}`)))).toEqual(["/b"]);
    expect(secretsIn(config(file("/c", `data:;base64,${gzipSync(PRIVATE).toString("base64")}`, "gzip")))).toEqual(["/c"]);
    expect(secretsIn(JSON.stringify({ systemd: { units: [{ name: "x.service", contents: "AGE-SECRET-KEY-1X" }] } }))).toEqual(["(outside the contents)"]);
    expect(secretsIn(JSON.stringify({ storage: { files: [{ path: "/e", append: [{ source: `data:;base64,${gzipSync(PRIVATE).toString("base64")}`, compression: "gzip" }] }] } }))).toEqual(["/e"]);
    expect(secretsIn(JSON.stringify({ ignition: { config: { merge: [{ source: `data:,${encodeURIComponent(PRIVATE)}` }] } } }))).toEqual(["/ignition/config/merge/0"]);
    expect(secretsIn(config(file("/f", `data:,${encodeURIComponent(`token=github_pat_${"A".repeat(30)}`)}`)))).toEqual(["/f"]);
    expect(secretsIn(config(file("/g", `data:,${encodeURIComponent(`ghp_${"a".repeat(36)}`)}`)))).toEqual(["/g"]);
    expect(secretsIn(config(file("/d", "data:,hello")))).toEqual([]);
  });

  it("refuse contents that cannot be checked", () => {
    expect(() => secretsIn(config(file("/a", "https://example.com/key")))).toThrow(/only inline contents/);
    expect(() => secretsIn(JSON.stringify({ ignition: { config: { replace: { source: "https://example.com/config.ign" } } } }))).toThrow(/only inline contents/);
    expect(() => secretsIn(config(file("/a", "data:,x", "xz")))).toThrow(/unknown compression/);
    expect(secretsIn(config(file("/h", `data:;BASE64,${Buffer.from(PRIVATE).toString("base64")}`)))).toEqual(["/h"]);
    expect(() => secretsIn(config(file("/i", "data:;base64,AAAA!!AAAA")))).toThrow(/cannot be checked/);
  });
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
(hasDocker || process.env.CI ? describe : describe.skip)("Butane", () => {
  it("cannot slip a private key into the user-data, even compressed", () => {
    const lines = PRIVATE.trim().split("\n").concat(Array.from({ length: 6 }, () => "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ"));
    const butane = `variant: flatcar\nversion: 1.1.0\nstorage:\n  files:\n    - path: /etc/x\n      contents:\n        inline: |\n${lines.map((line) => `          ${line}`).join("\n")}\n`;
    expect(() => compileButane(butane)).toThrow(/writes a private key \(\/etc\/x\)/);
    }, 120_000); // the first run may pull the Butane image
});
