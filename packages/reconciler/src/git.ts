import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class GitError extends Error {}

export interface GitSource {
  /** Address of the instance repo, e.g. `git@github.com:owner/bivouac-platform.git`. */
  repository: string;
  /** Branch the server follows. */
  branch: string;
  /**
   * Read-only deploy key (D30), used once the file exists: it is placed over
   * SSH after the server first boots, and checked again on every pass, so the
   * reconciler needs no restart to pick it up. Unset for local repos in tests.
   */
  deployKey?: string;
  /** Pinned SSH host keys of the Git host: an unknown host key is refused. */
  knownHosts?: string;
}

/**
 * Brings the local checkout to the tip of the branch and returns its commit.
 * The checkout is never edited on the server: any local change is discarded,
 * since Git is the only source of truth (principle 2).
 */
export function syncRepository(source: GitSource, directory: string): string {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...sshEnv(source) };
  const run = (args: string[], cwd?: string) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.error) throw new GitError(`could not run git: ${result.error.message}`);
    if (result.status !== 0) throw new GitError(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };

  if (!existsSync(join(directory, ".git"))) {
    run(["clone", "--quiet", "--depth", "1", "--branch", source.branch, source.repository, directory]);
  } else {
    run(["remote", "set-url", "origin", source.repository], directory);
    run(["fetch", "--quiet", "--depth", "1", "origin", source.branch], directory);
    run(["reset", "--quiet", "--hard", "FETCH_HEAD"], directory);
    run(["clean", "--quiet", "-d", "--force", "-x"], directory);
  }
  return run(["rev-parse", "HEAD"], directory);
}

/**
 * SSH options for git. The pinned host keys apply whether or not the deploy
 * key exists yet (D54): without them, a missing key would fall back to the
 * user's empty known_hosts and report a misleading host key error.
 */
export function sshEnv(source: GitSource): Record<string, string> {
  const key = source.deployKey && existsSync(source.deployKey) ? source.deployKey : undefined;
  if (!key && !source.knownHosts) return {};
  const options = [
    ...(key ? [`-i ${key}`, "-o IdentitiesOnly=yes"] : []),
    "-o BatchMode=yes",
    "-o StrictHostKeyChecking=yes",
    ...(source.knownHosts ? [`-o UserKnownHostsFile=${source.knownHosts}`] : []),
  ];
  return { GIT_SSH_COMMAND: `ssh ${options.join(" ")}` };
}
