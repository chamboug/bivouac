import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dnsProblems, propagated, relativeName, wantedRecords, type DnsProvider, type PublicDns } from "./dns.js";
import { CHECK_IMAGE, FLATCAR_KEY_FINGERPRINT, UPLOAD_IMAGE, flatcarVersion, makeFlatcarSnapshot, uploadServerType } from "./flatcar.js";
import { checkSpecs, createChecks } from "./healthchecks.js";
import { Hetzner } from "./hetzner.js";
import { OVH_API, OvhDns, curlTransport, ovhKeysLink, type Transport } from "./ovh.js";
import { HetznerProvider, platformFirewallRules } from "./server-provider.js";
import type { Asker } from "./ask.js";

type Json = Record<string, unknown>;

/** An empty Hetzner project, recording calls. */
function fakeHetzner(start: { servers?: Json[]; ips?: Json[]; images?: Json[] } = {}) {
  const calls: string[] = [];
  const state = { servers: start.servers ?? [], ips: start.ips ?? [], firewalls: [] as Json[], images: start.images ?? [{ id: 10, status: "available", architecture: "x86", disk_size: 40, labels: { os: "flatcar", "flatcar-version": "4757.2.3" } }], bodies: [] as Json[] };
  let next = 100;
  const fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace("/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    calls.push(`${method} ${path}`);
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const action = { id: next++, status: "success" };
    if (method === "GET" && path === "/servers") return reply({ servers: state.servers });
    if (method === "GET" && /^\/servers\/\d+$/.test(path)) return reply({ server: state.servers.find((entry) => `/servers/${entry.id}` === path) });
    if (method === "GET" && path === "/primary_ips") return reply({ primary_ips: state.ips });
    if (method === "GET" && path === "/firewalls") return reply({ firewalls: state.firewalls });
    if (method === "GET" && path === "/images") return reply({ images: state.images });
    if (method === "GET" && path === "/ssh_keys") return reply({ ssh_keys: [] });
    if (method === "GET" && path === "/server_types") return reply({ server_types: [
      { name: "cx23", architecture: "x86", memory: 4, disk: 40, deprecation: null, locations: [{ name: "fsn1", available: true }, { name: "hel1", available: true }], prices: [{ location: "fsn1", price_hourly: { gross: "0.01056" } }, { location: "hel1", price_hourly: { gross: "0.009" } }] },
      { name: "cx22", architecture: "x86", memory: 2, disk: 20, deprecation: null, locations: [{ name: "fsn1", available: true }], prices: [{ location: "fsn1", price_hourly: { gross: "0.005" } }] },
      { name: "cax21", architecture: "arm", memory: 8, disk: 80, deprecation: null, locations: [{ name: "fsn1", available: true }], prices: [{ location: "fsn1", price_hourly: { gross: "0.008" } }] },
    ] });
    if (method === "GET" && path.startsWith("/actions/")) return reply({ action: { id: 1, status: "success" } });
    if (method === "POST" && path === "/primary_ips") {
      const ip = { id: next++, name: body.name, type: body.type, ip: body.type === "ipv4" ? "203.0.113.10" : "2001:db8:1::/64", labels: {}, assignee_id: null, auto_delete: body.auto_delete, location: { name: body.location }, protection: { delete: false } };
      state.ips.push(ip);
      state.bodies.push(body);
      return reply({ primary_ip: ip }, 201);
    }
    if (method === "POST" && /^\/primary_ips\/\d+\/actions\/change_protection$/.test(path)) {
      const ip = state.ips.find((entry) => path.startsWith(`/primary_ips/${entry.id}/`));
      if (ip) ip.protection = { delete: body.delete };
      return reply({ action }, 201);
    }
    if (method === "POST" && path === "/firewalls") {
      const firewall = { id: next++, name: body.name, labels: {}, applied_to: [], rules: body.rules };
      state.firewalls.push(firewall);
      state.bodies.push(body);
      return reply({ firewall }, 201);
    }
    if (method === "POST" && path === "/servers") {
      const server = { id: next++, name: body.name, status: "running", labels: {}, protection: { delete: false, rebuild: false }, server_type: { name: body.server_type }, public_net: { ipv4: null, ipv6: null, firewalls: body.firewalls } };
      state.servers.push(server);
      state.bodies.push(body);
      return reply({ server, action, root_password: "never-shown" }, 201);
    }
    if (method === "POST" && /^\/servers\/\d+\/actions\/change_protection$/.test(path)) {
      const server = state.servers.find((entry) => path.startsWith(`/servers/${entry.id}/`));
      if (server) server.protection = { delete: body.delete, rebuild: body.rebuild };
      return reply({ action }, 201);
    }
    return reply({ error: { code: "not_found", message: `${method} ${path}` } }, 404);
  }) as unknown as typeof globalThis.fetch;
  return { hetzner: new Hetzner("token", fetch, async () => {}), calls, state };
}

