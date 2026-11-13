import { spawnSync } from "node:child_process";

/**
 * SSH to a server through the system's `ssh`, always with a known_hosts file
 * of the platform's own and strict host key checking: never
 * `~/.ssh/known_hosts`, never a key accepted blindly (runbook section 8).
 */

export class RemoteError extends Error {}

export interface CommandOutput {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Remote {
  /** Runs a command on the server. `input` goes to its standard input, never on a command line. */
  run(command: string, options?: { input?: string | Buffer; timeoutMs?: number }): CommandOutput;
}

export function sshOptions(identity: string, knownHosts: string): string[] {
  return [
    "-i", identity,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
  ];
}

export class SshRemote implements Remote {
  constructor(private readonly host: string, private readonly identity: string, private readonly knownHosts: string) {}

  run(command: string, options: { input?: string | Buffer; timeoutMs?: number } = {}): CommandOutput {
    const result = spawnSync("ssh", [...sshOptions(this.identity, this.knownHosts), `core@${this.host}`, command], {
      input: options.input ?? "",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? 5 * 60_000,
    });
    if (result.error) throw new RemoteError(`ssh to ${this.host} failed: ${result.error.message}`);
    return { status: result.status ?? 255, stdout: result.stdout, stderr: result.stderr };
  }
}

/** The server's ED25519 host key, as `ssh-keyscan` sees it, and its SHA256 fingerprint. */
export function scanHostKey(host: string): { line: string; fingerprint: string } | undefined {
  const scan = spawnSync("ssh-keyscan", ["-T", "5", "-t", "ed25519", host], { encoding: "utf8" });
  const line = scan.stdout.split("\n").find((entry) => entry.startsWith(`${host} ssh-ed25519 `));
  if (!line) return undefined;
  const print = spawnSync("ssh-keygen", ["-lf", "-"], { input: `${line}\n`, encoding: "utf8" });
  const fingerprint = /SHA256:[A-Za-z0-9+/]+/.exec(print.stdout)?.[0];
  if (!fingerprint) throw new RemoteError(`could not read the fingerprint of ${host}'s host key`);
  return { line, fingerprint };
}
