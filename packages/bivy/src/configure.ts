import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptedEntries, loadInstance, readSopsConfigRecipients } from "@bivouac/manifest";
import { parse, parseDocument, stringify } from "yaml";
import { AskError, type Asker } from "./ask.js";
import { HealthchecksError, channels, createChecks } from "./healthchecks.js";
import { PushoverError, sendTest, validateUser } from "./pushover.js";
import { PRESETS, S3Error, checkBucket, checkDestination, checkEndpoint, regionOf, resticRepository } from "./s3.js";
import { type Sops, SopsError } from "./sops.js";

/**
 * The parts of the platform that can wait (D93): backups, alerts and
 * Pocket ID's mail. `bivy init` asks for them with the same code as
 * `bivy configure <part>`, which adds a part later. A part already set up
 * is never changed by bivy: that is a decision of its own, by hand
 * (runbook section 12 for the backups), so bivy cannot lose a backup
 * repository or silence alerts by mistake.
 */

export type PartName = "backups" | "alerts" | "mail";
export const PARTS: PartName[] = ["backups", "alerts", "mail"];

export class ConfigureError extends Error {}

export interface PartDependencies {
  ask: Asker;
  /** `~/.config/bivouac/<name>`. */
  config: (name: string) => string;
  fetch: typeof globalThis.fetch;
  checkSmtp: (account: { host: string; port: number; user: string; password: string }) => Promise<void>;
  now: () => number;
}

/** What a part adds: to platform.yml, to the secrets, and what the owner must keep. */
export interface PartResult {
  platform: Record<string, unknown>;
  secrets: Record<string, unknown>;
  /** Shown once, with the age key when there is one: the owner keeps them in the password manager. */
  keep: { what: string; value: string }[];
  /** Credential files only needed to write the secrets: removed once they are in the encrypted file. */
  spent: string[];
  /** Done after the secrets are written, before they are pushed: what bivy sets up elsewhere (healthchecks.io). */
  summary: string;
}

const EMAIL = /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Asks for one part and checks every answer against the real service. Changes nothing anywhere.
 * `testAlert` offers a test alert from this computer: `bivy configure` only, since `bivy init`
 * sends one from the server once it runs.
 */
export async function askPart(deps: PartDependencies, part: PartName, domain: string, options: { testAlert?: boolean } = {}): Promise<PartResult> {
  if (part === "backups") return askBackups(deps);
  if (part === "alerts") return askAlerts(deps, domain, options.testAlert ?? false);
  return askMail(deps);
}

