import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * The provisional SSH host key of a server `bivy` creates (D91).
 *
 * Instead of the owner reading the host key in Hetzner's console, `bivy`
 * makes an ED25519 host key on the Mac and places it with the Ignition
 * config. Flatcar keeps a host key that already exists: `sshd-keygen.service`
 * runs `ssh-keygen -A`, which only creates a key whose file is missing or
 * empty (verified, flatcar/init `sshd_keygen` and openssh-portable
 * `do_gen_all_hostkeys`). The Mac knows that key in advance, so the first
 * connection is verified. Over it, and before anything else is sent, the
 * server makes a new host key and the Mac records it: the provisional key,
 * readable in the user-data for the life of the server, then proves nothing.
 *
 * This departs from D7 (no secret in user-data) for a few minutes; D91 says
 * why and its limits.
 */

/** Hetzner refuses user-data above 32 KiB (verified, Hetzner API docs). */
export const MAX_USER_DATA_BYTES = 32 * 1024;

export const HOST_KEY_PATH = "/etc/ssh/ssh_host_ed25519_key";

export class HostKeyError extends Error {}

export interface HostKeyPair {
  /** OpenSSH private key, held in memory only. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment` */
  publicKey: string;
}

const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [ -~]*)?$/;

/** `ssh-ed25519 AAAA…`, without the comment. */
export function keyPart(line: string): string {
  const [type, body] = line.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !body || !PUBLIC_KEY.test(`${type} ${body}`)) throw new HostKeyError(`not an ED25519 public key: '${line.slice(0, 40)}…'`);
  return `${type} ${body}`;
}

/** A new ED25519 key pair, made by the system's `ssh-keygen` in a private directory deleted at once. */
export function newHostKey(comment = "bivouac-provisional"): HostKeyPair {
  const dir = mkdtempSync(join(tmpdir(), "bivy-hostkey-"));
  try {
    const file = join(dir, "key");
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file], { encoding: "utf8" });
    if (result.status !== 0) throw new HostKeyError(`ssh-keygen failed: ${result.stderr.trim()}`);
    const privateKey = readFileSync(file, "utf8");
    const publicKey = readFileSync(`${file}.pub`, "utf8").trim();
    keyPart(publicKey);
    if (!privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) throw new HostKeyError("ssh-keygen wrote an unexpected private key");
    return { privateKey, publicKey };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface IgnitionFile {
  path: string;
  mode?: number;
  overwrite?: boolean;
  contents?: { source?: string; compression?: string };
}

interface IgnitionConfig {
  storage?: { files?: IgnitionFile[] };
  [key: string]: unknown;
}

/** A `source` from its `data:` URL, decompressed. Anything else is refused: it could not be checked. */
function decode(where: string, source: string, compression: unknown): string {
  const match = /^data:([^,]*),(.*)$/s.exec(source);
  if (!match) throw new HostKeyError(`${where}: only inline contents can be checked, not '${source.slice(0, 30)}…'`);
  const [, meta = "", payload = ""] = match;
  const base64 = meta.toLowerCase().split(";").includes("base64");
  // Strict base64: Node skips characters it does not know, Ignition may not.
  if (base64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new HostKeyError(`${where}: the base64 contents cannot be checked`);
  let bytes = base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  if (compression === "gzip") bytes = gunzipSync(bytes);
  else if (compression !== undefined && compression !== null && compression !== "") throw new HostKeyError(`${where}: unknown compression '${String(compression)}'`);
  return bytes.toString("utf8");
}

/**
 * Private keys and tokens with a fixed shape. Secrets without one (the
 * Hetzner token, the restic password) cannot be recognized: this guard is
 * for keys, not for every secret.
 */
const SECRET = /PRIVATE KEY|AGE-SECRET-KEY|AGE-PLUGIN-|PuTTY-User-Key-File|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_/i;

/**
 * Where an Ignition config holds a private key, read after decoding: Butane
 * compresses and encodes contents, so the compiled JSON never shows them as
 * text. Every `source` is decoded (file contents and appends, merged
 * configs, certificate authorities…), the rest is checked as written.
 * Returns the paths of the files concerned, or the place in the config.
 */
export function secretsIn(ignition: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown, where: string, file: string | undefined): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${where}/${index}`, file));
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const owner = typeof object.path === "string" && where.startsWith("/storage/") ? object.path : file;
    const rest: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      if (key === "source" && typeof entry === "string") {
        if (SECRET.test(decode(owner ?? where, entry, object.compression))) found.push(owner ?? where);
      } else {
        rest[key] = walk(entry, `${where}/${key}`, owner);
      }
    }
    return rest;
  };
  const rest = walk(JSON.parse(ignition), "", undefined);
  if (SECRET.test(JSON.stringify(rest))) found.push("(outside the contents)");
  return [...new Set(found)];
}

const dataUrl = (text: string) => `data:;base64,${Buffer.from(text).toString("base64")}`;

/**
 * Adds the provisional host key to a compiled Ignition config (not to the
 * instance's Butane: `bivy ignition` and the instance CI never see it). The
 * result must hold no other secret, and still fit Hetzner's user-data limit.
 */
export function withHostKey(ignition: string, key: HostKeyPair): string {
  if (secretsIn(ignition).length > 0) throw new HostKeyError("the Ignition config already holds a private key: refusing to send it as user-data (D7)");
  const config = JSON.parse(ignition) as IgnitionConfig;
  const files = config.storage?.files ?? [];
  if (files.some((file) => file.path === HOST_KEY_PATH || file.path === `${HOST_KEY_PATH}.pub`)) {
    throw new HostKeyError(`butane/server.bu must not write ${HOST_KEY_PATH}: bivy places a provisional one`);
  }
  config.storage = {
    ...config.storage,
    files: [
      ...files,
      { path: HOST_KEY_PATH, mode: 0o600, overwrite: true, contents: { source: dataUrl(key.privateKey) } },
      { path: `${HOST_KEY_PATH}.pub`, mode: 0o644, overwrite: true, contents: { source: dataUrl(`${key.publicKey}\n`) } },
    ],
  };
  const result = JSON.stringify(config);
  const secrets = secretsIn(result);
  if (secrets.length !== 1 || secrets[0] !== HOST_KEY_PATH) throw new HostKeyError(`unexpected private keys in the Ignition config: ${secrets.join(", ")}`);
  if (Buffer.byteLength(result) > MAX_USER_DATA_BYTES) throw new HostKeyError(`the Ignition config with its host key is above Hetzner's user-data limit of ${MAX_USER_DATA_BYTES} bytes`);
  return result;
}
