import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bech32, keyFile, newAgeIdentity } from "./age.js";
import { instanceIdentity } from "./rebuild.js";
import { dockerSops } from "./sops.js";

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe("age key", () => {
  it("writes Bech32 as BIP 173's test vectors do", () => {
    expect(bech32("a", new Uint8Array())).toBe("a12uel5l");
  });

  it("makes an identity in age's format, which instanceIdentity reads back", () => {
    const identity = newAgeIdentity();
    expect(identity.recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(identity.secret).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    const file = keyFile(identity, new Date("2026-11-19T00:00:00Z"));
    expect(instanceIdentity(file, `age: ${identity.recipient}`).toString()).toBe(`# public key: ${identity.recipient}\n${identity.secret}\n`);
  });

  it.runIf(hasDocker || process.env.CI)("is one sops accepts: encrypted for the recipient, opened with the secret", () => {
    const identity = newAgeIdentity();
    const encrypted = dockerSops.encrypt("value: kept\n", identity.recipient);
    expect(encrypted).not.toContain("kept");
    expect(dockerSops.decrypt(encrypted, Buffer.from(`${identity.secret}\n`))).toBe("value: kept\n");
    expect(() => dockerSops.decrypt(encrypted, Buffer.from(`${newAgeIdentity().secret}\n`))).toThrow(/could not decrypt/);
  }, 60_000);
});
