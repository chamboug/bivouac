/**
 * The few calls of the Hetzner Cloud API that `bivy rebuild` needs, spoken
 * directly (D31). Field names checked against Hetzner's OpenAPI document
 * (docs.hetzner.cloud/cloud.spec.json, 13 November 2026): `location`
 * replaced `datacenter` on servers and Primary IPs; an assigned Primary IP
 * can no longer be deleted; deleting a server detaches its firewalls and
 * deletes its Primary IPs that have `auto_delete`.
 */

export class HetznerError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

export type Labels = Record<string, string>;

export interface Server {
  id: number;
  name: string;
  status: string;
  labels: Labels;
  location?: { name: string };
  server_type: { name: string };
  protection: { delete: boolean; rebuild: boolean };
  public_net: {
    ipv4: { id: number; ip: string } | null;
    ipv6: { id: number; ip: string } | null;
    firewalls: { id: number }[];
  };
}

export interface PrimaryIp {
  id: number;
  name: string;
  type: "ipv4" | "ipv6";
  ip: string;
  labels: Labels;
  assignee_id: number | null;
  auto_delete: boolean;
  location?: { name: string };
  protection: { delete: boolean };
}

export interface Firewall {
  id: number;
  name: string;
  labels: Labels;
  applied_to: { server?: { id: number } }[];
}

export interface Image {
  id: number;
  description: string;
  status: string;
  architecture: string;
  disk_size: number;
  labels: Labels;
}

export interface ServerType {
  name: string;
  architecture: string;
  memory: number;
  disk: number;
  deprecation: unknown;
  locations?: { name: string; available?: boolean; deprecation?: unknown }[];
  prices: { location: string; price_hourly: { gross: string } }[];
}

export interface Action {
  id: number;
  command?: string;
  started?: string;
  status: "running" | "success" | "error";
  error?: { code: string; message: string } | null;
}

export interface FirewallRule {
  description: string;
  direction: "in";
  protocol: "tcp" | "udp";
  port: string;
  source_ips: string[];
}

const API = "https://api.hetzner.cloud/v1";