const noFlatcar = { ask: {} as Asker, run: () => ({ status: 1, stdout: "", stderr: "" }), fetchText: async () => "", config: (name: string) => name, log: () => {} };

describe("Hetzner provider", () => {
  it("offers x86 types of at least 4 GB, cheapest location first", async () => {
    const { hetzner } = fakeHetzner();
    const offers = await new HetznerProvider(hetzner, noFlatcar, async () => {}).offers();
    expect(offers.map((offer) => [offer.location, offer.types.map((type) => type.name)])).toEqual([["hel1", ["cx23"]], ["fsn1", ["cx23"]]]);
  });

  it("refuses a project that already has a platform", async () => {
    const { hetzner } = fakeHetzner({ servers: [{ id: 1, name: "bivouac", labels: {} }] });
    expect(await new HetznerProvider(hetzner, noFlatcar, async () => {}).projectProblems()).toEqual([expect.stringContaining("bivy rebuild")]);
  });

  it("creates kept, protected addresses, the firewall and the server once, whatever the number of calls", async () => {
    const { hetzner, state } = fakeHetzner();
    const provider = new HetznerProvider(hetzner, noFlatcar, async () => {});
    const first = await provider.addresses("fsn1");
    const again = await provider.addresses("fsn1");
    expect(again).toEqual(first);
    expect(state.ips.map((ip) => [ip.name, ip.auto_delete, (ip.protection as Json).delete])).toEqual([["bivouac-ipv4", false, true], ["bivouac-ipv6", false, true]]);
    const firewall = await provider.firewall();
    expect((await provider.firewall()).id).toBe(firewall.id);
    expect(state.firewalls).toHaveLength(1);
    const request = { type: "cx23", location: "fsn1", image: 10, userData: "{}", ipv4Id: first.ipv4.id, ipv6Id: first.ipv6.id, firewallId: firewall.id };
    expect((await provider.server(request)).created).toBe(true);
    expect((await provider.server(request)).created).toBe(false);
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]?.protection).toEqual({ delete: true, rebuild: true });
    const created = state.bodies.find((body) => body.server_type === "cx23") as Json;
    expect(created.public_net).toEqual({ enable_ipv4: true, enable_ipv6: true, ipv4: first.ipv4.id, ipv6: first.ipv6.id });
    expect(created.firewalls).toEqual([{ firewall: firewall.id }]);
  });

  it("never adopts a firewall named bivouac with other rules, or already on a server", async () => {
    const { hetzner, state } = fakeHetzner();
    state.firewalls.push({ id: 7, name: "bivouac", labels: {}, applied_to: [], rules: [{ direction: "in", protocol: "tcp", port: "1-65535", source_ips: ["0.0.0.0/0"] }] });
    const provider = new HetznerProvider(hetzner, noFlatcar, async () => {});
    await expect(provider.firewall()).rejects.toThrow(/other rules/);
    state.firewalls[0] = { id: 7, name: "bivouac", labels: {}, applied_to: [{ server: { id: 9 } }], rules: platformFirewallRules() };
    await expect(provider.firewall()).rejects.toThrow(/already applied/);
  });

  it("lets in SSH and the web only, from everywhere", () => {
    expect(platformFirewallRules().map((rule) => `${rule.protocol}/${rule.port}`)).toEqual(["tcp/22", "tcp/80", "tcp/443", "udp/443"]);
  });
});

