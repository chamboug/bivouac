import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { SshKeys } from "@bivouac/manifest";

/**
 * Butane runs in its official container: the CLI depends on Docker, not on a
 * Butane binary (D31). Version verified on 5 November 2026 (latest release).
 */
export const BUTANE_IMAGE = "quay.io/coreos/butane:v0.29.0";

export class IgnitionError extends Error {}

/**
 * Builds the Butane config for the server from `butane/server.bu`, adding
 * the authorized keys from `ssh-keys.yml` so the list lives in one place.
 */
export function buildButane(root: string, sshKeys: SshKeys): string {
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
  const passwd = stringify({
    passwd: {
      users: [{ name: "core", ssh_authorized_keys: sshKeys.keys.map((entry) => entry.key.trim()) }],
    },
  }, { lineWidth: 0 });
  return `${base.endsWith("\n") ? base : `${base}\n`}${passwd}`;
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
  return result.stdout;
}
