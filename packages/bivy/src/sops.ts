import { spawnSync } from "node:child_process";

/**
 * SOPS in its official container (D31: no sops binary on the Mac), at the
 * exact image the reconciler copies its binary from (packages/reconciler/
 * Dockerfile). Plain values only ever travel through standard input and
 * output: never a file, never a command line.
 */
export const SOPS_IMAGE = "ghcr.io/getsops/sops:v3.13.3@sha256:857f5a151ac0b2bfc55c1e4e5581d66fb8e268e4d106b38e74191f3bac9d58ea";

export class SopsError extends Error {}

export interface Sops {
  /** Encrypts a YAML document for one age recipient. Needs no secret. */
  encrypt(yaml: string, recipient: string): string;
  /** Decrypts a SOPS YAML document with the age identity given (the key file's content). */
  decrypt(encrypted: string, identity: Buffer): string;
}

const BASE = ["run", "--rm", "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];

function run(args: string[], input: string): string {
  const result = spawnSync("docker", [...BASE, ...args], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new SopsError(`could not run Docker (is it installed and started?): ${result.error.message}`);
  // sops' messages never hold the plain values; only its last line is kept.
  if (result.status !== 0) throw new SopsError(`sops failed: ${result.stderr.trim().split("\n").pop() ?? `exit ${result.status}`}`);
  return result.stdout;
}

export const dockerSops: Sops = {
  encrypt(yaml, recipient) {
    if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new SopsError(`'${recipient}' is not an age recipient`);
    return run([SOPS_IMAGE, "encrypt", "--input-type", "yaml", "--output-type", "yaml", "--age", recipient, "/dev/stdin"], yaml);
  },
  decrypt(encrypted, identity) {
    // Standard input carries the document, so the identity goes through
    // SOPS_AGE_KEY: `--env SOPS_AGE_KEY` names it only, and docker takes the
    // value from its own environment, never from a command line.
    const result = spawnSync("docker", [...BASE, "--env", "SOPS_AGE_KEY", SOPS_IMAGE, "decrypt", "--input-type", "yaml", "--output-type", "yaml", "/dev/stdin"], {
      input: encrypted,
      encoding: "utf8",
      env: { ...process.env, SOPS_AGE_KEY: identity.toString("utf8") },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw new SopsError(`could not run Docker (is it installed and started?): ${result.error.message}`);
    if (result.status !== 0) throw new SopsError(`sops could not decrypt: ${result.stderr.trim().split("\n").pop() ?? `exit ${result.status}`}`);
    return result.stdout;
  },
};