async function askBackups(deps: PartDependencies): Promise<PartResult> {
  const { ask } = deps;
  const presetId = await ask.select("backup-provider", "Where do the nightly backups go? Any S3-compatible storage works.", PRESETS.map((preset) => ({ value: preset.id, label: preset.label })));
  const preset = PRESETS.find((entry) => entry.id === presetId) ?? PRESETS[1];
  ask.log(preset?.help ?? "");
  const wrap = (check: (value: string) => unknown) => (value: string) => {
    try {
      check(value);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };
  let endpoint: string;
  let region: string;
  if (preset?.endpoint) {
    region = await ask.text("backup-region", "The bucket's region, as in its endpoint (like eu-central-003):", { check: (value) => (/^[a-z0-9-]+$/.test(value) ? undefined : "only lower case letters, digits and dashes") });
    endpoint = checkEndpoint(preset.endpoint(region));
  } else {
    endpoint = checkEndpoint(await ask.text("backup-endpoint", "The storage's HTTPS endpoint (host name only):", { placeholder: "s3.example.com", check: wrap(checkEndpoint) }));
    region = await ask.text("backup-region", "Its region (if it has none, us-east-1):", { initial: regionOf(endpoint) });
  }
  const bucket = await ask.text("backup-bucket", "The bucket's name (empty, private):", { check: wrap(checkBucket) });
  const keyFile = deps.config("backup-key-id");
  const secretFile = deps.config("backup-secret-key");
  const accessKeyId = await ask.secret({ path: keyFile, what: "the storage's access key ID" });
  const secretAccessKey = await ask.secret({ path: secretFile, what: "the storage's secret key" });
  try {
    await checkDestination({ endpoint, bucket, region, accessKeyId, secretAccessKey }, deps.fetch, new Date(deps.now()));
  } catch (error) {
    if (!(error instanceof S3Error)) throw error;
    throw new ConfigureError(`${error.message}. Fix it, or delete ${keyFile} and ${secretFile} to type the keys again.`);
  }
  ask.log(`  ✓ the key can list ${bucket}, which is empty`);
  // restic encrypts everything with it: lost, the backups cannot be read (D16).
  const resticPassword = randomBytes(32).toString("base64url");
  return {
    platform: { backup: { repository: resticRepository({ endpoint, bucket }) } },
    // The names say B2 for history; they hold any S3 key (D93).
    secrets: { backup: { restic_password: resticPassword, b2_key_id: accessKeyId, b2_application_key: secretAccessKey } },
    keep: [{ what: "The restic password (without it, the backups cannot be read)", value: resticPassword }],
    spent: [keyFile, secretFile],
    summary: `backups to ${resticRepository({ endpoint, bucket })}, every night at 02:00 UTC`,
  };
}

async function askAlerts(deps: PartDependencies, domain: string, testAlert: boolean): Promise<PartResult> {
  const { ask } = deps;
  ask.log([
    "Alerts go to your phone through Pushover; healthchecks.io notices when the server goes silent (D45).",
    "  1. Pushover (pushover.net): your User Key, then Create an Application → its API Token.",
    "  2. healthchecks.io: a project; Integrations → add Pushover; Settings → API Keys → a read-write key.",
  ].join("\n"));
  const tokenFile = deps.config("pushover-token");
  const userFile = deps.config("pushover-user");
  const keyFile = deps.config("healthchecks-api-key");
  const pushoverToken = await ask.secret({ path: tokenFile, what: "the Pushover application's API token" });
  const pushoverUser = await ask.secret({ path: userFile, what: "your Pushover user key" });
  try {
    await validateUser(deps.fetch, pushoverToken, pushoverUser);
    ask.log("  ✓ Pushover: the token and the user key are valid");
    // Optional, and only with a person to say whether it arrived.
    if (testAlert && ask.tty && (await ask.select("test-alert", "Send a test alert to your phone now?", [{ value: "send", label: "Send one" }, { value: "skip", label: "Skip" }])) === "send") {
      await sendTest(deps.fetch, pushoverToken, pushoverUser, domain);
      const arrived = await ask.select("test-alert-arrived", "Did the test alert reach your phone?", [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
      if (arrived === "no") throw new ConfigureError("the test alert did not arrive: check that the Pushover app on your phone is signed in with that user key and allowed to notify, then run it again");
    }
  } catch (error) {
    if (error instanceof PushoverError) throw new ConfigureError(`${error.message}. Fix it, or delete ${tokenFile} and ${userFile} to type them again.`);
    if (error instanceof ConfigureError || error instanceof AskError) throw error;
    throw new ConfigureError(`could not reach Pushover: ${(error as Error).message}`);
  }
  const apiKey = await ask.secret({ path: keyFile, what: "the healthchecks.io read-write API key" });
  // A refusal or a network error is said plainly, never as a stack trace.
  const healthchecks = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HealthchecksError) throw new ConfigureError(`${error.message}. Fix it, or delete ${keyFile} to type the key again.`);
      throw new ConfigureError(`could not reach healthchecks.io: ${(error as Error).message}`);
    }
  };
  const integrations = await healthchecks(() => channels(deps.fetch, apiKey));
  if (integrations.length === 0) throw new ConfigureError("the healthchecks.io project has no integration: add Pushover there first (Integrations), or a missing ping would alert nobody");
  if (!integrations.some((entry) => entry.kind === "po")) ask.log("  ! no Pushover integration in that project: its alerts go to the others only");
  const pings = await healthchecks(() => createChecks(deps.fetch, apiKey, domain));
  ask.log(`  ✓ healthchecks.io: the checks '${domain} heartbeat', 'backup' and 'restore' exist, sending to ${integrations.map((entry) => entry.name || entry.kind).join(", ")}`);
  return {
    platform: {},
    secrets: { alerts: { pushover_token: pushoverToken, pushover_user: pushoverUser, healthchecks: pings } },
    keep: [],
    spent: [tokenFile, userFile, keyFile],
    summary: "alerts through Pushover, and healthchecks.io's three checks",
  };
}

