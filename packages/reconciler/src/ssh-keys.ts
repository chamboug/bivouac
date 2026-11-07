import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SshKeys } from "@bivouac/manifest";

/**
 * The SSH keys allowed to log in as `core`, from the instance repo's
 * `ssh-keys.yml` (D12). The reconciler only writes them to its state
 * directory; on the host, a systemd path unit placed by Ignition notices
 * the change and applies them with Flatcar's `update-ssh-keys`, so the
 * reconciler needs no access to the home directory of `core`.
 */
export const SSH_KEYS_FILE = join("ssh", "authorized_keys");

/** Written by the host script: `applied <sha256>` or `refused <sha256>: <reason>`. */
export const SSH_KEYS_STATUS_FILE = join("ssh-status", "applied");

/**
 * Writes the key list, one key per line, and returns whether it changed.
 * The new file is written outside the watched directory and renamed into
 * place: the host's path unit never sees a half-written list, nor fires
 * on the temporary file before the list is in place.
 */
export function writeSshKeys(stateDir: string, sshKeys: SshKeys): boolean {
  const path = join(stateDir, SSH_KEYS_FILE);
  const content = `${sshKeys.keys.map((entry) => entry.key.trim()).join("\n")}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateDir, "tmp"), { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, "tmp", "authorized_keys");
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return true;
}

/** How long the host may take to apply a new list before it is reported. */
export const SSH_KEYS_GRACE_MS = 2 * 60_000;

/**
 * Whether the host applied the current list, from the status its script
 * writes. Returns a problem to report, or undefined when the list is
 * applied, still within its grace period, or when there is no host script
 * to ask: Ignition creates the `ssh-status` directory on a server, and the
 * local platform has none. A refused list keeps the previous keys.
 */
export function sshKeysProblem(stateDir: string, now = Date.now()): string | undefined {
  const listPath = join(stateDir, SSH_KEYS_FILE);
  const statusPath = join(stateDir, SSH_KEYS_STATUS_FILE);
  if (!existsSync(listPath) || !existsSync(dirname(statusPath))) return undefined;
  if (now - statSync(listPath).mtimeMs < SSH_KEYS_GRACE_MS) return undefined;
  if (!existsSync(statusPath)) {
    return "the host has never applied the SSH keys of ssh-keys.yml (its bivouac-ssh-keys service has not run)";
  }
  const hash = createHash("sha256").update(readFileSync(listPath)).digest("hex");
  const status = readFileSync(statusPath, "utf8").trim();
  if (status === `applied ${hash}`) return undefined;
  if (status.startsWith(`refused ${hash}: `)) {
    return `the host refused the SSH keys of ssh-keys.yml (${status.slice(`refused ${hash}: `.length)}): the previous keys stay in place`;
  }
  return "the host has not applied the current SSH keys of ssh-keys.yml: the previous keys stay in place";
}
