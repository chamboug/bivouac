import { type FlatcarDependencies, makeFlatcarSnapshot } from "./flatcar.js";
import { type FirewallRule, type Hetzner, orderableTypes } from "./hetzner.js";
import { newestFlatcar } from "./rebuild.js";

/**
 * Server provider contract (D93). What `bivy init` needs from wherever the
 * server runs: Hetzner only, by choice (D93: a second provider is much more
 * code and tests, for no user asking). A new one arrives by pull request,
 * with its tests, and must give the same guarantees:
 *
 *  - an x86 machine of at least 4 GB that boots Flatcar with an Ignition
 *    config as user-data (D7);
 *  - a fixed public IPv4 and IPv6 that outlive the server, so a rebuild
 *    keeps the DNS (D24);
 *  - a firewall outside the machine letting in only 22/tcp, 80/tcp,
 *    443/tcp and 443/udp, which Docker's own rules cannot bypass;
 *  - protection against a mistaken deletion of the server and its addresses;
 *  - every create call safe to repeat: it finds what an interrupted run
 *    created (by name) instead of creating a second one.
 *
 * Every resource of the platform is named `bivouac` (the IPs `bivouac-ipv4`
 * and `bivouac-ipv6`), as `bivy rebuild` expects (rebuild-real.ts).
 */

export const PLATFORM_NAME = "bivouac";
export const MINIMUM = { memory: 4, disk: 40 };

export interface Offer {
  location: string;
  types: { name: string; hourly: number; memory: number; disk: number }[];
}

export interface ServerProvider {
  /** Why this project cannot receive a new platform (one is already there): bivy init never replaces anything. */
  projectProblems(): Promise<string[]>;
  /** Where a suitable machine can be ordered now, cheapest first. */
  offers(): Promise<Offer[]>;
  /** The Flatcar image to boot, made when missing. */
  flatcarImage(location: string, serverDisk: number): Promise<{ id: number; version: string }>;
  /** The platform's fixed addresses, in that location: created, kept and protected. */
  addresses(location: string): Promise<{ ipv4: { id: number; ip: string }; ipv6: { id: number; network: string } }>;
  /** The platform's firewall. */
  firewall(): Promise<{ id: number }>;
  /** The platform's server, if there is one. */
  find(): Promise<{ id: number } | undefined>;
  /** The server, created once (only with user-data), protected, running. */
  server(request: { type: string; location: string; image: number; userData: string | undefined; ipv4Id: number; ipv6Id: number; firewallId: number }): Promise<{ id: number; created: boolean }>;
}

/** The platform's inbound rules (runbook section 6): from everywhere, nothing else, ICMP included. */
export function platformFirewallRules(): FirewallRule[] {
  const everywhere = ["0.0.0.0/0", "::/0"];
  return [
    { description: "SSH", direction: "in", protocol: "tcp", port: "22", source_ips: everywhere },
    { description: "HTTP", direction: "in", protocol: "tcp", port: "80", source_ips: everywhere },
    { description: "HTTPS", direction: "in", protocol: "tcp", port: "443", source_ips: everywhere },
    { description: "HTTP/3", direction: "in", protocol: "udp", port: "443", source_ips: everywhere },
  ];
}

export class HetznerProvider implements ServerProvider {
  constructor(private readonly hetzner: Hetzner, private readonly flatcar: Omit<FlatcarDependencies, "hetzner">, private readonly sleep: (ms: number) => Promise<void>) {}

  async projectProblems(): Promise<string[]> {
    const problems: string[] = [];
    const servers = await this.hetzner.servers();
    if (servers.some((server) => server.name === PLATFORM_NAME)) problems.push(`the project already has a server '${PLATFORM_NAME}': bring it back with 'bivy rebuild', bivy init never replaces a platform`);
    const ips = await this.hetzner.primaryIps();
    for (const ip of ips.filter((entry) => entry.name.startsWith(`${PLATFORM_NAME}-ipv`) && entry.assignee_id !== null)) problems.push(`the Primary IP ${ip.name} (${ip.ip}) is already in use by server ${ip.assignee_id}`);
    return problems;
  }

  async offers(): Promise<Offer[]> {
    const types = await this.hetzner.serverTypes();
    const locations = [...new Set(types.flatMap((type) => (type.locations ?? []).map((entry) => entry.name)))].sort();
    const sizes = new Map(types.map((type) => [type.name, type]));
    return locations
      .map((location) => ({
        location,
        types: orderableTypes(types, location, MINIMUM).map((offer) => ({ ...offer, memory: sizes.get(offer.name)?.memory ?? 0, disk: sizes.get(offer.name)?.disk ?? 0 })),
      }))
      .filter((offer) => offer.types.length > 0)
      .sort((a, b) => (a.types[0]?.hourly ?? 0) - (b.types[0]?.hourly ?? 0));
  }

