import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IgnitionError, MAX_IGNITION_BYTES, buildButane, compileButane, firstAddress } from "./ignition.js";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "..", "..", "..", "template");
const key = readFileSync(join(here, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();
const sshKeys = { keys: [{ name: "fixture", key }] };
const platform = {
  domain: "apps.example.com",
  repository: "git@github.com:example/bivouac-platform.git",
  reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-abc1234" },
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A copy of the template whose Butane file is replaced. */
function withButane(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "bivouac-butane-"));
  roots.push(root);
  cpSync(template, root, { recursive: true });
  writeFileSync(join(root, "butane", "server.bu"), content);
  return root;
}

// Butane runs in Docker. In CI Docker is always there, so never skip there.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

describe("butane", () => {
  it("fills the values of platform.yml and appends the keys, without rewriting the rest", () => {
    const base = readFileSync(join(template, "butane", "server.bu"), "utf8");
    const butane = buildButane(template, platform, sshKeys);
    const filled = base
      .split("@@REPOSITORY@@").join(platform.repository)
      .split("@@RECONCILER_IMAGE@@").join(platform.reconciler.image);
    expect(butane.startsWith(filled)).toBe(true);
    expect(butane).not.toContain("@@");
    expect(butane).toContain(key);
  });

  it("fills the server's IPv6 from the Primary IPv6 it is created with (D91)", () => {
    const base = readFileSync(join(template, "butane", "server.bu"), "utf8");
    const root = withButane(`${base}# Address=@@IPV6_ADDRESS@@\n`);
    expect(buildButane(root, platform, sshKeys, firstAddress("2a01:4f8:c0:1::/64"))).toContain("# Address=2a01:4f8:c0:1::1/64\n");
    expect(() => buildButane(root, platform, sshKeys)).toThrow(/give its address/);
    expect(() => buildButane(root, platform, sshKeys, "2a01:4f8:c0:1::1")).toThrow(/not an IPv6 address/);
    expect(() => buildButane(root, platform, sshKeys, "2a01::1/64\nX=1")).toThrow(/not an IPv6 address/);
    expect(() => firstAddress("203.0.113.10")).toThrow(/not an IPv6/);
    // A server created by bivy never takes an address written in the file.
    expect(() => buildButane(withButane(`${base}# Address=2a01:4f8:c0:1::1/64\n`), platform, sshKeys, "2a01:4f8:c0:2::1/64")).toThrow(/not a fixed address/);
  });

  it("refuses a Butane file without a placeholder, or with an unknown one", () => {
    const base = readFileSync(join(template, "butane", "server.bu"), "utf8");
    const missing = withButane(base.replace("@@RECONCILER_IMAGE@@", "ghcr.io/example/bivouac-reconciler:main"));
    expect(() => buildButane(missing, platform, sshKeys)).toThrow(IgnitionError);
    expect(() => buildButane(missing, platform, sshKeys)).toThrow(/must contain @@RECONCILER_IMAGE@@/);
    const unknown = withButane(`${base}# @@DOMAIN@@\n`);
    expect(() => buildButane(unknown, platform, sshKeys)).toThrow(/unknown placeholder @@DOMAIN@@/);
  });
});

describeWithDocker("ignition", () => {
  it("compiles the template with the exact file modes, the keys and the reconciler unit", () => {
    const json = compileButane(buildButane(template, platform, sshKeys));
    expect(Buffer.byteLength(json)).toBeLessThan(MAX_IGNITION_BYTES);
    const ignition = JSON.parse(json);
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
      "/etc/bivouac-metadata-block.nft": "644",
      "/opt/bivouac/sync-ssh-keys": "700",
      "/opt/bivouac/reconciler-trial": "700",
      "/etc/bivouac": "700",
      "/var/lib/bivouac": "700",
      "/var/lib/bivouac/ssh": "700",
      "/var/lib/bivouac/ssh-status": "700",
    });
    expect(ignition.passwd.users).toEqual([{ name: "core", sshAuthorizedKeys: [key] }]);
    const units = Object.fromEntries(
      ignition.systemd.units.map((unit: { name: string; contents?: string }) => [unit.name, unit.contents]),
    );
    expect(Object.keys(units)).toEqual([
      "bivouac-metadata-block.service",
      "docker.service",
      "bivouac-ssh-keys.path",
      "bivouac-ssh-keys.service",
      "bivouac-ssh-keys.timer",
      "bivouac-reconciler.service",
    ]);
    // Docker requires the metadata block, explicitly, in a drop-in.
    const docker = ignition.systemd.units.find((unit: { name: string }) => unit.name === "docker.service");
    expect(docker.contents).toBeUndefined();
    expect(docker.dropins[0].contents).toContain("Requires=bivouac-metadata-block.service\nAfter=bivouac-metadata-block.service");
    const reconciler: string = units["bivouac-reconciler.service"];
    expect(reconciler).toContain(`Environment=BIVOUAC_RECONCILER_IMAGE=${platform.reconciler.image}\n`);
    expect(reconciler).toContain("EnvironmentFile=-/var/lib/bivouac/reconciler/image.env\n");
    expect(reconciler).toContain(`--env BIVOUAC_REPOSITORY=${platform.repository} `);
    expect(reconciler).toMatch(/\$\{BIVOUAC_RECONCILER_IMAGE\}\n/);
    expect(reconciler).not.toContain(":main");
  }, 120_000); // the first run pulls the Butane image
});