describe("Flatcar snapshot", () => {
  it("reads the version and picks a small enough server to make it", () => {
    expect(flatcarVersion("FLATCAR_BUILD=1\nFLATCAR_VERSION=4757.2.3\n")).toBe("4757.2.3");
    expect(() => flatcarVersion("<html>")).toThrow(/stable version/);
    const types = [
      { name: "cx23", architecture: "x86", memory: 4, disk: 40, deprecation: null, locations: [{ name: "fsn1" }], prices: [{ location: "fsn1", price_hourly: { gross: "0.01" } }] },
      { name: "cpx12", architecture: "x86", memory: 2, disk: 40, deprecation: null, locations: [{ name: "fsn1" }], prices: [{ location: "fsn1", price_hourly: { gross: "0.02" } }] },
      { name: "cx53", architecture: "x86", memory: 32, disk: 320, deprecation: null, locations: [{ name: "fsn1" }], prices: [{ location: "fsn1", price_hourly: { gross: "0.001" } }] },
    ];
    expect(uploadServerType(types, "fsn1", 40)).toBe("cx23");
  });

  it("checks Flatcar's signature before sending anything, and gives the tool a temporary token only", async () => {
    const { hetzner, state } = fakeHetzner({ images: [] });
    const runs: { command: string; args: string[]; env?: Record<string, string> }[] = [];
    let signed = true;
    const secrets: string[] = [];
    const deps = {
      ask: { secret: async (spec: { path: string }) => (secrets.push(spec.path), "temporary-token") } as unknown as Asker,
      hetzner,
      run: (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
        runs.push({ command, args, ...(options.env ? { env: options.env } : {}) });
        if (args.includes(CHECK_IMAGE)) return { status: 0, stdout: signed ? "signature OK\nsha512 OK\n" : "sha512 OK\n", stderr: "" };
        if (args.includes("upload")) state.images.push({ id: 11, status: "available", architecture: "x86", disk_size: 40, labels: { os: "flatcar", "flatcar-version": "4757.2.3" } });
        return { status: 0, stdout: "", stderr: "" };
      },
      fetchText: async () => "FLATCAR_VERSION=4757.2.3\n",
      config: (name: string) => `/nonexistent/${name}`,
      log: () => {},
    };
    signed = false;
    await expect(makeFlatcarSnapshot(deps, "fsn1", 40)).rejects.toThrow(/nothing was sent to Hetzner/);
    expect(runs.some((entry) => entry.args.includes(UPLOAD_IMAGE))).toBe(false);
    expect(secrets).toEqual([]);

    signed = true;
    runs.length = 0;
    const image = await makeFlatcarSnapshot(deps, "fsn1", 40);
    expect(image.id).toBe(11);
    const upload = runs.find((entry) => entry.args.includes(UPLOAD_IMAGE));
    expect(upload?.args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--image-path", "/image.bz2"]));
    expect(upload?.args.join(" ")).not.toContain("temporary-token");
    expect(upload?.args.join(" ")).not.toContain("--image-url");
    expect(upload?.env).toEqual({ HCLOUD_TOKEN: "temporary-token" });
    expect(secrets).toEqual(["/nonexistent/hetzner-token-upload"]);
    expect(runs.find((entry) => entry.args.includes(CHECK_IMAGE))?.args.join(" ")).toContain(FLATCAR_KEY_FINGERPRINT);
  });
});

describe("OVH", () => {
  it("signs every call as OVH documents it, with the keys in headers only", async () => {
    const sent: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
    const transport: Transport = (method, url, headers, body) => {
      sent.push({ method, url, headers, body });
      if (url.endsWith("/auth/time")) return { status: 200, body: "1700000000" };
      if (method === "GET" && url.includes("/record?")) return { status: 200, body: "[]" };
      return { status: 200, body: "" };
    };
    const ovh = new OvhDns({ applicationKey: "ak", applicationSecret: "as", consumerKey: "ck" }, transport);
    await ovh.apply("example.org", [{ type: "A", name: "*.apps", value: "203.0.113.10", ttl: 3600 }]);
    const post = sent.find((entry) => entry.method === "POST" && entry.url.endsWith("/record"));
    expect(post?.body).toBe('{"fieldType":"A","subDomain":"*.apps","target":"203.0.113.10","ttl":3600}');
    const expected = `$1$${createHash("sha1").update(`as+ck+POST+${OVH_API}/domain/zone/example.org/record+${post?.body}+1700000000`).digest("hex")}`;
    expect(post?.headers["X-Ovh-Signature"]).toBe(expected);
    expect(JSON.stringify(sent.map((entry) => entry.url))).not.toMatch(/ak|as|ck/);
    expect(sent.at(-1)?.url).toBe(`${OVH_API}/domain/zone/example.org/refresh`);
  });

  it("writes nothing that is already there", async () => {
    const posts: string[] = [];
    const transport: Transport = (method, url) => {
      if (url.endsWith("/auth/time")) return { status: 200, body: "1700000000" };
      if (method === "POST") posts.push(url);
      if (url.includes("/record?")) return { status: 200, body: "[7]" };
      if (url.endsWith("/record/7")) return { status: 200, body: '{"target":"\\"v=DMARC1; p=none\\""}' };
      return { status: 200, body: "" };
    };
    await new OvhDns({ applicationKey: "a", applicationSecret: "b", consumerKey: "c" }, transport).apply("example.org", [{ type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none", ttl: 3600 }]);
    expect(posts).toEqual([`${OVH_API}/domain/zone/example.org/refresh`]);
  });

  it("refuses a value that would add an option to curl's config", () => {
    expect(() => curlTransport("GET", "https://eu.api.ovh.com/1.0/auth/time", { "X-Ovh-Consumer": "ck\nurl = https://elsewhere.example" }, "")).toThrow(/control character/);
  });

  it("asks for keys limited to the zone, without DELETE (D49)", () => {
    const link = ovhKeysLink("example.org");
    expect(decodeURIComponent(link)).toBe("https://api.eu.ovhcloud.com/createToken/?GET=/domain/zone/example.org/*&POST=/domain/zone/example.org/*&PUT=/domain/zone/example.org/*");
  });
});

describe("DNS checks", () => {
  const quiet: PublicDns = { a: async () => [], aaaa: async () => [], txt: async () => [], caa: async () => [] };
  const manual: DnsProvider = { id: "manual", label: "", check: async () => [], existing: async () => undefined, apply: async () => {} };

  it("names the records relative to the zone", () => {
    expect(relativeName("apps.example.org", "example.org")).toBe("apps");
    expect(wantedRecords("example.org", "example.org", "203.0.113.10", true)).toEqual([{ type: "A", name: "*", value: "203.0.113.10", ttl: 3600 }]);
    expect(() => relativeName("apps.example.com", "example.org")).toThrow(/not in the zone/);
  });

  it("stops on a CAA record that forbids Let's Encrypt, an AAAA, or a record held elsewhere", async () => {
    expect(await dnsProblems(quiet, manual, "apps.example.org", "example.org", "203.0.113.10")).toEqual([]);
    expect(await dnsProblems({ ...quiet, caa: async (name) => (name === "example.org" ? [{ issue: "sectigo.com" }] : []) }, manual, "apps.example.org", "example.org", "203.0.113.10")).toEqual([expect.stringContaining("letsencrypt.org")]);
    expect(await dnsProblems({ ...quiet, caa: async () => [{ issue: "letsencrypt.org" }] }, manual, "apps.example.org", "example.org", "203.0.113.10")).toEqual([]);
    expect(await dnsProblems({ ...quiet, aaaa: async () => ["2001:db8::1"] }, manual, "apps.example.org", "example.org", "203.0.113.10")).toEqual([expect.stringContaining("AAAA")]);
    const held: DnsProvider = { ...manual, existing: async (_zone, _name, type) => (type === "CNAME" ? ["elsewhere.example.net"] : []) };
    expect(await dnsProblems(quiet, held, "apps.example.org", "example.org", "203.0.113.10")).toEqual([expect.stringContaining("already has CNAME")]);
  });

  it("waits until two names of the platform answer with the server's address", async () => {
    expect(await propagated({ ...quiet, a: async (name) => (name.startsWith("auth.") ? ["203.0.113.10"] : []) }, "apps.example.org", "203.0.113.10", "x")).toBe(false);
    expect(await propagated({ ...quiet, a: async () => ["203.0.113.10"] }, "apps.example.org", "203.0.113.10", "x")).toBe(true);
  });
});

describe("healthchecks.io", () => {
  it("creates the three checks of runbook section 12, once, sending to every integration", async () => {
    const bodies: Json[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("key");
      expect(url).not.toContain("key");
      bodies.push(JSON.parse(String(init.body)) as Json);
      return new Response(JSON.stringify({ ping_url: `https://hc-ping.com/${bodies.length}` }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const urls = await createChecks(fetch, "key", "apps.example.org");
    expect(urls).toEqual({ heartbeat: "https://hc-ping.com/1", backup: "https://hc-ping.com/2", restore: "https://hc-ping.com/3" });
    expect(bodies.map((body) => [body.name, body.schedule ?? body.timeout, body.grace, body.channels, body.unique])).toEqual([
      ["apps.example.org heartbeat", 300, 600, "*", ["name"]],
      ["apps.example.org backup", "0 2 * * *", 10800, "*", ["name"]],
      ["apps.example.org restore", "0 2 * * 0", 21600, "*", ["name"]],
    ]);
    expect(checkSpecs("x").every((spec) => spec.body.tz === undefined || spec.body.tz === "UTC")).toBe(true);
  });
});