  async flatcarImage(location: string, serverDisk: number): Promise<{ id: number; version: string }> {
    let image;
    try {
      image = newestFlatcar(await this.hetzner.snapshots("os=flatcar"));
      // Made earlier in this project, by whoever has access to it: said, so it is not used silently.
      this.flatcar.log(`  using the Flatcar snapshot already in the project: ${image.id} (${image.description || "no description"})`);
    } catch {
      image = await makeFlatcarSnapshot({ ...this.flatcar, hetzner: this.hetzner }, location, serverDisk);
    }
    if (image.disk_size > serverDisk) throw new Error(`the Flatcar snapshot needs a disk of ${image.disk_size} GB, more than the server's ${serverDisk} GB`);
    return { id: image.id, version: image.labels["flatcar-version"] ?? "?" };
  }

  async addresses(location: string): Promise<{ ipv4: { id: number; ip: string }; ipv6: { id: number; network: string } }> {
    const kept = async (type: "ipv4" | "ipv6") => {
      const name = `${PLATFORM_NAME}-${type}`;
      let ip = (await this.hetzner.primaryIps()).find((entry) => entry.name === name);
      if (ip && ip.location?.name !== undefined && ip.location.name !== location) throw new Error(`the Primary IP ${name} is in ${ip.location.name}, not ${location}`);
      if (ip?.auto_delete) throw new Error(`the Primary IP ${name} has auto_delete: it would go with the server (runbook section 7)`);
      ip ??= await this.hetzner.createKeptPrimaryIp(type, name, location);
      if (!ip.protection.delete) await this.hetzner.waitAction(await this.hetzner.protectPrimaryIp(ip.id));
      return ip;
    };
    const ipv4 = await kept("ipv4");
    const ipv6 = await kept("ipv6");
    return { ipv4: { id: ipv4.id, ip: ipv4.ip }, ipv6: { id: ipv6.id, network: ipv6.ip } };
  }

  async firewall(): Promise<{ id: number }> {
    const found = (await this.hetzner.firewalls()).find((entry) => entry.name === PLATFORM_NAME);
    if (found) {
      // Found again after an interruption: only if it is exactly ours, and on no other server.
      const rule = (entry: FirewallRule) => `${entry.direction} ${entry.protocol} ${entry.port} ${[...entry.source_ips].sort().join(",")}`;
      const same = JSON.stringify((found.rules ?? []).map(rule).sort()) === JSON.stringify(platformFirewallRules().map(rule).sort());
      if (!same) throw new Error(`a firewall '${PLATFORM_NAME}' already exists with other rules: look at it in the Hetzner Console (bivy never changes one it did not make)`);
      if (found.applied_to.length > 0) throw new Error(`the firewall '${PLATFORM_NAME}' is already applied to a server`);
      return { id: found.id };
    }
    return { id: (await this.hetzner.createFirewall(PLATFORM_NAME, platformFirewallRules(), {})).id };
  }

  async find(): Promise<{ id: number } | undefined> {
    const server = (await this.hetzner.servers()).find((entry) => entry.name === PLATFORM_NAME);
    return server ? { id: server.id } : undefined;
  }

  async server(request: { type: string; location: string; image: number; userData: string | undefined; ipv4Id: number; ipv6Id: number; firewallId: number }): Promise<{ id: number; created: boolean }> {
    const existing = await this.find();
    let id: number;
    let created = false;
    if (existing) id = existing.id;
    else if (!request.userData) throw new Error("no server to find, and no Ignition config to create one with");
    else {
      const { server, action } = await this.hetzner.createServer({
        name: PLATFORM_NAME,
        server_type: request.type,
        location: request.location,
        image: String(request.image),
        user_data: request.userData,
        labels: {},
        firewalls: [{ firewall: request.firewallId }],
        public_net: { enable_ipv4: true, enable_ipv6: true, ipv4: request.ipv4Id, ipv6: request.ipv6Id },
      });
      id = server.id;
      created = true;
      await this.hetzner.waitAction(action);
    }
    for (let attempt = 0; (await this.hetzner.server(id))?.status !== "running"; attempt++) {
      if (attempt > 60) throw new Error(`server ${id} is not running after 10 minutes`);
      await this.sleep(10_000);
    }
    const server = await this.hetzner.server(id);
    if (server && !server.protection.delete) await this.hetzner.waitAction(await this.hetzner.changeServerProtection(id, true));
    return { id, created };
  }
}
