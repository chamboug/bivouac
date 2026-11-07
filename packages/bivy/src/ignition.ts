import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { PlatformConfig, SshKeys } from "@bivouac/manifest";

/**
 * Butane runs in its official container: the CLI depends on Docker, not on a
 * Butane binary (D31). Version verified on 5 November 2026 (latest release).
 */
export const BUTANE_IMAGE = "quay.io/coreos/butane:v0.29.0";

export class IgnitionError extends Error {}

/**
 * Hetzner refuses user-data above 32 KiB (verified, Hetzner API docs).
 */
export const MAX_IGNITION_BYTES = 32 * 1024;

/**
 * Values of platform.yml written into the Butane, so each lives in one
 * place. Each placeholder must appear in `butane/server.bu`.
 */
const PLACEHOLDERS = {
  "@@REPOSITORY@@": (platform: PlatformConfig) => platform.repository,
  "@@RECONCILER_IMAGE@@": (platform: PlatformConfig) => platform.reconciler.image,
} as const;

/**
 * Builds the Butane config for the server from `butane/server.bu`: the
 * placeholders get their values from `platform.yml`, and the authorized
 * keys from `ssh-keys.yml` are appended, so each list lives in one place.
 */
export function buildButane(root: string, platform: PlatformConfig, sshKeys: SshKeys): string {
  const path = join(root, "butane", "server.bu");
  if (!existsSync(path)) {
    throw new IgnitionError("butane/server.bu is missing");
  }
  const base = readFileSync(path, "utf8");
  // Butane reads YAML 1.1, where `mode: 0600` is octal. Parse the same way
  // to check the file, and never re-serialize it: the keys are appended as
  // text, so the base reaches Butane exactly as written.
  const document = parseDocument(base, { version: "1.1" });
  if (document.errors.length > 0) {
    throw new IgnitionError(`butane/server.bu is not valid YAML: ${document.errors[0]?.message}`);
  }
  if (document.has("passwd")) {
    throw new IgnitionError(
      "butane/server.bu must not have a 'passwd' section: SSH keys come from ssh-keys.yml",
    );
  }
  // Text replacement, not YAML: the values are validated by the schema
  // (no quotes, spaces or newlines), and the file is never re-serialized.
  let filled = base;
  for (const [placeholder, value] of Object.entries(PLACEHOLDERS)) {
    if (!filled.includes(placeholder)) {
      throw new IgnitionError(`butane/server.bu must contain ${placeholder}: it is filled from platform.yml`);
    }
    filled = filled.split(placeholder).join(value(platform));
  }
  const leftover = /@@[A-Z_]+@@/.exec(filled);
  if (leftover) {
    throw new IgnitionError(`butane/server.bu contains an unknown placeholder ${leftover[0]}`);
  }
  const passwd = stringify({
    passwd: {
      users: [{ name: "core", ssh_authorized_keys: sshKeys.keys.map((entry) => entry.key.trim()) }],
    },
  }, { lineWidth: 0 });
  return `${filled.endsWith("\n") ? filled : `${filled}\n`}${passwd}`;
}

/** Compiles Butane to Ignition JSON with `butane --strict` (warnings fail). */
export function compileButane(butane: string): string {
  const result = spawnSync("docker", ["run", "--rm", "--interactive", BUTANE_IMAGE, "--strict"], {
    input: butane,
    encoding: "utf8",
  });
  if (result.error) {
    throw new IgnitionError(`could not run Docker (is it installed and started?): ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new IgnitionError(`Butane refused the config:\n${result.stderr.trim()}`);
  }
  const size = Buffer.byteLength(result.stdout);
  if (size > MAX_IGNITION_BYTES) {
    throw new IgnitionError(
      `the Ignition config is ${size} bytes, above Hetzner's user-data limit of ${MAX_IGNITION_BYTES}`,
    );
  }
  return result.stdout;
}
