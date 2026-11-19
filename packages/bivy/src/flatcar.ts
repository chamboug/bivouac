import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asker } from "./ask.js";
import { orderableTypes, type Hetzner, type Image } from "./hetzner.js";

/**
 * The Flatcar snapshot (D65, runbook section 4), made once per Hetzner
 * project: Hetzner has no Flatcar image. The image is downloaded on this
 * machine and checked (Flatcar's GPG signature, then SHA-512) in a
 * throwaway container, and that very file is written to a temporary server
 * by `hcloud-upload-image` (a community tool, not a Hetzner product; the
 * method Flatcar's own Hetzner guide gives first), pinned by digest, with a
 * temporary token the owner deletes afterwards: the main token never
 * reaches it (D65).
 */

export const UPLOAD_IMAGE = "ghcr.io/apricote/hcloud-upload-image@sha256:1cd09ab0e26662a8c244e76a52c1d2f436de27681ca4d56d99d9cc6de1175078";
export const FLATCAR_KEY_FINGERPRINT = "F88CFEDEFF29A5B4D9523864E25D9AED0593B34A";
const RELEASES = "https://stable.release.flatcar-linux.net/amd64-usr";
/** The image of the signature check, pinned (its gnupg package comes from Alpine's mirror at that moment). */
export const CHECK_IMAGE = "alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf";
const TOOL_LABEL = "apricote.de/created-by=hcloud-upload-image";

export class FlatcarError extends Error {}

export interface Run {
  (command: string, args: string[], options?: { env?: Record<string, string>; inherit?: boolean }): { status: number; stdout: string; stderr: string };
}

export interface FlatcarDependencies {
  ask: Asker;
  hetzner: Hetzner;
  run: Run;
  fetchText: (url: string) => Promise<string>;
  /** `~/.config/bivouac/<name>`. */
  config: (name: string) => string;
  log: (message: string) => void;
}

export function flatcarVersion(versionTxt: string): string {
  const version = /^FLATCAR_VERSION=(\d+\.\d+\.\d+)$/m.exec(versionTxt)?.[1];
  if (!version) throw new FlatcarError("could not read Flatcar's current stable version");
  return version;
}

/** The check, in a throwaway container (runbook section 4): prints both OK lines or fails. */
export function verifyScript(): string {
  return [
    "apk add -q gnupg >/dev/null; export GNUPGHOME=$(mktemp -d); gpg -q --import /w/flatcar.asc",
    `gpg --status-fd 1 -o /tmp/d --decrypt /w/image.DIGESTS.asc 2>/dev/null | grep -q "VALIDSIG .* ${FLATCAR_KEY_FINGERPRINT}$" && echo signature OK`,
    `[ "$(awk "/SHA512/{getline; print \\$1}" /tmp/d)" = "$(sha512sum /w/image.bin.bz2 | cut -d" " -f1)" ] && echo sha512 OK`,
  ].join("\n");
}

/** The cheapest x86 type orderable there whose disk is no larger than the platform server's (a snapshot only goes to a disk at least as large). */
export function uploadServerType(types: Parameters<typeof orderableTypes>[0], location: string, maxDisk: number): string {
  const disks = new Map(types.map((type) => [type.name, type.disk]));
  const fitting = orderableTypes(types, location, { memory: 0, disk: 0 }).filter((type) => (disks.get(type.name) ?? Number.MAX_SAFE_INTEGER) <= maxDisk);
  const chosen = fitting[0];
  if (!chosen) throw new FlatcarError(`no server type with a disk of at most ${maxDisk} GB can be ordered in ${location} to make the snapshot`);
  return chosen.name;
}

