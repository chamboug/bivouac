import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { SSH_KEYS_FILE, SSH_KEYS_GRACE_MS, SSH_KEYS_STATUS_FILE, sshKeysProblem, writeSshKeys } from "./ssh-keys.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAPvT/AdpOmvA2QaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAA a@mac";
const B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKGXlWe4/N6m/sFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbBB b@mac";

describe("SSH keys", () => {
  it("writes one key per line, readable by root only, and only when the list changes", () => {
    const state = mkdtempSync(join(tmpdir(), "bivouac-ssh-"));
    roots.push(state);
    const path = join(state, SSH_KEYS_FILE);

    expect(writeSshKeys(state, { keys: [{ name: "a", key: `${A}\n` }, { name: "b", key: B }] })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${A}\n${B}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(state, "ssh")).mode & 0o777).toBe(0o700);

    expect(writeSshKeys(state, { keys: [{ name: "a", key: A }, { name: "b", key: B }] })).toBe(false);
    expect(writeSshKeys(state, { keys: [{ name: "b", key: B }] })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${B}\n`);
    // Nothing left behind next to the list, which the host watches.
    expect(readdirSync(join(state, "ssh"))).toEqual(["authorized_keys"]);
  });

  it("reports a list the host refused, has not applied, or never looked at, after a grace period", () => {
    const state = mkdtempSync(join(tmpdir(), "bivouac-ssh-"));
    roots.push(state);
    writeSshKeys(state, { keys: [{ name: "a", key: A }] });
    const later = Date.now() + SSH_KEYS_GRACE_MS + 1000;
    // No status directory at all: no host script (the local platform).
    expect(sshKeysProblem(state, later)).toBeUndefined();

    mkdirSync(join(state, "ssh-status"));
    expect(sshKeysProblem(state)).toBeUndefined();
    expect(sshKeysProblem(state, later)).toMatch(/^the host has never applied the SSH keys/);

    const hash = createHash("sha256").update(`${A}\n`).digest("hex");
    const status = (content: string) => writeFileSync(join(state, SSH_KEYS_STATUS_FILE), `${content}\n`);
    status(`applied ${hash}`);
    expect(sshKeysProblem(state, later)).toBeUndefined();
    status(`refused ${hash}: update-ssh-keys did not accept the list`);
    expect(sshKeysProblem(state)).toBeUndefined();
    expect(sshKeysProblem(state, later)).toBe(
      "the host refused the SSH keys of ssh-keys.yml (update-ssh-keys did not accept the list): the previous keys stay in place",
    );
    status(`applied ${"0".repeat(64)}`);
    expect(sshKeysProblem(state, later)).toMatch(/^the host has not applied the current SSH keys/);
  });
});
