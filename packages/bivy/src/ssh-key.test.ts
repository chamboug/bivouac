import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Choice } from "./ask.js";
import { SshKeyError, findSshKeys, rememberSshKey, sshIdentity, type SshKeyDependencies } from "./ssh-key.js";

let home: string;
let sshDir: string;
let memory: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bivy-ssh-key-"));
  sshDir = join(home, ".ssh");
  memory = join(home, ".config", "bivouac", "ssh-key");
  mkdirSync(sshDir);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function key(name: string, type = "ssh-ed25519", comment = `${name}@mac`): string {
  const path = join(sshDir, name);
  writeFileSync(path, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  writeFileSync(`${path}.pub`, `${type} AAAAC3NzaC1lZDI1NTE5AAAAIBmN1jW3cGmRk2c3Jx4m8b9e0Y3tB0v6pLqW2x1Yy7Zz ${comment}\n`);
  return path;
}

function deps(options: { tty?: boolean; pick?: (choices: Choice<string>[]) => string | undefined } = {}) {
  const notes: string[] = [];
  const asked: Choice<string>[][] = [];
  const value: SshKeyDependencies = {
    sshDir,
    memory,
    tty: options.tty ?? false,
    choose: async (_message, choices) => {
      asked.push(choices);
      return (options.pick ?? ((list) => list[0]?.value))(choices);
    },
    note: (message) => notes.push(message),
  };
  return { value, notes, asked };
}

describe("findSshKeys", () => {
  it("lists private keys with their .pub pair, and nothing else", () => {
    key("id_ed25519");
    key("bivouac-claude");
    key("old-rsa", "ssh-rsa");
    writeFileSync(join(sshDir, "known_hosts"), "");
    writeFileSync(join(sshDir, "config"), "");
    writeFileSync(join(sshDir, "lonely.pub"), "ssh-ed25519 AAAA x\n"); // no private part
    expect(findSshKeys(sshDir).map((entry) => entry.path)).toEqual([join(sshDir, "bivouac-claude"), join(sshDir, "id_ed25519")]);
  });

  it("is empty when there is no ~/.ssh", () => {
    expect(findSshKeys(join(home, "nowhere"))).toEqual([]);
  });
});

describe("rememberSshKey", () => {
  it("keeps an absolute path, whatever folder the key was named from", () => {
    rememberSshKey(memory, "keys/laptop");
    expect(readFileSync(memory, "utf8")).toBe(`${join(process.cwd(), "keys", "laptop")}\n`);
  });
});

describe("sshIdentity", () => {
  it("takes --ssh-key first, and refuses a missing one", async () => {
    const chosen = key("bivouac-claude");
    rememberSshKey(memory, key("id_ed25519"));
    expect(await sshIdentity(chosen, deps().value)).toBe(chosen);
    await expect(sshIdentity(join(sshDir, "nope"), deps().value)).rejects.toThrow(`No SSH key at ${join(sshDir, "nope")}: pass the right one with --ssh-key <file>.`);
    expect(readFileSync(memory, "utf8")).toBe(`${join(sshDir, "id_ed25519")}\n`);
  });

  it("uses the key chosen before, even without a terminal", async () => {
    key("id_ed25519");
    const chosen = key("work");
    rememberSshKey(memory, chosen);
    const run = deps({ tty: true });
    expect(await sshIdentity(undefined, run.value)).toBe(chosen);
    expect(run.asked).toEqual([]);
  });

  it("keeps ~/.ssh/id_ed25519 when it is the only key, saying nothing", async () => {
    const only = key("id_ed25519");
    const run = deps({ tty: true });
    expect(await sshIdentity(undefined, run.value)).toBe(only);
    expect(run.notes).toEqual([]);
  });

  it("uses the only key there is, and says so", async () => {
    const only = key("laptop");
    const run = deps();
    expect(await sshIdentity(undefined, run.value)).toBe(only);
    expect(run.notes).toEqual([`Using the SSH key ${only}, the only one in ${sshDir}.`]);
  });

  it("asks a person at a terminal to pick one of several, once, and remembers it", async () => {
    key("id_ed25519");
    const picked = key("bivouac-claude", "ssh-ed25519", "bivouac-claude");
    const first = deps({ tty: true, pick: (choices) => choices.find((entry) => entry.value === picked)?.value });
    expect(await sshIdentity(undefined, first.value)).toBe(picked);
    expect(first.asked).toEqual([[
      { value: picked, label: picked, hint: "bivouac-claude" },
      { value: join(sshDir, "id_ed25519"), label: join(sshDir, "id_ed25519"), hint: "id_ed25519@mac" },
    ]]);
    expect(readFileSync(memory, "utf8")).toBe(`${picked}\n`);
    expect(statSync(memory).mode & 0o777).toBe(0o600);
    expect(first.notes).toEqual([`Remembered in ${memory}; delete that file to choose again.`]);

    const second = deps({ tty: true });
    expect(await sshIdentity(undefined, second.value)).toBe(picked);
    expect(second.asked).toEqual([]);
  });

  it("stops, choosing nothing, when the list is cancelled", async () => {
    key("id_ed25519");
    key("work");
    await expect(sshIdentity(undefined, deps({ tty: true, pick: () => undefined }).value)).rejects.toThrow(SshKeyError);
    expect(() => readFileSync(memory)).toThrow();
  });

  it("without a terminal, keeps ~/.ssh/id_ed25519 among several, as before", async () => {
    const fallback = key("id_ed25519");
    key("work");
    const run = deps();
    expect(await sshIdentity(undefined, run.value)).toBe(fallback);
    expect(run.asked).toEqual([]);
  });

  it("without a terminal or id_ed25519, says what to pass and lists what it found", async () => {
    const a = key("alpha");
    const b = key("beta");
    await expect(sshIdentity(undefined, deps().value)).rejects.toThrow(
      `No SSH key at ${join(sshDir, "id_ed25519")}: pass the right one with --ssh-key <file>. Found: ${a}, ${b}.`,
    );
  });

  it("with no key at all, keeps today's error", async () => {
    await expect(sshIdentity(undefined, deps({ tty: true }).value)).rejects.toThrow(`No SSH key at ${join(sshDir, "id_ed25519")}: pass the right one with --ssh-key <file>.`);
  });

  it("asks again when the key chosen before is gone", async () => {
    key("id_ed25519");
    const other = key("work");
    rememberSshKey(memory, join(sshDir, "deleted"));
    const run = deps({ tty: true, pick: () => other });
    expect(await sshIdentity(undefined, run.value)).toBe(other);
    expect(run.notes[0]).toBe(`The SSH key remembered in ${memory}, ${join(sshDir, "deleted")}, is gone.`);
    expect(readFileSync(memory, "utf8")).toBe(`${other}\n`);
  });
});
