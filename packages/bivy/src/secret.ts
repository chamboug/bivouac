import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkEncryptedFile } from "@bivouac/manifest";
import { parse } from "yaml";
import { recipientOf } from "./configure.js";
import type { AskSecret } from "./credentials.js";
import { type Sops, SopsError } from "./sops.js";

/**
 * `bivy secret set <path>` (D108): changes one value of the platform's
 * secrets file, `secrets/platform.sops.yaml`, and nothing else. The value is
 * typed with hidden input by a person at a terminal, or read from a file of
 * mode 600 the owner typed in a real terminal, which is deleted once the
 * change is checked (D93: a secret never has a flag). It lives in memory and
 * travels to the pinned sops container through standard input only (D31);
 * no message ever quotes it, nor any other decrypted value.
 *
 * Every other value is kept exactly: before and after writing, the file is
 * decrypted and every value compared by its hash. Nothing is committed or
 * pushed: the owner reads the diff (names only, values are encrypted) and
 * pushes, and the reconciler applies it within a minute.
 */

export class SecretError extends Error {}

export const PLATFORM_SECRETS = join("secrets", "platform.sops.yaml");

const HTTPS_URL = (value: string) => {
  try {
    if (new URL(value).protocol === "https:") return undefined;
  } catch {
    // Said below, without quoting it.
  }
  return "must be an https:// address";
};
const AT_LEAST = (length: number) => (value: string) => (value.length >= length ? undefined : `must be at least ${length} characters`);

const POCKET_ID_RESTARTS = "Pocket ID restarts with it: signing in pauses for up to about a minute (D68).";
const NEXT_BACKUP = "No container restarts: the next backup uses it. Change b2_key_id and b2_application_key together if the key itself changed, push once, then prove it with bivy backup.";
const NEXT_ALERT = "No container restarts: the next alert uses it. Prove it with the alert test (runbook section 12).";
const NEXT_PING = "No container restarts: the next ping goes there.";
const NEXT_PULL = "No container restarts: the next pull of a private image uses it.";

/** The values bivy may change, with what changing one does once pushed. */
export const SETTABLE: Readonly<Record<string, { effect: string; check?: (value: string) => string | undefined }>> = {
  "mail.password": { effect: `${POCKET_ID_RESTARTS} Then send a test mail from Pocket ID's email settings (runbook section 10).` },
  "pocket_id.static_api_key": { effect: `${POCKET_ID_RESTARTS} The reconciler talks to it with the new key at the same pass.`, check: AT_LEAST(16) },
  "backup.b2_key_id": { effect: NEXT_BACKUP },
  "backup.b2_application_key": { effect: NEXT_BACKUP },
  "alerts.pushover_token": { effect: NEXT_ALERT },
  "alerts.pushover_user": { effect: NEXT_ALERT },
  "alerts.healthchecks.heartbeat": { effect: NEXT_PING, check: HTTPS_URL },
  "alerts.healthchecks.backup": { effect: NEXT_PING, check: HTTPS_URL },
  "alerts.healthchecks.restore": { effect: NEXT_PING, check: HTTPS_URL },
  "ghcr.username": { effect: NEXT_PULL },
  "ghcr.token": { effect: NEXT_PULL },
};

/** Values of the file that are never changed one at a time, and why. */
export const REFUSED: Record<string, string> = {
  master_secret:
    "every derived secret comes from it (database passwords, OIDC clients, sessions, the status page's token: D14). Changing it is a rotation of its own, planned in a session, not a one-value change",
  "pocket_id.encryption_key": "it encrypts Pocket ID's signing keys: a new one loses them (D57)",
  "backup.restic_password":
    "restic encrypts the backups with it: the repository's own key must change first (restic key add, then remove the old one), or every backup fails. Not a one-value change",
};

export interface SecretDependencies {
  sops: Sops;
  /** The instance's age identity (the key file's lines for its recipient). */
  identity: () => Buffer;
  /** Hidden input; absent when nobody is at a terminal. */
  ask: AskSecret | undefined;
  /** Why the instance checkout should not be changed now (behind origin/main, other uncommitted changes). */
  checkout: () => string[];
  log: (message: string) => void;
}

/** Own keys only: `__proto__` or `toString` are never a path. */
const settableOf = (path: string) => (Object.hasOwn(SETTABLE, path) ? SETTABLE[path] : undefined);
const refusalOf = (path: string) => (Object.hasOwn(REFUSED, path) ? REFUSED[path] : undefined);

