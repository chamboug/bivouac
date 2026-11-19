import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Credentials of bivy (D93): one file per value under ~/.config/bivouac/,
 * readable by its owner only. When a file is missing and a person is at the
 * terminal, bivy asks for the value with hidden input and writes the file
 * itself; the next commands read it there. A value is never printed, never
 * passed on a command line, never asked of a script.
 */

export class CredentialError extends Error {}

/** Asks for a value with hidden input; undefined when the person cancels. Absent when nobody is at a terminal. */
export type AskSecret = (message: string) => Promise<string | undefined>;

export interface CredentialSpec {
  /** The file, absolute. */
  path: string;
  /** What it is, in a few words: "the Hetzner token". */
  what: string;
  /** Where to get it, shown before asking: a link, a sentence. */
  hint?: string;
}

/** Reads a credential file that must already exist, mode 600, not empty. */
export function readCredential(spec: CredentialSpec): string {
  const { path, what } = spec;
  if (!existsSync(path)) {
    throw new CredentialError(`${what} is missing (${path}). Run the command again in a terminal: bivy asks for it and keeps it there.`);
  }
  if ((statSync(path).mode & 0o077) !== 0) throw new CredentialError(`${path} can be read by others: chmod 600 it`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new CredentialError(`${path} is empty: delete it, then run the command again`);
  return value;
}

/**
 * The credential: from its file when it exists, otherwise asked for (hidden
 * input) and written to a new file of mode 600, in a folder of mode 700.
 */
export async function credential(spec: CredentialSpec, ask: AskSecret | undefined, log: (message: string) => void = console.log): Promise<string> {
  if (existsSync(spec.path)) return readCredential(spec);
  if (!ask) throw new CredentialError(`${spec.what} is missing (${spec.path}), and nobody is at a terminal to type it: run the command in a terminal.`);
  if (spec.hint) log(spec.hint);
  const answer = await ask(`${capitalize(spec.what)} (hidden as you type, or paste it):`);
  const value = answer?.trim();
  if (!value) throw new CredentialError(`no value given for ${spec.what}: nothing was written`);
  if (/\s/.test(value)) throw new CredentialError(`${spec.what} cannot contain spaces or line breaks: nothing was written`);
  mkdirSync(dirname(spec.path), { recursive: true, mode: 0o700 });
  // "wx": never overwrite a file that appeared meanwhile; mode 600 from the start.
  writeFileSync(spec.path, value, { mode: 0o600, flag: "wx" });
  log(`Kept in ${spec.path} (readable by you only). Delete that file to type it again.`);
  return value;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
