/**
 * Deploy keys of the instance repo, through GitHub's REST API (D30, D66).
 * The token is a temporary fine-grained PAT limited to that repo, with
 * "Administration: write" (verified, GitHub's permission tables, D66). It is
 * only held in memory and only ever sent in the Authorization header.
 */

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface DeployKey {
  id: number;
  title: string;
  key: string;
  read_only: boolean;
}

/** `git@github.com:owner/repo.git` → `owner/repo`. Only GitHub addresses, as the reconciler pins its keys (D54). */
export function repositoryPath(address: string): string {
  const match = /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(\.git)?$/.exec(address);
  if (!match?.[1]) throw new GitHubError(`'${address}' is not a GitHub SSH address (git@github.com:owner/repo.git)`);
  return match[1];
}

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(`https://api.github.com/repos/${this.repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // keep the status
      }
      throw new GitHubError(`GitHub ${method} ${path}: ${message}`, response.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  deployKeys(): Promise<DeployKey[]> {
    return this.call<DeployKey[]>("GET", "/keys");
  }

  /** Always read-only: the server only ever reads the instance repo (D30). */
  async addDeployKey(title: string, key: string): Promise<DeployKey> {
    const added = await this.call<DeployKey>("POST", "/keys", { title, key, read_only: true });
    if (!added.read_only) throw new GitHubError(`GitHub created deploy key ${added.id} with write access: remove it by hand`);
    return added;
  }

  async removeDeployKey(id: number): Promise<void> {
    try {
      await this.call("DELETE", `/keys/${id}`);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return;
      throw error;
    }
  }
}