export interface SetResult {
  changed: boolean;
  /** What happens once pushed. */
  effect: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every leaf of a decrypted document, as `a.b.c` → hash of its JSON (type and value). Never the values. */
function leafHashes(value: unknown, path: string[] = [], out = new Map<string, string>()): Map<string, string> {
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) leafHashes(item, [...path, key], out);
  } else {
    // JSON.stringify(undefined) is undefined: hashed as a marker of its own.
    out.set(path.join("."), sha256(JSON.stringify(value) ?? "(undefined)"));
  }
  return out;
}

/**
 * Reads a document decrypted as JSON, as the reconciler reads it: in YAML,
 * sops writes some text unquoted (`<<`, `1_000`) that a YAML reader takes
 * for something else. A parse error is never quoted (it would show
 * decrypted text).
 */
function readPlain(text: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new SecretError(`${PLATFORM_SECRETS} did not decrypt to a readable document`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw new SecretError(`${PLATFORM_SECRETS} did not decrypt to a map`);
  return document as Record<string, unknown>;
}

const at = (document: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => (node !== null && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined), document);

/** Why a value cannot be stored as is, never quoting it; undefined when it can. */
export function valueProblem(path: string, value: string): string | undefined {
  if (value === "") return "it is empty";
  if (/[\r\n\0]/.test(value)) return "it holds a line break or a NUL byte (a file is read up to its first line break only)";
  if (value.trim() !== value) return "it starts or ends with a space";
  if (Buffer.byteLength(value) > 4096) return "it is longer than 4 KiB";
  const problem = settableOf(path)?.check?.(value);
  return problem ? `it ${problem}` : undefined;
}

/**
 * The value in a file the owner typed in a real terminal: a plain file of
 * theirs (not a link), readable by them only, outside the instance repo (a
 * file inside it could be committed). One final line break is dropped.
 */
export function readValueFile(file: string, root: string): string {
  const path = resolve(file);
  let inside: string;
  try {
    // The native call gives the case as stored: macOS's disks ignore case, so /Repo and /repo are one folder.
    inside = relative(realpathSync.native(root), join(realpathSync.native(dirname(path)), basename(path)));
  } catch {
    throw new SecretError(`${path} does not exist`);
  }
  if (!(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))) {
    throw new SecretError(`${path} is inside the instance repo, where it could be committed: write it elsewhere (e.g. ~/.config/bivouac/), then run this again`);
  }
  let link;
  try {
    link = lstatSync(path);
  } catch {
    throw new SecretError(`${path} does not exist`);
  }
  if (!link.isFile()) throw new SecretError(`${path} must be a plain file, not a link or a folder`);
  // Opened without following a link, then checked on what was opened.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new SecretError(`${path} must be a plain file`);
    // A second name for the same file could sit inside the repo.
    if (stat.nlink !== 1) throw new SecretError(`${path} has other names (hard links): write the value to a new file`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new SecretError(`${path} belongs to someone else`);
    if ((stat.mode & 0o077) !== 0) throw new SecretError(`${path} can be read by others: it must be mode 600 (chmod 600 it, or type it again with umask 077)`);
    if (stat.size > 8192) throw new SecretError(`${path} is too large for one value`);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    try {
      return text.decode(readFileSync(descriptor)).replace(/\r?\n$/, "");
    } catch {
      throw new SecretError(`${path} is not UTF-8 text`);
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Typed twice with hidden input: a typo is caught before anything is written. */
async function typedValue(ask: AskSecret, path: string): Promise<string> {
  const first = await ask(`The new value of ${path} (hidden as you type, or paste it):`);
  if (first === undefined) throw new SecretError("cancelled: nothing was changed");
  const second = await ask("The same value again, to check it:");
  if (second === undefined) throw new SecretError("cancelled: nothing was changed");
  if (first !== second) throw new SecretError("the two values differ: nothing was changed");
  return first;
}

/** Writes beside the file, then renames: the file is never half written. */
function replaceFile(file: string, content: string): void {
  const temporary = `${file}.bivy-${process.pid}`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: lstatSync(file).mode & 0o777 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Changes one value of the platform's secrets file. `valueFile`, when given,
 * is where the value is read from; it is deleted once the change is checked
 * (or found to change nothing), and kept on any failure, so the same command
 * can be run again.
 */
export async function setSecret(deps: SecretDependencies, root: string, path: string, valueFile?: string): Promise<SetResult> {
  const refused = refusalOf(path);
  if (refused) throw new SecretError(`${path} is never changed by bivy: ${refused}`);
  const settable = settableOf(path);
  if (!settable) throw new SecretError(`'${path}' is not a value bivy can change. It can change: ${Object.keys(SETTABLE).join(", ")}`);
  if (valueFile === undefined && !deps.ask) {
    throw new SecretError("the new value is typed by a person at a terminal (no flag can carry it, D93): run this in a terminal, or pass --from-file <file> with a file of mode 600 the owner typed");
  }

  // Names and the recipients are in the clear: checked before decrypting anything.
  const file = join(root, PLATFORM_SECRETS);
  let before: string;
  try {
    before = readFileSync(file, "utf8");
  } catch {
    throw new SecretError(`no ${PLATFORM_SECRETS} in ${root}: run bivy from the instance repo, or pass it (bivy secret set <path> <dir>)`);
  }
  const check = checkEncryptedFile(before);
  if (check.errors.length > 0) throw new SecretError(`${PLATFORM_SECRETS} ${check.errors.join("; ")}`);
  let recipient: string;
  try {
    recipient = recipientOf(root);
  } catch (error) {
    throw new SecretError((error as Error).message);
  }
  // Encrypted again for .sops.yaml's recipient only: it must be the one the server can open today.
  if (check.recipients.length !== 1 || check.recipients[0] !== recipient) {
    throw new SecretError(`${PLATFORM_SECRETS} is encrypted for ${check.recipients.join(", ")}, but .sops.yaml names ${recipient}: sort that out first, nothing was changed`);
  }
  if (typeof at(parse(before), path) !== "string") {
    throw new SecretError(`${PLATFORM_SECRETS} has no ${path} yet. bivy secret set changes a value already set; a missing part is added with bivy configure (runbook sections 10 and 12)`);
  }

  // An encrypted file cannot be merged: a checkout behind main would undo another change once pushed.
  const problems = deps.checkout();
  if (problems.length > 0) throw new SecretError(`the instance checkout should not be changed now: ${problems.join("; ")}. Nothing was changed`);

  // Decrypted before the value is asked: a wrong age key stops here.
  const identity = deps.identity();
  const plain = readPlain(deps.sops.decrypt(before, identity, "json"));
  const old = at(plain, path);
  if (typeof old !== "string") throw new SecretError(`${path} is not a text value in ${PLATFORM_SECRETS}`);

  const value = valueFile === undefined ? await typedValue(deps.ask as AskSecret, path) : readValueFile(valueFile, root);
  const problem = valueProblem(path, value);
  if (problem) throw new SecretError(`the new value of ${path} cannot be used: ${problem}. Nothing was changed`);

  const spent = () => {
    if (valueFile === undefined) return;
    try {
      rmSync(resolve(valueFile), { force: true });
    } catch {
      deps.log(`  ! ${resolve(valueFile)} could not be deleted: delete it by hand`);
    }
  };
  if (sha256(value) === sha256(old)) {
    spent();
    return { changed: false, effect: settable.effect };
  }

  // A copy with that one value changed, in JSON: no reader can take the text for
  // anything else, and sops keeps the order of the keys. The path is one of SETTABLE's.
  const next = structuredClone(plain);
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, next);
  parent[keys.at(-1) as string] = value;
  const expected = leafHashes(plain);
  expected.set(path, sha256(JSON.stringify(value)));
  const encrypted = deps.sops.encrypt(JSON.stringify(next), recipient, "json");
  const after = checkEncryptedFile(encrypted);
  if (after.errors.length > 0) throw new SecretError(`sops gave a file that is not fully encrypted (${after.errors.join("; ")}): nothing was changed`);

  replaceFile(file, encrypted);
  // Checked on what is now on disk, decrypted with the instance's key: the
  // same values, by hash, and the new one where it belongs.
  let good = false;
  let why = "did not decrypt to the expected values once written";
  try {
    const actual = leafHashes(readPlain(deps.sops.decrypt(readFileSync(file, "utf8"), identity, "json")));
    good = actual.size === expected.size && [...expected].every(([key, hash]) => actual.get(key) === hash);
  } catch (error) {
    // Messages of ours and sops' never quote a value; anything else is not repeated.
    why = error instanceof SecretError || error instanceof SopsError ? `could not be checked once written (${error.message})` : "could not be checked once written";
  } finally {
    if (!good) replaceFile(file, before);
  }
  if (!good) throw new SecretError(`${PLATFORM_SECRETS} ${why}: the previous file was put back, nothing was changed`);
  spent();
  return { changed: true, effect: settable.effect };
}
