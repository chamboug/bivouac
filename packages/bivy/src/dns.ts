import { Resolver } from "node:dns/promises";

/**
 * DNS provider contract (D93). `bivy` needs few records: the wildcard
 * `*.<platform domain>` pointing to the Primary IPv4 (D13; never an AAAA,
 * D67) and, when the zone has none, a DMARC record `p=none` (D70).
 *
 * A provider:
 *  - `check`: proves it can act on the zone, changing nothing;
 *  - `existing`: reads a name's records as the provider holds them, or
 *    says it cannot (`undefined`), in which case bivy reads public DNS;
 *  - `apply`: makes the records exist. One that cannot write (manual)
 *    tells the person what to create and returns.
 * In every case bivy then waits until public resolvers answer, and never
 * deletes or changes a record it did not create (D49: no DELETE right).
 *
 * New providers arrive by pull request into this monorepo, with their tests
 * (D93), never as modules loaded at run time.
 */

export interface DnsRecord {
  type: "A" | "TXT";
  /** Relative to the zone: `*.apps`, `_dmarc`; "" for the zone itself. */
  name: string;
  value: string;
  ttl: number;
}

export interface DnsProvider {
  readonly id: string;
  readonly label: string;
  check(zone: string): Promise<string[]>;
  existing(zone: string, name: string, type: DnsRecord["type"] | "AAAA" | "CNAME"): Promise<string[] | undefined>;
  apply(zone: string, records: DnsRecord[]): Promise<void>;
}

export class DnsError extends Error {}

/** `apps.example.org` in `example.org` → `apps`; the zone itself → "". */
export function relativeName(name: string, zone: string): string {
  if (name === zone) return "";
  if (!name.endsWith(`.${zone}`)) throw new DnsError(`${name} is not in the zone ${zone}`);
  return name.slice(0, -zone.length - 1);
}

export const fqdn = (name: string, zone: string) => (name ? `${name}.${zone}` : zone);

/** What the platform needs, given whether the zone already has a DMARC record. */
export function wantedRecords(platformDomain: string, zone: string, ipv4: string, hasDmarc: boolean): DnsRecord[] {
  const sub = relativeName(platformDomain, zone);
  return [
    { type: "A", name: sub ? `*.${sub}` : "*", value: ipv4, ttl: 3600 },
    ...(hasDmarc ? [] : [{ type: "TXT" as const, name: "_dmarc", value: "v=DMARC1; p=none", ttl: 3600 }]),
  ];
}

/** Public DNS, read through well-known resolvers rather than the Mac's own cache. */
export interface PublicDns {
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  txt(name: string): Promise<string[]>;
  caa(name: string): Promise<{ issue?: string; issuewild?: string }[]>;
}

export function publicDns(servers = ["1.1.1.1", "8.8.8.8"]): PublicDns {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers(servers);
  const none = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw error;
  };
  return {
    a: (name) => resolver.resolve4(name).catch(none),
    aaaa: (name) => resolver.resolve6(name).catch(none),
    txt: async (name) => (await resolver.resolveTxt(name).catch(none)).map((parts) => parts.join("")),
    caa: async (name) => (await resolver.resolveCaa(name).catch(none)).map((record) => ({
      ...(record.issue !== undefined ? { issue: record.issue } : {}),
      ...(record.issuewild !== undefined ? { issuewild: record.issuewild } : {}),
    })),
  };
}

/**
 * What would stop the DNS step, read before anything is written: a name of
 * the platform already pointing elsewhere, an AAAA (D67), a CAA record that
 * does not allow Let's Encrypt (Caddy's certificates).
 */
export async function dnsProblems(dns: PublicDns, provider: DnsProvider, platformDomain: string, zone: string, ipv4: string): Promise<string[]> {
  const problems: string[] = [];
  const sub = relativeName(platformDomain, zone);
  const wildcard = sub ? `*.${sub}` : "*";
  for (const type of ["A", "AAAA", "CNAME"] as const) {
    const held = await provider.existing(zone, wildcard, type);
    if (held === undefined) continue;
    const other = held.filter((value) => !(type === "A" && value === ipv4));
    if (other.length > 0) problems.push(`${fqdn(wildcard, zone)} already has ${type} ${other.join(", ")}: remove it first, or choose another platform domain`);
  }
  const probe = `auth.${platformDomain}`;
  const seen = await dns.a(probe);
  if (seen.some((address) => address !== ipv4)) problems.push(`${probe} already resolves to ${seen.join(", ")}: another record covers it`);
  if ((await dns.aaaa(probe)).length > 0) problems.push(`${probe} has an IPv6 (AAAA) address: the platform answers over IPv4 only (D67)`);
  // CAA applies from the closest name that has one, up to the zone.
  const labels = platformDomain.split(".");
  for (let index = 0; index < labels.length - 1; index++) {
    const name = labels.slice(index).join(".");
    const caa = await dns.caa(name);
    if (caa.length === 0) continue;
    const issuers = caa.flatMap((record) => [record.issue, record.issuewild]).filter((value): value is string => value !== undefined);
    if (!issuers.some((issuer) => issuer.split(";")[0]?.trim() === "letsencrypt.org")) {
      problems.push(`${name} has CAA records that do not allow letsencrypt.org: Caddy could not get certificates`);
    }
    break;
  }
  return problems;
}

/** Waits until public resolvers give the server's IPv4 for two names of the platform. */
export async function propagated(dns: PublicDns, platformDomain: string, ipv4: string, label: string): Promise<boolean> {
  const names = [`auth.${platformDomain}`, `${label}.${platformDomain}`];
  for (const name of names) if (!(await dns.a(name)).includes(ipv4)) return false;
  return true;
}

/** The "manual" provider: prints the records, for any registrar. */
export class ManualDns implements DnsProvider {
  readonly id = "manual";
  readonly label = "Manual: bivy shows the records, you create them at your DNS provider";
  constructor(private readonly log: (message: string) => void) {}

  async check(): Promise<string[]> {
    return [];
  }

  async existing(): Promise<undefined> {
    return undefined;
  }

  async apply(zone: string, records: DnsRecord[]): Promise<void> {
    this.log([
      `  ▶ Create these records in the zone ${zone}, at your DNS provider:`,
      ...records.map((record) => `      ${fqdn(record.name, zone).padEnd(32)} ${record.type.padEnd(4)} ${record.ttl}  ${record.type === "TXT" ? `"${record.value}"` : record.value}`),
      "    No AAAA record (IPv4 only, D67). bivy waits until public DNS answers (up to an hour)…",
    ].join("\n"));
  }
}
