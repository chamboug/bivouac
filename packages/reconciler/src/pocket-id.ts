/**
 * The few Pocket ID API calls the reconciler makes, with the admin key
 * (`STATIC_API_KEY`, sent as `X-API-KEY`). Every behavior relied on here was
 * checked against a real v2.19.2 container on 6 November 2026, and is
 * exercised again by the end-to-end tests:
 *
 * - `POST /api/oidc/clients` accepts a chosen `id`, and creates a random
 *   secret on its own: the reconciler deletes every secret but its own.
 * - `POST /api/oidc/clients/{id}/secrets` with `{ secret }` adds a chosen
 *   secret (at least 16 characters). Adding the same one twice keeps both.
 *   The API never returns a secret again, only its first 4 characters.
 * - `PUT /api/oidc/clients/{id}` replaces the whole client: a missing
 *   `isGroupRestricted` turns it off AND empties the allowed groups. So the
 *   client is always sent in full, then the groups.
 * - `PUT /api/oidc/clients/{id}/allowed-user-groups` alone does NOT turn on
 *   the restriction (`isGroupRestricted` stays false).
 * - The token endpoint answers `invalid_client` (401) to a wrong secret and
 *   `invalid_grant` (400) to a right secret with a bogus code: that is how
 *   the reconciler checks its secret is in place.
 */

export class PocketIdError extends Error {}

export interface OidcClientSpec {
  /** The app's name, used as the client ID. */
  id: string;
  callbackUrls: string[];
  logoutCallbackUrls: string[];
  secret: string;
  /** Pocket ID group names allowed to log in. */
  groups: string[];
}

interface Client {
  id: string;
  name: string;
  callbackURLs: string[];
  logoutCallbackURLs: string[];
  isPublic: boolean;
  pkceEnabled: boolean;
  isGroupRestricted: boolean;
  allowedUserGroups: { id: string; name: string }[];
}

interface Group {
  id: string;
  name: string;
}

export class PocketId {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "X-API-KEY": this.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, data: text ? (JSON.parse(text) as unknown) : undefined };
  }

  private async expect<T>(method: string, path: string, ok: number[], body?: unknown): Promise<T> {
    const { status, data } = await this.call(method, path, body);
    if (!ok.includes(status)) {
      const message = (data as { error?: string } | undefined)?.error ?? `HTTP ${status}`;
      throw new PocketIdError(`Pocket ID ${method} ${path}: ${message}`);
    }
    return data as T;
  }

  /** Returns the IDs of the named groups, creating the missing ones. */
  async ensureGroups(names: string[], changes: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const found = await this.expect<{ data: Group[] }>(
        "GET",
        `/api/user-groups?search=${encodeURIComponent(name)}&pagination[limit]=100`,
        [200],
      );
      const existing = found.data.find((group) => group.name === name);
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const created = await this.expect<Group>("POST", "/api/user-groups", [201], { name, friendlyName: name });
      changes.push(`group ${name}`);
      ids.push(created.id);
    }
    return ids;
  }

  /** Brings one OIDC client to its spec and returns what it changed. */
  async ensureClient(spec: OidcClientSpec): Promise<string[]> {
    const changes: string[] = [];
    const groupIds = await this.ensureGroups(spec.groups, changes);
    const wanted = {
      name: spec.id,
      callbackURLs: spec.callbackUrls,
      logoutCallbackURLs: spec.logoutCallbackUrls,
      isPublic: false,
      pkceEnabled: true,
      isGroupRestricted: true,
    };

    const { status, data } = await this.call("GET", `/api/oidc/clients/${encodeURIComponent(spec.id)}`);
    if (status === 404) {
      await this.expect("POST", "/api/oidc/clients", [201], { id: spec.id, ...wanted });
      changes.push(`OIDC client ${spec.id}`);
    } else if (status !== 200) {
      throw new PocketIdError(`Pocket ID GET client ${spec.id}: HTTP ${status}`);
    } else if (!sameClient(data as Client, wanted)) {
      await this.expect("PUT", `/api/oidc/clients/${encodeURIComponent(spec.id)}`, [200], wanted);
      changes.push(`OIDC client ${spec.id} settings`);
    }

    const current = (await this.expect<Client>("GET", `/api/oidc/clients/${encodeURIComponent(spec.id)}`, [200]))
      .allowedUserGroups.map((group) => group.id);
    if (!sameSet(current, groupIds)) {
      await this.expect("PUT", `/api/oidc/clients/${encodeURIComponent(spec.id)}/allowed-user-groups`, [200], {
        userGroupIds: groupIds,
      });
      changes.push(`OIDC client ${spec.id} groups`);
    }

    await this.ensureSecret(spec, changes);
    return changes;
  }

  /**
   * Leaves exactly one secret on the client: the derived one. When the
   * client has a single secret and the token endpoint accepts ours, nothing
   * is touched; otherwise ours is added and every other one deleted.
   */
  private async ensureSecret(spec: OidcClientSpec, changes: string[]): Promise<void> {
    const path = `/api/oidc/clients/${encodeURIComponent(spec.id)}/secrets`;
    const secrets = await this.expect<{ id: string }[]>("GET", path, [200]);
    if (secrets.length === 1 && (await this.acceptsSecret(spec.id, spec.secret))) {
      return;
    }
    const added = await this.expect<{ id: string }>("POST", path, [201], { secret: spec.secret });
    for (const secret of secrets) {
      await this.expect("DELETE", `${path}/${secret.id}`, [204]);
    }
    changes.push(`OIDC client ${spec.id} secret`);
    if (!added.id) throw new PocketIdError(`Pocket ID did not return the new secret of ${spec.id}`);
  }

  /** Asks the token endpoint whether it accepts the secret (see the header comment). */
  async acceptsSecret(clientId: string, secret: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/oidc/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "bivouac-check", redirect_uri: "https://invalid" }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { error?: string };
    if (body.error === "invalid_grant") return true;
    if (body.error === "invalid_client") return false;
    throw new PocketIdError(`unexpected answer from the token endpoint: HTTP ${response.status} ${body.error ?? ""}`);
  }
}

function sameClient(current: Client, wanted: Omit<Client, "id" | "allowedUserGroups">): boolean {
  return (
    current.name === wanted.name &&
    current.isPublic === wanted.isPublic &&
    current.pkceEnabled === wanted.pkceEnabled &&
    current.isGroupRestricted === wanted.isGroupRestricted &&
    sameSet(current.callbackURLs, wanted.callbackURLs) &&
    sameSet(current.logoutCallbackURLs ?? [], wanted.logoutCallbackURLs)
  );
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
