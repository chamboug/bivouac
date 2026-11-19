/**
 * How bivy talks to a person (D93): questions answered with the arrow keys,
 * one plain sentence per step, a spinner while it waits. The logic only sees
 * this interface, so tests answer with a script and a run without a terminal
 * has no guide at all: every question then has a flag, or a safe default.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Guide {
  /** One answer among the choices; the first is the recommended one. Throws Cancelled on Ctrl-C or Escape. */
  select<T extends string>(message: string, choices: Choice<T>[]): Promise<T>;
  /** Yes or no; throws Cancelled on Ctrl-C or Escape. */
  confirm(message: string): Promise<boolean>;
  /** Hidden input; undefined when nothing was typed. Throws Cancelled on Ctrl-C or Escape. */
  secret(message: string): Promise<string | undefined>;
}

/** The person stopped at a question: nothing more is done. */
export class Cancelled extends Error {
  constructor() {
    super("stopped at your request");
  }
}

/** What a run says while it works: a step begins, a step ends. */
export interface Progress {
  start(sentence: string): void;
  stop(sentence: string, seconds: number): void;
  fail(sentence: string): void;
}

/**
 * The plain sentence for each step of a rebuild. The names stay the ones the
 * state files record (a run is resumed by them); only what is shown changes.
 */
const SENTENCES: Record<string, string> = {
  "firewall, open to this Mac only": "Putting up a firewall that lets in this computer only",
  "temporary IPv6": "Reserving a temporary IPv6 address",
  server: "Renting the test server",
  "SSH answers": "Waiting for the server to start (a minute or two)",
  "fresh backup": "Making a fresh backup on the old server (a few minutes)",
  "signing keys before": "Noting Pocket ID's signing keys, to compare afterwards",
  "server rebuilt": "Erasing the server and installing Flatcar again",
  "server created": "Creating the new server on the same addresses",
  "host key replaced": "The server makes its own identity key",
  "first-boot checks": "Checking the server's first boot (SSH settings, metadata block)",
  "rebuild marker (test mode)": "Telling the server it is a test copy",
  "rebuild marker (rebuild mode)": "Telling the server it is being rebuilt",
  "deploy key": "Giving the server read access to the instance repo",
  "age key": "Handing over the age key, so the server can read its secrets",
  "Postgres, alone": "Starting Postgres, alone for now",
  "restore the latest nightly copy": "Bringing the data back from the backup (a minute or more)",
  "Pocket ID and the apps": "Starting Pocket ID and the apps",
  "checks against the real platform": "Comparing the copy with the real platform",
  "checks on the real names": "Checking the platform on its real addresses (certificates may take a minute)",
  "marker removed": "Removing the rebuild marker: the server is an ordinary one again",
};

export const sentenceFor = (step: string): string => SENTENCES[step] ?? step;
