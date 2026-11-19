import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { type DnsProvider, type DnsRecord, DnsError } from "./dns.js";

/**
 * OVHcloud's DNS, through its API (D49), with keys limited to GET, POST and
 * PUT on one zone. Verified (runbook section 9, used on 8 November 2026):
 * requests are signed with `$1$` + SHA-1 of
 * `secret+consumer+METHOD+URL+body+timestamp`, the timestamp from
 * `GET /auth/time`; creating a record and refreshing the zone work with
 * that scope. Calls go through curl: Node's fetch fails TLS with
 * eu.api.ovh.com (D69).
 */

export const OVH_API = "https://eu.api.ovh.com/1.0";

export interface OvhKeys {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

/** One HTTPS request; returns the status and the body. */
export type Transport = (method: string, url: string, headers: Record<string, string>, body: string) => { status: number; body: string };

/** The link that creates keys with exactly the rights bivy needs (D49). */
export function ovhKeysLink(zone: string): string {
  const path = encodeURIComponent(`/domain/zone/${zone}/*`);
  return `https://api.eu.ovhcloud.com/createToken/?GET=${path}&POST=${path}&PUT=${path}`;
}

/**
 * curl, with its whole request in a config file read from standard input:
 * the keys and the signature never appear on a command line (`ps`).
 */
export const curlTransport: Transport = (method, url, headers, body) => {
  const quote = (value: string) => {
    // One option per line: a line break in a value would add options of its own.
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new DnsError("a value sent to OVH holds a control character: refused");
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };
  const config = [
    `url = ${quote(url)}`,
    `request = ${quote(method)}`,
    ...Object.entries(headers).map(([name, value]) => `header = ${quote(`${name}: ${value}`)}`),
    ...(body ? [`data-binary = ${quote(body)}`] : []),
    "silent",
    "show-error",
    "max-time = 30",
    `write-out = "\\n%{http_code}"`,
  ].join("\n");
  const result = spawnSync("curl", ["--config", "-"], { input: config, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new DnsError(`could not reach OVH: ${result.error?.message ?? result.stderr.trim()}`);
  const lines = result.stdout.split("\n");
  return { status: Number(lines.pop()), body: lines.join("\n") };
};

export class OvhDns implements DnsProvider {
  readonly id = "ovh";
  readonly label = "OVHcloud: bivy writes the records itself";

  constructor(private readonly keys: OvhKeys, private readonly transport: Transport = curlTransport) {}

  private call<T>(method: string, path: string, payload?: unknown): T {
    const url = `${OVH_API}${path}`;
    const time = this.transport("GET", `${OVH_API}/auth/time`, {}, "");
    const timestamp = time.body.trim();
    if (time.status !== 200 || !/^\d+$/.test(timestamp)) throw new DnsError(`OVH /auth/time answered ${time.status}`);
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const { applicationKey, applicationSecret, consumerKey } = this.keys;
    const signature = `$1$${createHash("sha1").update([applicationSecret, consumerKey, method, url, body, timestamp].join("+")).digest("hex")}`;
    const answer = this.transport(method, url, {
      "X-Ovh-Application": applicationKey,
      "X-Ovh-Consumer": consumerKey,
      "X-Ovh-Timestamp": timestamp,
      "X-Ovh-Signature": signature,
      ...(body ? { "Content-Type": "application/json" } : {}),
    }, body);
    if (answer.status < 200 || answer.status >= 300) {
      let message = `HTTP ${answer.status}`;
      try {
        message = (JSON.parse(answer.body) as { message?: string }).message ?? message;
      } catch {
        // keep the status
      }
      throw new DnsError(`OVH ${method} ${path}: ${message}`);
    }
    return (answer.body ? JSON.parse(answer.body) : undefined) as T;
  }

  async check(zone: string): Promise<string[]> {
    try {
      this.call<number[]>("GET", `/domain/zone/${zone}/record?fieldType=A&subDomain=${encodeURIComponent("bivy-check")}`);
      return [];
    } catch (error) {
      return [`the OVH keys cannot read the zone ${zone} (${(error as Error).message}): create them with the link above, for this zone`];
    }
  }

  async existing(zone: string, name: string, type: string): Promise<string[]> {
    const ids = this.call<number[]>("GET", `/domain/zone/${zone}/record?fieldType=${type}&subDomain=${encodeURIComponent(name)}`);
    return ids.map((id) => this.call<{ target: string }>("GET", `/domain/zone/${zone}/record/${id}`).target);
  }

  async apply(zone: string, records: DnsRecord[]): Promise<void> {
    for (const record of records) {
      const held = await this.existing(zone, record.name, record.type);
      // OVH shows TXT values in quotes (from memory, to check at first use): compared without them.
      if (held.some((value) => value.replace(/^"|"$/g, "") === record.value)) continue;
      this.call("POST", `/domain/zone/${zone}/record`, { fieldType: record.type, subDomain: record.name, target: record.value, ttl: record.ttl });
    }
    this.call("POST", `/domain/zone/${zone}/refresh`);
  }
}