async function askMail(deps: PartDependencies): Promise<PartResult> {
  const { ask } = deps;
  ask.log("Pocket ID sends invitations and notices through an SMTP account of yours: port 587, STARTTLS. Hetzner blocks ports 25 and 465 (D70).");
  const host = await ask.text("smtp-host", "The SMTP server:", { placeholder: "smtp.example.org", check: (value) => (HOST.test(value) ? undefined : "a host name, like smtp.example.org") });
  const user = await ask.text("smtp-user", "The account's login:", { check: (value) => (value ? undefined : "required") });
  const from = await ask.text("smtp-from", "The address mail is sent from:", { ...(EMAIL.test(user) ? { initial: user } : {}), check: (value) => (EMAIL.test(value) ? undefined : "an email address") });
  const passwordFile = deps.config("smtp-password");
  const password = await ask.secret({ path: passwordFile, what: "the SMTP account's password" });
  try {
    await deps.checkSmtp({ host, port: 587, user, password });
  } catch (error) {
    // SmtpError, or a network error (no such host, refused, timeout).
    throw new ConfigureError(`${host}:587 refused: ${(error as Error).message}. Fix it, or delete ${passwordFile} to type the password again.`);
  }
  ask.log(`  ✓ logged in to ${host}:587 over STARTTLS (no mail sent)`);
  return {
    platform: { mail: { host, port: 587, from, user } },
    secrets: { mail: { password } },
    keep: [],
    spent: [passwordFile],
    summary: `Pocket ID's mail through ${host}`,
  };
}

/** Whether a part is already set up in an instance repo. Reads names only, never decrypts. */
export function configured(root: string, part: PartName): boolean {
  const platform = parse(readFileSync(join(root, "platform.yml"), "utf8")) as Record<string, unknown> | null;
  const secrets = encryptedEntries(readFileSync(join(root, "secrets", "platform.sops.yaml"), "utf8")).map((entry) => entry.name);
  if (part === "backups") return platform?.backup !== undefined || secrets.includes("backup");
  if (part === "mail") return platform?.mail !== undefined || secrets.includes("mail");
  return secrets.includes("alerts");
}

/** Adds keys at the top of platform.yml's own text, keeping its comments. */
export function addToPlatformYml(text: string, additions: Record<string, unknown>): string {
  const document = parseDocument(text);
  for (const [key, value] of Object.entries(additions)) {
    if (document.has(key)) throw new ConfigureError(`platform.yml already has '${key}'`);
    document.set(key, document.createNode(value));
  }
  return document.toString({ lineWidth: 0 });
}

export function recipientOf(root: string): string {
  const { errors, recipients } = readSopsConfigRecipients(readFileSync(join(root, ".sops.yaml"), "utf8"));
  if (errors.length > 0 || recipients.length !== 1) throw new ConfigureError(`.sops.yaml must name exactly one age recipient: ${errors.join("; ")}`);
  return recipients[0] as string;
}

/** Docker missing or sops refusing is said plainly, never as a stack trace. */
function sopsStep<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof SopsError) throw new ConfigureError(`${error.message}. Nothing was written`);
    throw error;
  }
}

