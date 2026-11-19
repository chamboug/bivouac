import { sshOptions } from "./remote.js";

/**
 * `bivy ssh` and `bivy exec` (D93): reach the server, or run a command in an
 * app's container, without knowing its address, which key to use or how to
 * check its host key. The same rules as every other SSH of bivy: the
 * platform's own known_hosts, strict host key checking, nothing from
 * ~/.ssh/config.
 */

export class SshError extends Error {}

/** Pocket ID's name: always on the platform's server, so its address is the server's (D40). */
export const SERVER_NAME_PREFIX = "auth";

/** The app container's name, as the reconciler creates it. */
export const appContainer = (app: string) => `bivouac-app-${app}`;

/** One argument for a POSIX shell, safe whatever it holds. */
export function shellQuote(argument: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command the server's shell runs for `bivy exec`: `docker exec` into the
 * app's container, interactive when a person is at the terminal. With no
 * command, a shell in the container.
 */
export function execCommand(app: string, command: readonly string[], tty: boolean): string {
  const words = command.length > 0 ? command : ["sh"];
  return ["docker", "exec", tty ? "-it" : "-i", appContainer(app), ...words].map(shellQuote).join(" ");
}

/**
 * The arguments of the system's `ssh`. A person at a terminal gets a
 * terminal on the server and may be asked for their key's passphrase; a
 * script (or Claude) gets neither, and never waits for a question.
 */
export function sshArguments(host: string, identity: string, knownHosts: string, options: { tty: boolean; remote?: string | undefined }): string[] {
  const base = sshOptions(identity, knownHosts);
  const withoutBatch = options.tty ? dropOption(base, "BatchMode=yes") : base;
  return [...withoutBatch, options.tty ? "-t" : "-T", `core@${host}`, ...(options.remote ? [options.remote] : [])];
}

function dropOption(options: string[], value: string): string[] {
  const index = options.indexOf(value);
  return index > 0 && options[index - 1] === "-o" ? [...options.slice(0, index - 1), ...options.slice(index + 1)] : options;
}

/** The server's IPv4, from the DNS: the name every visitor uses, and the one a rebuild keeps (D91). */
export async function serverAddress(domain: string, resolve: (name: string) => Promise<string[]>): Promise<string> {
  const name = `${SERVER_NAME_PREFIX}.${domain}`;
  let addresses: string[];
  try {
    addresses = await resolve(name);
  } catch (error) {
    throw new SshError(`cannot find the server: ${name} does not resolve (${(error as Error).message})`);
  }
  if (addresses.length !== 1) throw new SshError(`cannot find the server: ${name} has ${addresses.length} addresses (${addresses.join(", ")}), one expected`);
  return addresses[0] as string;
}

/** Splits `bivy exec recettes -- node script.mjs --admin` at the first `--`: what follows goes to the container untouched. */
export function splitAtDoubleDash(argv: readonly string[]): { own: string[]; command: string[] } {
  const index = argv.indexOf("--");
  return index < 0 ? { own: [...argv], command: [] } : { own: argv.slice(0, index), command: argv.slice(index + 1) };
}
