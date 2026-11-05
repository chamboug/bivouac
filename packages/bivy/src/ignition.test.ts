import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildButane, compileButane } from "./ignition.js";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "..", "..", "..", "template");
const key = readFileSync(join(here, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();
const sshKeys = { keys: [{ name: "fixture", key }] };

// Butane runs in Docker. In CI Docker is always there, so never skip there.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

describe("butane", () => {
  it("appends the keys without rewriting the base file", () => {
    const butane = buildButane(template, sshKeys);
    expect(butane.startsWith(readFileSync(join(template, "butane", "server.bu"), "utf8"))).toBe(true);
    expect(butane).toContain(key);
  });
});

describeWithDocker("ignition", () => {
  it("compiles the template with the exact file modes and the keys", () => {
    const ignition = JSON.parse(compileButane(buildButane(template, sshKeys)));
    const modes = Object.fromEntries(
      [...ignition.storage.files, ...ignition.storage.directories].map((entry: { path: string; mode: number }) => [
        entry.path,
        entry.mode.toString(8),
      ]),
    );
    // Regression: `0600` must stay octal (YAML 1.1), not become decimal 600.
    expect(modes).toEqual({
      "/etc/ssh/sshd_config.d/10-bivouac.conf": "600",
      "/etc/flatcar/update.conf": "420",
      "/etc/bivouac": "700",
    });
    expect(ignition.passwd.users).toEqual([{ name: "core", sshAuthorizedKeys: [key] }]);
    expect(ignition.systemd.units.map((unit: { name: string }) => unit.name)).toEqual(["bivouac-reconciler.service"]);
  });
});