/** Decrypts the secrets file: plain values only in memory. */
export function decryptSecrets(root: string, sops: Sops, identity: Buffer): Record<string, unknown> {
  const file = join(root, "secrets", "platform.sops.yaml");
  return sopsStep(() => parse(sops.decrypt(readFileSync(file, "utf8"), identity)) as Record<string, unknown>);
}

/** Adds the part's values to the decrypted secrets and encrypts the file again. */
export function addSecrets(root: string, sops: Sops, plain: Record<string, unknown>, additions: Record<string, unknown>): void {
  for (const key of Object.keys(additions)) if (key in plain) throw new ConfigureError(`the secrets already hold '${key}'`);
  const encrypted = sopsStep(() => sops.encrypt(stringify({ ...plain, ...additions }, { lineWidth: 0 }), recipientOf(root)));
  writeFileSync(join(root, "secrets", "platform.sops.yaml"), encrypted);
}

/** The age identity; a missing key file is said plainly. */
function readIdentity(deps: ConfigureDependencies): Buffer {
  try {
    return deps.identity();
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT" ? (error as NodeJS.ErrnoException).path : undefined;
    if (missing) throw new ConfigureError(`no age key at ${missing}: the secrets cannot be decrypted. Nothing was written`);
    throw error;
  }
}

export interface ConfigureDependencies extends PartDependencies {
  sops: Sops;
  /** The age identity of the instance (from ~/.config/sops/age/keys.txt). */
  identity: () => Buffer;
  /** Why the checkout cannot be pushed as is (uncommitted changes, behind origin/main). */
  checkout: () => string[];
  git: (args: string[]) => { status: number; stdout: string; stderr: string };
  /** Shows the values to keep, once, and waits for the typed word (terminal only). */
  showOnce: (values: { what: string; value: string }[]) => Promise<void>;
}

/** `bivy configure <part>`: adds a part that is not set up yet, commits and pushes. */
export async function configurePart(deps: ConfigureDependencies, root: string, part: PartName): Promise<string> {
  const instance = loadInstance(root);
  if (instance.errors.length > 0 || !instance.platform) throw new ConfigureError(`the instance repo is invalid: run 'bivy validate ${root}' first`);
  if (configured(root, part)) {
    throw new ConfigureError(`${part} is already set up. bivy only adds a part; changing one is done by hand (runbook section ${part === "backups" ? "12, \"Moving the backups\"" : part === "alerts" ? "12" : "10"}).`);
  }
  const problems = deps.checkout();
  if (problems.length > 0) throw new ConfigureError(`the instance checkout cannot be pushed as is: ${problems.join("; ")}`);
  const result = await askPart(deps, part, instance.platform.domain, { testAlert: true });
  // Decrypted before anything is shown: a wrong age key, or Docker not running, stops here, with nothing to keep.
  const plain = decryptSecrets(root, deps.sops, readIdentity(deps));
  if (result.keep.length > 0) await deps.showOnce(result.keep);
  addSecrets(root, deps.sops, plain, result.secrets);
  if (Object.keys(result.platform).length > 0) {
    const path = join(root, "platform.yml");
    writeFileSync(path, addToPlatformYml(readFileSync(path, "utf8"), result.platform));
  }
  const after = loadInstance(root);
  if (after.errors.length > 0) {
    deps.git(["checkout", "--", "platform.yml", "secrets/platform.sops.yaml"]);
    throw new ConfigureError(`the result does not validate, nothing was committed: ${after.errors.map((error) => `${error.file}: ${error.message}`).join("; ")}`);
  }
  for (const args of [["add", "platform.yml", "secrets/platform.sops.yaml"], ["commit", "--quiet", "-m", `bivy configure ${part}`], ["push", "--quiet", "origin", "HEAD:main"]]) {
    const done = deps.git(args);
    if (done.status !== 0) throw new ConfigureError(`git ${args[0]} failed: ${done.stderr.trim().split("\n").pop() ?? ""}. The change is in ${root}: push it by hand.`);
  }
  for (const file of result.spent) rmSync(file, { force: true });
  return result.summary;
}
