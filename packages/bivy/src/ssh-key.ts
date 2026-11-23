import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as prompts from "@clack/prompts";
import type { Choice } from "./ask.js";
import { interactive } from "./terminal.js";

/**
 * Which private key bivy logs in to the server with (D112): `--ssh-key`
 * first, then the key chosen before, then what ~/.ssh holds. Several keys
 * and nothing chosen yet: a person at a terminal picks one from a list,
 * once, and bivy remembers it; a script keeps ~/.ssh/id_ed25519, as before.
 */

export class SshKeyError extends Error {}

export interface FoundKey {
  /** The private key's path. */
  path: string;
  /** Its `.pub` line. */
  publicKey: string;
}

/** Private keys in `dir`: a file with its `.pub` pair, of a type the platform takes. known_hosts, config and the like have none. */
export function findSshKeys(dir: string): FoundKey[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((file) => file.endsWith(".pub") && existsSync(join(dir, file.slice(0, -4))))
    .map((file) => ({ path: join(dir, file.slice(0, -4)), publicKey: readFileSync(join(dir, file), "utf8").trim() }))
    .filter((entry) => /^(ssh-ed25519|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) /.test(entry.publicKey));
}

/** Remembers the key for the next commands; written by the picker and by bivy init. */
export function rememberSshKey(memory: string, path: string): void {
  mkdirSync(dirname(memory), { recursive: true, mode: 0o700 });
  // Absolute: a path typed relative to one folder means nothing from another.
  writeFileSync(memory, `${resolve(path)}\n`, { mode: 0o600 });
}

export interface SshKeyDependencies {
  /** ~/.ssh */
  sshDir: string;
  /** ~/.config/bivouac/ssh-key: one line, the chosen key's path. */
  memory: string;
  /** A person is at a terminal. */
  tty: boolean;
  /** An arrow-key list; undefined when cancelled. */
  choose: (message: string, choices: Choice<string>[]) => Promise<string | undefined>;
  /** A line for the person, on stderr so `--json` stays clean. */
  note: (message: string) => void;
}

/** The key to log in with, or a SshKeyError that says what to pass. */
export async function sshIdentity(given: string | undefined, deps: SshKeyDependencies): Promise<string> {
  if (given !== undefined) {
    if (!existsSync(given)) throw new SshKeyError(`No SSH key at ${given}: pass the right one with --ssh-key <file>.`);
    return given;
  }
  const remembered = existsSync(deps.memory) ? readFileSync(deps.memory, "utf8").trim() : "";
  if (remembered && existsSync(remembered)) return remembered;
  if (remembered) deps.note(`The SSH key remembered in ${deps.memory}, ${remembered}, is gone.`);

  const fallback = join(deps.sshDir, "id_ed25519");
  const found = findSshKeys(deps.sshDir);
  const [only] = found;
  if (only && found.length === 1) {
    if (only.path !== fallback) deps.note(`Using the SSH key ${only.path}, the only one in ${deps.sshDir}.`);
    return only.path;
  }
  if (found.length > 1 && deps.tty) {
    const choice = await deps.choose(
      "Which SSH key logs in to the server from this machine? bivy remembers it.",
      found.map((entry) => {
        const comment = entry.publicKey.split(" ").slice(2).join(" ");
        return { value: entry.path, label: entry.path, ...(comment ? { hint: comment } : {}) };
      }),
    );
    if (choice === undefined) throw new SshKeyError("No SSH key chosen: nothing was done.");
    rememberSshKey(deps.memory, choice);
    deps.note(`Remembered in ${deps.memory}; delete that file to choose again.`);
    return choice;
  }
  if (existsSync(fallback)) return fallback;
  const list = found.length > 0 ? ` Found: ${found.map((entry) => entry.path).join(", ")}.` : "";
  throw new SshKeyError(`No SSH key at ${fallback}: pass the right one with --ssh-key <file>.${list}`);
}

/** Where the chosen key is remembered on this machine. */
export const SSH_KEY_MEMORY = join(homedir(), ".config", "bivouac", "ssh-key");

/** sshIdentity on this machine; undefined after saying why on stderr. */
export async function machineSshKey(given: string | undefined): Promise<string | undefined> {
  try {
    return await sshIdentity(given, {
      sshDir: join(homedir(), ".ssh"),
      memory: SSH_KEY_MEMORY,
      tty: interactive(),
      choose: async (message, choices) => {
        // Typed loosely: clack's option type is conditional on T, which a generic cannot satisfy.
        const answer = await prompts.select({ message, options: choices as never });
        return prompts.isCancel(answer) ? undefined : (answer as string);
      },
      note: (message) => console.error(message),
    });
  } catch (error) {
    if (!(error instanceof SshKeyError)) throw error;
    console.error(error.message);
    return undefined;
  }
}