export class Hetzner {
  constructor(
    private readonly token: string,
    private readonly fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** The token is only ever in this header: never in a message, a log or a URL. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T & { error?: { code: string; message: string } }) : ({} as T & { error?: undefined });
    if (!response.ok) {
      throw new HetznerError(`Hetzner ${method} ${path}: ${parsed.error?.message ?? `HTTP ${response.status}`}`, response.status, parsed.error?.code);
    }
    return parsed;
  }

  async servers(labelSelector?: string): Promise<Server[]> {
    const query = labelSelector ? `?label_selector=${encodeURIComponent(labelSelector)}` : "";
    return (await this.call<{ servers: Server[] }>("GET", `/servers${query}`)).servers;
  }

  async server(id: number): Promise<Server | undefined> {
    try {
      return (await this.call<{ server: Server }>("GET", `/servers/${id}`)).server;
    } catch (error) {
      if (error instanceof HetznerError && error.status === 404) return undefined;
      throw error;
    }
  }

  async primaryIps(labelSelector?: string): Promise<PrimaryIp[]> {
    const query = labelSelector ? `?label_selector=${encodeURIComponent(labelSelector)}` : "";
    return (await this.call<{ primary_ips: PrimaryIp[] }>("GET", `/primary_ips${query}`)).primary_ips;
  }

  async primaryIp(id: number): Promise<PrimaryIp | undefined> {
    try {
      return (await this.call<{ primary_ip: PrimaryIp }>("GET", `/primary_ips/${id}`)).primary_ip;
    } catch (error) {
      if (error instanceof HetznerError && error.status === 404) return undefined;
      throw error;
    }
  }

  async firewalls(labelSelector?: string): Promise<Firewall[]> {
    const query = labelSelector ? `?label_selector=${encodeURIComponent(labelSelector)}` : "";
    return (await this.call<{ firewalls: Firewall[] }>("GET", `/firewalls${query}`)).firewalls;
  }

  async firewall(id: number): Promise<Firewall | undefined> {
    try {
      return (await this.call<{ firewall: Firewall }>("GET", `/firewalls/${id}`)).firewall;
    } catch (error) {
      if (error instanceof HetznerError && error.status === 404) return undefined;
      throw error;
    }
  }

  async snapshots(labelSelector: string): Promise<Image[]> {
    return (await this.call<{ images: Image[] }>("GET", `/images?type=snapshot&label_selector=${encodeURIComponent(labelSelector)}`)).images;
  }

  async serverTypes(): Promise<ServerType[]> {
    return (await this.call<{ server_types: ServerType[] }>("GET", "/server_types?per_page=50")).server_types;
  }

  async createPrimaryIpv6(name: string, location: string, labels: Labels): Promise<PrimaryIp> {
    return (await this.call<{ primary_ip: PrimaryIp }>("POST", "/primary_ips", { name, type: "ipv6", location, auto_delete: true, labels })).primary_ip;
  }

  async labelPrimaryIp(id: number, labels: Labels): Promise<void> {
    await this.call("PUT", `/primary_ips/${id}`, { labels });
  }

  async createFirewall(name: string, rules: FirewallRule[], labels: Labels): Promise<Firewall> {
    return (await this.call<{ firewall: Firewall }>("POST", "/firewalls", { name, rules, labels })).firewall;
  }

  async createServer(body: {
    name: string;
    server_type: string;
    location: string;
    image: string;
    user_data: string;
    labels: Labels;
    firewalls: { firewall: number }[];
    public_net: { enable_ipv4: boolean; enable_ipv6: boolean; ipv4?: number; ipv6?: number };
  }): Promise<{ server: Server; action: Action }> {
    // The answer also holds a root password: it is never kept or shown.
    const answer = await this.call<{ server: Server; action: Action }>("POST", "/servers", body);
    return { server: answer.server, action: answer.action };
  }

  /** The server's latest actions, newest first (`command` is e.g. "rebuild_server"). */
  async serverActions(id: number): Promise<Action[]> {
    return (await this.call<{ actions: Action[] }>("GET", `/servers/${id}/actions?sort=id:desc&per_page=25`)).actions;
  }

  async deleteServer(id: number): Promise<Action> {
    return (await this.call<{ action: Action }>("DELETE", `/servers/${id}`)).action;
  }

  async deletePrimaryIp(id: number): Promise<void> {
    await this.call("DELETE", `/primary_ips/${id}`);
  }

  async deleteFirewall(id: number): Promise<void> {
    await this.call("DELETE", `/firewalls/${id}`);
  }

  async changeServerProtection(id: number, value: boolean): Promise<Action> {
    // `delete` and `rebuild` must have the same value (verified, API spec, D65).
    return (await this.call<{ action: Action }>("POST", `/servers/${id}/actions/change_protection`, { delete: value, rebuild: value })).action;
  }

  async rebuildServer(id: number, image: string, userData: string): Promise<Action> {
    // The answer holds a root password: only the action is kept.
    return (await this.call<{ action: Action }>("POST", `/servers/${id}/actions/rebuild`, { image, user_data: userData })).action;
  }

  async waitAction(action: Action, timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let current = action;
    while (current.status === "running") {
      if (Date.now() > deadline) throw new HetznerError(`Hetzner action ${action.id} still running after ${timeoutMs / 60_000} minutes`);
      await this.sleep(2000);
      current = (await this.call<{ action: Action }>("GET", `/actions/${action.id}`)).action;
    }
    if (current.status === "error") throw new HetznerError(`Hetzner action ${action.id} failed: ${current.error?.message ?? "unknown error"}`);
  }
}

/** x86 types with at least this memory and disk, orderable here, cheapest first. */
export function orderableTypes(types: ServerType[], location: string, minimum: { memory: number; disk: number }): { name: string; hourly: number }[] {
  return types
    .filter((type) => type.architecture === "x86" && !type.deprecation && type.memory >= minimum.memory && type.disk >= minimum.disk)
    .filter((type) => type.locations?.some((entry) => entry.name === location && entry.available !== false && !entry.deprecation))
    .map((type) => ({ name: type.name, hourly: Number(type.prices.find((price) => price.location === location)?.price_hourly.gross ?? Number.NaN) }))
    .filter((type) => Number.isFinite(type.hourly))
    .sort((a, b) => a.hourly - b.hourly);
}
