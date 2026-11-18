import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { appSecretNameProblem, appSecretsFile, type AppManifest } from "@bivouac/manifest";
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
  /**
   * Classic GitHub token with `read:packages` only, and its owner's login:
   * pulls private app images from GHCR (D17). Without it, only public images.
   */
  ghcr: z.looseObject({
    username: z.string().min(1, "must not be empty"),
    token: z.string().min(1, "must not be empty"),
  }).optional(),
  /** Password of the SMTP account named in `platform.yml`. */
  mail: z.looseObject({ password: z.string().min(1, "must not be empty") }).optional(),
  /** The nightly backups (D16, D33). Without them, nothing is backed up. */
  backup: z.looseObject({
    restic_password: z.string().min(1, "must not be empty"),
    b2_key_id: z.string().min(1, "must not be empty"),
    b2_application_key: z.string().min(1, "must not be empty"),
  }).optional(),
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
  const document = decryptSopsFile(file, PLATFORM_SECRETS_FILE, ageKeyFile);
  const parsed = platformSecretsSchema.safeParse(document);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `'${issue.path.join(".")}' ${issue.message}`);
    throw new SecretsError(`${PLATFORM_SECRETS_FILE} is incomplete: ${problems.join("; ")}`);
  }
  return parsed.data;
}

/**
 * An app's own secrets (D97), as environment variables, or none when the
 * app has no file. The instance check already refused names the platform
 * provides, values that are not text and nested maps; this checks again.
 */
export function decryptAppSecrets(checkout: string, app: AppManifest, ageKeyFile: string): Record<string, string> {
  const relative = appSecretsFile(app.name);
  const file = join(checkout, relative);
  if (!existsSync(file) && !isLink(file)) return {};
  // A link could hand one app another's secrets: CI only reads plain files.
  if (!lstatSync(file).isFile()) throw new SecretsError(`${relative} must be a plain file, not a link`);
  const document = decryptSopsFile(file, relative, ageKeyFile);
  const parsed = z.record(z.string(), z.string()).safeParse(document);
  if (!parsed.success) throw new SecretsError(`${relative} must hold one text value per name`);
  for (const [name, value] of Object.entries(parsed.data)) {
    // Docker would refuse the container, after the running one is removed.
    if (value.includes("\0") || Buffer.byteLength(value) > MAX_APP_SECRET_BYTES) {
      throw new SecretsError(`${relative}: '${name}' holds a value an environment variable cannot carry (a NUL byte, or over 32 KiB)`);
    }
  }
  for (const name of Object.keys(parsed.data)) {
    const problem = appSecretNameProblem(name, app);
    if (problem) throw new SecretsError(`${relative}: '${name}' ${problem}`);
  }
  return parsed.data;
}

const MAX_APP_SECRET_BYTES = 32 * 1024;

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function decryptSopsFile(file: string, label: string, ageKeyFile: string): unknown {
  if (!existsSync(file)) {
    throw new SecretsError(`${label} is missing from the instance repo`);
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
    throw new SecretsError(`could not decrypt ${label}: ${result.stderr.trim().split("\n").pop()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    // Never quote the parse error: it would show part of the decrypted text.
    throw new SecretsError(`${label} did not decrypt to a readable document`);
  }
}

/**
 * A secret derived from the master secret: `HMAC-SHA256(master, purpose)`,
 * in hexadecimal (64 characters, safe in URLs and connection strings). The
 * same master secret always gives the same value, so nothing generated has
 * to be stored or backed up (D14).
 *
 * Purposes in use: `postgres:superuser`, `db:<database>`, `oidc:<app>`,
 * `session:<app>` (D97), `api:status` (D96).
 */
export function deriveSecret(master: string, purpose: string): string {
  return createHmac("sha256", master).update(purpose).digest("hex");
}

export interface RegistryLogin {
  username: string;
  password: string;
  serveraddress: string;
}

/**
 * The login to send with a pull of `image`: the GHCR token, for GHCR images
 * only. No other registry ever sees it.
 */
export function registryLogin(secrets: PlatformSecrets, image: string): RegistryLogin | undefined {
  if (!secrets.ghcr || !image.startsWith("ghcr.io/")) return undefined;
  return { username: secrets.ghcr.username, password: secrets.ghcr.token, serveraddress: "ghcr.io" };
}