export async function makeFlatcarSnapshot(deps: FlatcarDependencies, location: string, serverDisk: number): Promise<Image> {
  const { run, log } = deps;
  const version = flatcarVersion(await deps.fetchText(`${RELEASES}/current/version.txt`));
  const dir = mkdtempSync(join(tmpdir(), "bivy-flatcar-"));
  try {
    log(`  downloading Flatcar ${version} (about 500 MB) and checking Flatcar's signature…`);
    const base = `${RELEASES}/${version}/flatcar_production_hetzner_image.bin.bz2`;
    for (const [url, file] of [[base, "image.bin.bz2"], [`${base}.DIGESTS.asc`, "image.DIGESTS.asc"], ["https://www.flatcar.org/security/image-signing-key/Flatcar_Image_Signing_Key.asc", "flatcar.asc"]] as const) {
      const got = run("curl", ["-fsSL", "--proto", "=https", "-o", join(dir, file), url]);
      if (got.status !== 0) throw new FlatcarError(`downloading ${url} failed: ${got.stderr.trim()}`);
    }
    const checked = run("docker", ["run", "--rm", "-v", `${dir}:/w:ro`, CHECK_IMAGE, "sh", "-euc", verifyScript()]);
    if (!checked.stdout.includes("signature OK") || !checked.stdout.includes("sha512 OK")) {
      throw new FlatcarError("the downloaded image does not carry Flatcar's valid signature: nothing was sent to Hetzner");
    }
    log("  ✓ signed by Flatcar, checksum matches");

    const tokenFile = deps.config("hetzner-token-upload");
    const token = await deps.ask.secret({
      path: tokenFile,
      what: "a TEMPORARY Hetzner token, for the snapshot tool only",
      hint: "The snapshot tool is not Hetzner's own, and a Hetzner token opens the whole project: give it a token of its own, deleted right after.\nHetzner Console → the project → Security → API tokens → Generate (Read & Write), named 'snapshot, delete me'.",
    });
    const type = uploadServerType(await deps.hetzner.serverTypes(), location, serverDisk);
    log(`  making the snapshot with a temporary ${type} in ${location} (about 5 minutes, a few cents)…`);
    const uploaded = run("docker", [
      "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-e", "HCLOUD_TOKEN",
      "-v", `${join(dir, "image.bin.bz2")}:/image.bz2:ro`, UPLOAD_IMAGE,
      "upload", "--image-path", "/image.bz2", "--compression", "bz2", "--server-type", type, "--location", location,
      "--description", `flatcar-stable-${version}`, "--labels", `os=flatcar,flatcar-channel=stable,flatcar-version=${version}`,
    ], { env: { HCLOUD_TOKEN: token }, inherit: true });
    // Interrupted or failed, the tool leaves its server and key behind: its own clean-up deletes only what carries its label.
    const leftovers = async () => [...(await deps.hetzner.servers(TOOL_LABEL)).map((entry) => `server ${entry.name}`), ...(await deps.hetzner.sshKeys(TOOL_LABEL)).map((entry) => `SSH key ${entry.name}`)];
    if ((await leftovers()).length > 0) {
      run("docker", ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-e", "HCLOUD_TOKEN", UPLOAD_IMAGE, "cleanup"], { env: { HCLOUD_TOKEN: token }, inherit: true });
    }
    const left = await leftovers();
    const revoke = "Delete the temporary token in the Hetzner Console (Security → API tokens) once done with it.";
    if (left.length > 0) throw new FlatcarError(`the snapshot tool left ${left.join(", ")} (billed): delete them in the Hetzner Console. ${revoke}`);
    if (uploaded.status !== 0) throw new FlatcarError(`the snapshot tool failed (exit ${uploaded.status}); it left nothing behind. Run again to retry, or: ${revoke}`);
    const snapshot = (await deps.hetzner.snapshots("os=flatcar")).find((image) => image.labels["flatcar-version"] === version && image.status === "available");
    if (!snapshot) throw new FlatcarError("the tool finished, but no available snapshot carries the expected labels");
    rmSync(tokenFile, { force: true });
    log([
      `  ✓ snapshot ${snapshot.id} (Flatcar ${version})`,
      "  ▶ Now delete the temporary token in the Hetzner Console (Security → API tokens): bivy already forgot it.",
    ].join("\n"));
    return snapshot;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
