import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialError, credential, readCredential } from "./credentials.js";

const folder = () => join(mkdtempSync(join(tmpdir(), "bivy-credentials-")), "bivouac");
const quiet = () => {};

describe("credential", () => {
  it("asks once, keeps the value in a file only its owner can read, then reads it there", async () => {
    const path = join(folder(), "hetzner-token");
    let asked = 0;
    const ask = async () => {
      asked++;
      return "  secret-value\n";
    };
    expect(await credential({ path, what: "the Hetzner token" }, ask, quiet)).toBe("secret-value");
    expect(readFileSync(path, "utf8")).toBe("secret-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(await credential({ path, what: "the Hetzner token" }, ask, quiet)).toBe("secret-value");
    expect(asked).toBe(1);
  });

  it("never asks a script, and says what to do", async () => {
    const path = join(folder(), "token");
    await expect(credential({ path, what: "the token" }, undefined, quiet)).rejects.toThrow(/nobody is at a terminal/);
  });

  it("writes nothing when the person cancels or types something unusable", async () => {
    const path = join(folder(), "token");
    await expect(credential({ path, what: "the token" }, async () => undefined, quiet)).rejects.toThrow(CredentialError);
    await expect(credential({ path, what: "the token" }, async () => "two words", quiet)).rejects.toThrow(/spaces/);
    expect(() => readCredential({ path, what: "the token" })).toThrow(/missing/);
  });

  it("shows where to get the value, and never the value itself", async () => {
    const path = join(folder(), "token");
    const lines: string[] = [];
    await credential({ path, what: "the token", hint: "Create it at https://example.org/tokens" }, async () => "s3cr3t", (line) => lines.push(line));
    expect(lines[0]).toBe("Create it at https://example.org/tokens");
    expect(lines.join("\n")).not.toContain("s3cr3t");
  });
});

describe("readCredential", () => {
  it("refuses a file others can read, and an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bivy-credentials-"));
    const open = join(dir, "open");
    writeFileSync(open, "x");
    chmodSync(open, 0o644);
    expect(() => readCredential({ path: open, what: "x" })).toThrow(/chmod 600/);
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n", { mode: 0o600 });
    expect(() => readCredential({ path: empty, what: "x" })).toThrow(/empty/);
  });
});
