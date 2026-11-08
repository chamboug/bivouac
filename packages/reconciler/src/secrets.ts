import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";

/** The platform's secrets file in the instance repo, encrypted with SOPS. */
export const PLATFORM_SECRETS_FILE = "secrets/platform.sops.yaml";

/**
 * What the reconciler needs from the secrets file. Other entries (Hetzner,
 * OVH, B2… tokens used by `bivy`) may sit next to these and are ignored.
 */
export const platformSecretsSchema = z.looseObject({
  /** Every secret the platform generates is derived from this one (D14). */
  master_secret: z.string().min(32, "must be at least 32 characters"),
  pocket_id: z.looseObject({
    /** Encrypts Pocket ID's signing keys: losing it loses them (see CLAUDE.md). */
    encryption_key: z.string().min(16, "must be at least 16 characters"),
    /** Admin API key (verified, Pocket ID docs: at least 16 characters). */
    static_api_key: z.string().min(16, "must be at least 16 characters"),
  }),
  /** Password of the SMTP account named in `platform.yml`. */
  mail: z.looseObject({ password: z.string().min(1, "must not be empty") }).optional(),
  /** Pushover and healthchecks.io (D45). Without them, the platform runs without alerts. */
  alerts: z.looseObject({
    pushover_token: z.string().min(1, "must not be empty"),
    pushover_user: z.string().min(1, "must not be empty"),
    healthchecks: z.looseObject({
      heartbeat: z.url({ protocol: /^https$/ }),
      backup: z.url({ protocol: /^https$/ }),
      restore: z.url({ protocol: /^https$/ }),
    }),
  }).optional(),
});

export type PlatformSecrets = z.infer<typeof platformSecretsSchema>;

export class SecretsError extends Error {}

/**
 * Decrypts the secrets file with the `sops` binary shipped in the image
 * (copied from the official `ghcr.io/getsops/sops` image, D47) and the age
 * key placed over SSH (D7). The decrypted values only live in memory, and
 * in the files given to the containers that need them.
 */
export function decryptSecrets(file: string, ageKeyFile: string): PlatformSecrets {
  if (!existsSync(file)) {
    throw new SecretsError(`${PLATFORM_SECRETS_FILE} is missing from the instance repo`);
  }
  if (!existsSync(ageKeyFile)) {
    throw new SecretsError(`the age key is missing (${ageKeyFile}): it is placed over SSH by bivy`);
  }
  const result = spawnSync(
    "sops",
    ["--disable-version-check", "decrypt", "--output-type", "json", file],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", SOPS_AGE_KEY_FILE: ageKeyFile } },
  );
  if (result.error) throw new SecretsError(`could not run sops: ${result.error.message}`);
  if (result.status !== 0) {
    // sops' message names the problem (wrong key, damaged file) but never a value.
    throw new SecretsError(`could not decrypt ${PLATFORM_SECRETS_FILE}: ${result.stderr.trim().split("\n").pop()}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    // Never quote the parse error: it would show part of the decrypted text.
    throw new SecretsError(`${PLATFORM_SECRETS_FILE} did not decrypt to a readable document`);
  }
  const parsed = platformSecretsSchema.safeParse(document);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `'${issue.path.join(".")}' ${issue.message}`);
    throw new SecretsError(`${PLATFORM_SECRETS_FILE} is incomplete: ${problems.join("; ")}`);
  }
  return parsed.data;
}

/**
 * A secret derived from the master secret: `HMAC-SHA256(master, purpose)`,
 * in hexadecimal (64 characters, safe in URLs and connection strings). The
 * same master secret always gives the same value, so nothing generated has
 * to be stored or backed up (D14).
 *
 * Purposes in use: `postgres:superuser`, `db:<database>`, `oidc:<app>`.
 */
export function deriveSecret(master: string, purpose: string): string {
  return createHmac("sha256", master).update(purpose).digest("hex");
}
