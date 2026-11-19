import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appManifestSchema } from "@bivouac/manifest";
import { GitHub } from "./github.js";
import { Hetzner } from "./hetzner.js";
import { HOST_KEY_PATH, secretsIn } from "./hostkey.js";
import { RebuildError, TEST_LABEL, cleanup, copyChoices, printable, shownDate, instanceIdentity, jsonLines, newestFlatcar, rebuildTest, testFirewallRules, testServerChoices, unfinishedTest, type RebuildDependencies } from "./rebuild.js";
import { scripted } from "./scripted-guide.js";
import type { CommandOutput, Remote } from "./remote.js";

type Json = Record<string, unknown>;

/** An in-memory Hetzner project, answering the calls `bivy` makes. */
class FakeHetzner {
  calls: string[] = [];
  nextId = 1000;
  servers: Json[] = [];
  ips: Json[] = [];
  firewalls: Json[] = [];

  constructor() {
    // The real platform: protected, unlabelled. It must survive everything.
    this.servers.push({ id: 1, name: "bivouac", status: "running", labels: {}, protection: { delete: true, rebuild: true }, server_type: { name: "cx23" }, public_net: { ipv4: { id: 2, ip: "203.0.113.10" }, ipv6: { id: 3, ip: "2001:db8:1::/64" }, firewalls: [{ id: 4 }] } });
    this.ips.push({ id: 2, type: "ipv4", ip: "203.0.113.10", labels: {}, assignee_id: 1, auto_delete: false, protection: { delete: true } });
    this.ips.push({ id: 3, type: "ipv6", ip: "2001:db8:1::/64", labels: {}, assignee_id: 1, auto_delete: false, protection: { delete: true } });
    this.firewalls.push({ id: 4, name: "bivouac", labels: {}, applied_to: [{ server: { id: 1 } }] });
  }

  private select(items: Json[], url: URL): Json[] {
    const selector = url.searchParams.get("label_selector");
    if (!selector) return items;
    return items.filter((item) => selector in (item.labels as Json));
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    this.calls.push(`${method} ${path}`);
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    const action = { id: this.nextId++, status: "success" };
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/images") return reply(200, { images: [
      { id: 10, description: "flatcar-stable-4757.2.3", status: "available", architecture: "x86", disk_size: 40, labels: { os: "flatcar", "flatcar-version": "4757.2.3" } },
      { id: 11, description: "flatcar-stable-4100.0.0", status: "available", architecture: "x86", disk_size: 40, labels: { os: "flatcar", "flatcar-version": "4100.0.0" } },
    ] });
    if (method === "GET" && path === "/server_types") return reply(200, { server_types: [
      { name: "cx23", architecture: "x86", memory: 4, disk: 40, deprecation: null, locations: [{ name: "fsn1", available: false }, { name: "hel1", available: true }], prices: [{ location: "fsn1", price_hourly: { gross: "0.01056" } }, { location: "hel1", price_hourly: { gross: "0.01056" } }] },
    ] });
    if (method === "POST" && path === "/firewalls") {
      const firewall = { id: this.nextId++, ...body, applied_to: [] };
      this.firewalls.push(firewall);
      return reply(201, { firewall });
    }
    if (method === "POST" && path === "/primary_ips") {
      const ip = { id: this.nextId++, ...body, ip: "2001:db8:99::/64", assignee_id: null, protection: { delete: false } };
      this.ips.push(ip);
      return reply(201, { primary_ip: ip });
    }
    if (method === "POST" && path === "/servers") {
      const ipv4 = { id: this.nextId++, type: "ipv4", ip: "198.51.100.7", labels: {}, assignee_id: 0, auto_delete: true, protection: { delete: false } };
      const server = { id: this.nextId++, name: body.name, status: "running", labels: body.labels, protection: { delete: false, rebuild: false }, server_type: { name: body.server_type }, public_net: { ipv4: { id: ipv4.id, ip: ipv4.ip }, ipv6: { id: (body.public_net as Json).ipv6, ip: "2001:db8:99::/64" }, firewalls: body.firewalls }, user_data: body.user_data };
      ipv4.assignee_id = server.id;
      for (const ip of this.ips) if (ip.id === (body.public_net as Json).ipv6) ip.assignee_id = server.id;
      this.ips.push(ipv4);
      this.servers.push(server);
      return reply(201, { server, action, root_password: "not-for-anyone" });
    }
    if ((match = /^\/primary_ips\/(\d+)$/.exec(path)) && method === "PUT") {
      const ip = this.ips.find((entry) => entry.id === Number(match?.[1]));
      if (ip) ip.labels = body.labels;
      return reply(200, { primary_ip: ip });
    }
    if ((match = /^\/servers\/(\d+)$/.exec(path)) && method === "DELETE") {
      const id = Number(match[1]);
      const server = this.servers.find((entry) => entry.id === id);
      if ((server?.protection as Json | undefined)?.delete) return reply(403, { error: { code: "protected", message: "server is protected" } });
      this.servers = this.servers.filter((entry) => entry.id !== id);
      this.ips = this.ips.filter((ip) => !(ip.assignee_id === id && ip.auto_delete));
      for (const ip of this.ips) if (ip.assignee_id === id) ip.assignee_id = null;
      return reply(200, { action });
    }
    if ((match = /^\/primary_ips\/(\d+)$/.exec(path)) && method === "DELETE") {
      this.ips = this.ips.filter((ip) => ip.id !== Number(match?.[1]));
      return new Response(null, { status: 204 });
    }
    if ((match = /^\/firewalls\/(\d+)$/.exec(path)) && method === "DELETE") {
      this.firewalls = this.firewalls.filter((firewall) => firewall.id !== Number(match?.[1]));
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/servers") return reply(200, { servers: this.select(this.servers, url) });
    if (method === "GET" && path === "/primary_ips") return reply(200, { primary_ips: this.select(this.ips, url) });
    if (method === "GET" && path === "/firewalls") return reply(200, { firewalls: this.select(this.firewalls, url) });
    return reply(404, { error: { code: "not_found", message: `${method} ${path}` } });
  };
}

/** GitHub's deploy keys of the instance repo. */
class FakeGitHub {
  keys: Json[] = [{ id: 7, title: "bivouac-server", key: "ssh-ed25519 AAAAreal", read_only: true }];
  fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify(this.keys), { status: 200 });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as Json;
      const key = { id: 8, ...body };
      this.keys.push(key);
      return new Response(JSON.stringify(key), { status: 201 });
    }
    const id = Number(path.split("/").pop());
    this.keys = this.keys.filter((key) => key.id !== id);
    return new Response(null, { status: 204 });
  };
}

/** The test server, seen through SSH: answers what a healthy rebuild answers. */
class FakeServer implements Remote {
  commands: string[] = [];
  inputs: string[] = [];
  restored = false;
  /** The host key sshd presents: the provisional one until the swap. */
  presented = PROVISIONAL.publicKey;
  /** The key the client's known_hosts file holds at each command. */
  knownHosts = () => "";
  run(command: string, options: { input?: string | Buffer } = {}): CommandOutput {
    // ssh refuses a server whose key is not the one known: nothing runs.
    if (!this.knownHosts().includes(this.presented.split(" ").slice(0, 2).join(" "))) return { status: 255, stdout: "", stderr: "Host key verification failed." };
    this.commands.push(command);
    if (options.input) this.inputs.push(String(options.input));
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (command.includes(`ssh-keygen -q -t ed25519 -N '' -C bivouac-server -f ${HOST_KEY_PATH}.new`)) return ok(`${OWN_KEY}\n`);
    if (command.includes(`mv -f ${HOST_KEY_PATH}.new ${HOST_KEY_PATH}`)) {
      this.presented = OWN_KEY;
      return ok("");
    }
    if (command === "sudo test -e /etc/bivouac/age.key") return { status: 1, stdout: "", stderr: "" };
    if (command.startsWith("grep -E")) return ok(firstBoot);
    if (command === "sudo cat /etc/bivouac/rebuild.json") return ok('{"mode":"test"}\n');
    if (command.includes("deploy_key.pub")) return ok("ssh-ed25519 AAAAtest bivouac-rebuild-test\n");
    if (command.includes("sha256sum /etc/bivouac/age.key")) return ok("0c1f4ca1e4fb5d6b5b2b31f7c0ab4ab9f0b4b65e2f3f6d0ed0aa8ac6fbc2f2b9  /etc/bivouac/age.key\n");
    if (command.includes("Health.Status")) return ok("healthy\n");
    if (command.includes("docker ps")) {
      return ok(this.restored
        ? "bivouac-postgres Up 9 minutes (healthy)\nbivouac-pocket-id Up 1 minute (healthy)\nbivouac-caddy Up 1 minute (healthy)\nbivouac-app-biblio Up 1 minute\n"
        : "bivouac-postgres\n");
    }
    if (command.endsWith("restore-platform --list")) return ok('{"message":"copy","id":"abcd1234","time":"2026-11-14T02:00:00Z","tags":["nightly"]}\n{"message":"copy","id":"beef5678","time":"2026-11-10T02:00:00Z","tags":["nightly"]}\n');
    if (command.endsWith("restore-platform --snapshot beef5678")) return ok('{"message":"rebuild plan","copy":"beef5678","taken":"2026-11-10T02:00:00Z","size":"4.8 GiB"}\n');
    if (command.includes("restore-platform --yes --snapshot beef5678")) {
      this.restored = true;
      return ok('{"message":"platform restored","copy":"beef5678"}\n');
    }
    if (command.endsWith("restore-platform")) return ok('{"message":"rebuild plan","copy":"abcd1234","taken":"2026-11-14T02:00:00Z","size":"4.9 GiB"}\n');
    if (command.includes("restore-platform --yes --snapshot abcd1234")) {
      this.restored = true;
      return ok('{"message":"platform restored","copy":"abcd1234"}\n');
    }
    return ok("");
  }
}

const AGE_KEY = Buffer.from("AGE-SECRET-KEY-1TESTONLY\n");
const PROVISIONAL = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprovisional\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAAprovisional bivouac-provisional" };
const OWN_KEY = "ssh-ed25519 AAAAown bivouac-server";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(overrides: Partial<RebuildDependencies> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bivy-rebuild-"));
  dirs.push(dir);
  const hetzner = new FakeHetzner();
  const github = new FakeGitHub();
  const server = new FakeServer();
  const knownHosts = join(dir, "known_hosts-rebuild-test");
  server.knownHosts = () => { try { return readFileSync(knownHosts, "utf8"); } catch { return ""; } };
  const logs: string[] = [];
  let userData = "";
  const jwks = JSON.stringify({ keys: [{ kid: "k1", n: "abc" }] });
  const deps: RebuildDependencies = {
    instance: () => ({
      platform: { domain: "apps.example.com", repository: "git@github.com:example/bivouac-platform.git", reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-abc1234" }, backup: { repository: "s3:https://s3.example.com/bucket" } },
      sshKeys: { keys: [] },
      apps: [appManifestSchema.parse({ name: "biblio", image: "ghcr.io/example/biblio:sha-1234567", groups: ["g"], database: {}, volumes: { books: "/app/uploads" } })],
    }),
    hetzner: new Hetzner("token", hetzner.fetch, async () => {}),
    github: () => new GitHub("token", "example/bivouac-platform", github.fetch),
    remote: () => server,
    scanHostKey: () => ({ line: `198.51.100.7 ${server.presented.split(" ").slice(0, 2).join(" ")}`, fingerprint: "SHA256:any" }),
    newHostKey: () => PROVISIONAL,
    publicIpv4: async () => "192.0.2.44",
    ignition: (ipv6) => {
      userData = `{"ignition":{},"ipv6":"${ipv6}"}`;
      return userData;
    },
    ageKey: () => AGE_KEY,
    probe: (_host, _address, path) => ({ status: 200, body: path.includes("jwks") ? jwks : "ok" }),
    probeReal: () => ({ status: 200, body: jwks }),
    stateFile: join(dir, "rebuild-test.json"),
    knownHosts,
    log: (message) => logs.push(message),
    sleep: async () => {},
    now: () => Date.parse("2026-11-14T09:00:00Z"),
    ...overrides,
  };
  return { deps, hetzner, github, server, logs, dir, userData: () => userData };
}

const options = { root: "/unused", keep: false };

/** The fake server reports the hash of the age key it was sent. */
function ageKeyArrives(server: FakeServer): void {
  const hash = createHash("sha256").update(AGE_KEY).digest("hex");
  const original = server.run.bind(server);
  server.run = (command, runOptions) => {
    const result = original(command, runOptions);
    return result.status === 0 && command.includes("sha256sum") ? { status: 0, stdout: `${hash}  /etc/bivouac/age.key\n`, stderr: "" } : result;
  };
}

let firstBoot = 'ID="flatcar"\nVERSION="4757.2.3"\nbivouac-dir\nactive\nmetadata-block\npermitrootlogin no\npasswordauthentication no\nkbdinteractiveauthentication no\nallowusers core\n';

describe("bivy rebuild --test (D91)", () => {
  it("creates a labelled server, open to this Mac only, with a provisional host key as the only secret of its user-data", async () => {
    const { deps, hetzner } = setup();
    // The fake server reports another age key: the run stops there.
    await expect(rebuildTest(deps, options)).rejects.toThrow(/differs/);
    const firewall = hetzner.firewalls.find((entry) => (entry.labels as Json)[TEST_LABEL]);
    expect(firewall?.rules).toEqual(testFirewallRules("192.0.2.44"));
    expect(JSON.stringify(firewall?.rules)).not.toContain("0.0.0.0/0");
    const created = hetzner.servers.find((entry) => (entry.labels as Json)[TEST_LABEL]);
    expect(created).toMatchObject({ server_type: { name: "cx23" } });
    const userData = String(created?.user_data);
    // The test server's own IPv6, never the real server's.
    expect(userData).toContain("2001:db8:99::1/64");
    expect(secretsIn(userData)).toEqual([HOST_KEY_PATH]);
    expect(userData).not.toContain("AGE-SECRET-KEY");
    expect(hetzner.ips.filter((ip) => (ip.labels as Json)[TEST_LABEL])).toHaveLength(2);
    // No protection was ever touched; the state file holds no private key.
    expect(hetzner.calls.some((call) => call.includes("change_protection") || call.includes("/actions/rebuild"))).toBe(false);
    const state = readFileSync(deps.stateFile, "utf8");
    expect(state).not.toContain("not-for-anyone");
    expect(state).not.toContain("PRIVATE KEY");
  });

  it("replaces the provisional host key before anything else is sent", async () => {
    const { deps, server } = setup();
    await expect(rebuildTest(deps, options)).rejects.toThrow(/differs/);
    const swap = server.commands.findIndex((command) => command.includes(`mv -f ${HOST_KEY_PATH}.new ${HOST_KEY_PATH}`));
    expect(swap).toBe(1);
    expect(server.commands[0]).toContain("ssh-keygen");
    // From then on, only the server's own key is known.
    expect(readFileSync(deps.knownHosts, "utf8")).toBe("198.51.100.7,2001:db8:99::1 ssh-ed25519 AAAAown\n");
    expect(server.inputs.slice(0, 1)).toEqual(['{"mode":"test"}\n']);
  });

  it("sends nothing to a server that does not present the provisional host key", async () => {
    const { deps, server } = setup();
    server.presented = "ssh-ed25519 AAAAsomeoneelse x";
    await expect(rebuildTest(deps, options)).rejects.toThrow(/does not present the host key/);
    expect(server.commands).toEqual([]);
    expect(server.inputs).toEqual([]);
  });

  it("sends nothing when the verified connection fails, even if the scan saw the right key", async () => {
    const { deps, server } = setup({ scanHostKey: () => ({ line: "198.51.100.7 ssh-ed25519 AAAAprovisional", fingerprint: "SHA256:any" }) });
    server.presented = "ssh-ed25519 AAAAimpostor x";
    await expect(rebuildTest(deps, options)).rejects.toThrow(/making the server's own host key failed/);
    expect(server.commands).toEqual([]);
  });

  it("carries on after an interruption right after the swap", async () => {
    const { deps, server } = setup();
    ageKeyArrives(server);
    const original = server.run.bind(server);
    let interrupted = false;
    server.run = (command, runOptions) => {
      const result = original(command, runOptions);
      if (!interrupted && command.includes(`mv -f ${HOST_KEY_PATH}.new`)) {
        interrupted = true;
        throw new Error("connection lost");
      }
      return result;
    };
    await expect(rebuildTest(deps, options)).rejects.toThrow(/connection lost/);
    const state = await rebuildTest(deps, options);
    expect(state.hostKey).toBe("ssh-ed25519 AAAAown");
    expect(server.commands.filter((command) => command.includes("ssh-keygen -q -t ed25519 -N '' -C bivouac-server"))).toHaveLength(1);
    expect(state.done).toContain("checks against the real platform");
  });

  it("never falls back to the provisional key once the server's own key is recorded", async () => {
    const { deps, server } = setup();
    const original = server.run.bind(server);
    let interrupted = false;
    server.run = (command, runOptions) => {
      // Cut off between recording the new key and the swap; then someone
      // holding the user-data answers with the provisional key.
      if (!interrupted && command.includes(`mv -f ${HOST_KEY_PATH}.new`)) {
        interrupted = true;
        throw new Error("connection lost");
      }
      return original(command, runOptions);
    };
    await expect(rebuildTest(deps, options)).rejects.toThrow(/connection lost/);
    const sent = server.commands.length;
    await expect(rebuildTest(deps, options)).rejects.toThrow(/does not answer with the host key recorded/);
    expect(server.commands.length).toBe(sent);
    expect(readFileSync(deps.knownHosts, "utf8")).not.toContain("AAAAprovisional");
    expect(server.inputs).toEqual([]);
  });

  it("places the marker before the deploy key and the age key", async () => {
    const { deps, server, github } = setup();
    // The age key's hash as the fake server reports it does not match: removed, and stopped.
    await expect(rebuildTest(deps, options)).rejects.toThrow(/differs/);
    expect(server.commands.at(-1)).toBe("sudo rm -f /etc/bivouac/age.key");
    const marker = server.commands.findIndex((command) => command.includes("rebuild.json.tmp"));
    const deployKey = server.commands.findIndex((command) => command.includes("deploy_key"));
    const ageKey = server.commands.findIndex((command) => command.includes("age.key.tmp"));
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(marker).toBeLessThan(deployKey);
    expect(deployKey).toBeLessThan(ageKey);
    expect(github.keys.find((key) => key.id === 8)).toMatchObject({ read_only: true });
    expect(server.commands.join("\n")).not.toContain("AGE-SECRET-KEY");
  });

  it("goes through to the checks when the age key arrives intact", async () => {
    const { deps, server, logs } = setup();
    ageKeyArrives(server);
    const state = await rebuildTest(deps, options);
    expect(state.done).toContain("checks against the real platform");
    expect(logs).toContain("  the server replaced its provisional host key");
    expect(logs).toContain("  Pocket ID publishes the same signing keys as the real server");
  });

  it("stops before the marker when sshd would accept passwords", async () => {
    const saved = firstBoot;
    firstBoot = saved.replace("passwordauthentication no", "passwordauthentication yes");
    try {
      const { deps, server } = setup();
      ageKeyArrives(server);
      await expect(rebuildTest(deps, options)).rejects.toThrow(/sshd does not apply 'passwordauthentication no'/);
    } finally {
      firstBoot = saved;
    }
  });

  it("refuses a Pocket ID that does not publish the real signing keys", async () => {
    const { deps, server } = setup({ probeReal: () => ({ status: 200, body: JSON.stringify({ keys: [{ kid: "other", n: "xyz" }] }) }) });
    ageKeyArrives(server);
    await expect(rebuildTest(deps, options)).rejects.toThrow(/signing keys/);
  });

  it("cleans up only what carries the test label, and never the real platform", async () => {
    const { deps, hetzner, github } = setup();
    await expect(rebuildTest(deps, options)).rejects.toThrow(RebuildError);
    // A protected server wrongly labelled is still left alone.
    (hetzner.servers[0]?.labels as Json)[TEST_LABEL] = "intruder";
    const problems = await cleanup(deps, true);
    expect(problems).toEqual(["server 1 (bivouac) left alone: not a test server", "still there: server bivouac"]);
    expect(hetzner.servers.map((server) => server.id)).toEqual([1]);
    expect(hetzner.ips.map((ip) => ip.id)).toEqual([2, 3]);
    expect(hetzner.firewalls.map((firewall) => firewall.id)).toEqual([4]);
    expect(github.keys.map((key) => key.id)).toEqual([7]);
    expect(hetzner.calls.filter((call) => call.startsWith("DELETE")).every((call) => !/\/(1|2|3|4)$/.test(call))).toBe(true);
  });

  it("forgets the run once everything is gone", async () => {
    const { deps } = setup();
    await expect(rebuildTest(deps, options)).rejects.toThrow(RebuildError);
    expect(await cleanup(deps, true)).toEqual([]);
    expect(() => readFileSync(deps.stateFile)).toThrow();
    expect(() => readFileSync(deps.knownHosts)).toThrow();
  });
});

describe("what is sent to the test server", () => {
  const ours = `age1${"q".repeat(58)}`;
  const other = `age1${"z".repeat(58)}`;
  const file = `# created: 2026\n# public key: ${other}\nAGE-SECRET-KEY-1OTHER\n# public key: ${ours}\nAGE-SECRET-KEY-1OURS\n`;

  it("only the age identity of the instance's secrets, not the whole key file", () => {
    expect(instanceIdentity(file, `creation_rules:\n  - age: ${ours}\n`).toString()).toBe(`# public key: ${ours}\nAGE-SECRET-KEY-1OURS\n`);
    expect(() => instanceIdentity(file, `creation_rules:\n  - age: age1${"x".repeat(58)}\n`)).toThrow(/no key for the recipients/);
  });

  it("a firewall for one IPv4 only", () => {
    expect(() => testFirewallRules("300.1.1.1")).toThrow(/not an IPv4/);
    expect(() => testFirewallRules("0.0.0.0/0")).toThrow(/not an IPv4/);
    expect(() => testFirewallRules("<html>")).toThrow(/not an IPv4/);
  });
});

describe("Flatcar snapshot", () => {
  it("takes the highest version", () => {
    const image = (id: number, version: string) => ({ id, description: "", status: "available", architecture: "x86", disk_size: 40, labels: { os: "flatcar", "flatcar-version": version } });
    expect(newestFlatcar([image(1, "4757.2.3"), image(2, "4757.10.0"), image(3, "999.0.0")]).id).toBe(2);
    expect(() => newestFlatcar([])).toThrow(/no Flatcar snapshot/);
  });
});

describe("bivy rebuild --test, guided (D93)", () => {
  it("asks where the test server goes, which data, then for consent, and shows each step in a sentence", async () => {
    const { deps, server, hetzner } = setup();
    ageKeyArrives(server);
    const { guide, questions } = scripted((message, choices) => (message === "Which data should come back?" ? "older" : message === "Which copy should come back?" ? "beef5678" : message.startsWith("Rent") ? true : choices[0]?.value));
    const shown: string[] = [];
    deps.guide = guide;
    deps.progress = { start: (sentence) => shown.push(`start ${sentence}`), stop: (sentence) => shown.push(`stop ${sentence}`), fail: (sentence) => shown.push(`fail ${sentence}`) };
    let prepared = 0;
    deps.prepareAgeKey = async () => {
      prepared++;
    };
    const state = await rebuildTest(deps, options);
    expect(questions.map((question) => question.message.split(" ").slice(0, 3).join(" "))).toEqual(["Where should the", "Which data should", "Rent a cx23", "Which copy should"]);
    expect(questions[0]?.choices).toEqual([{ value: "hel1/cx23", label: "cx23 in hel1 (Helsinki), €0.01056/hour (recommended)" }]);
    expect(questions[2]?.message).toMatch(/notifications twice/);
    expect(prepared).toBe(1);
    expect(state).toMatchObject({ location: "hel1", serverType: "cx23", snapshot: "beef5678" });
    expect(server.commands.some((command) => command.includes("restore-platform --yes --snapshot beef5678"))).toBe(true);
    expect(shown).toContain("start Renting the test server");
    expect(shown).toContain("stop Bringing the data back from the backup (a minute or more)");
    expect(hetzner.servers.some((entry) => (entry.labels as Json)[TEST_LABEL])).toBe(true);
  });

  it("rents nothing without consent, or when the age key is wrong", async () => {
    const { deps, hetzner } = setup();
    deps.guide = scripted((message, choices) => (message.startsWith("Rent") ? false : choices[0]?.value)).guide;
    await expect(rebuildTest(deps, options)).rejects.toThrow(/nothing was rented/);
    deps.guide = scripted((message, choices) => (message.startsWith("Rent") ? true : choices[0]?.value)).guide;
    deps.prepareAgeKey = async () => {
      throw new RebuildError("this age key is not the one the instance's secrets are encrypted for");
    };
    await expect(rebuildTest(deps, options)).rejects.toThrow(/not the one/);
    expect(hetzner.calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
    expect(() => readFileSync(deps.stateFile)).toThrow();
  });

  it("--yes, --location and --snapshot answer the questions", async () => {
    const { deps, server } = setup();
    ageKeyArrives(server);
    const { guide, questions } = scripted(() => undefined);
    deps.guide = guide;
    const state = await rebuildTest(deps, { ...options, yes: true, location: "hel1", snapshot: "beef5678" });
    expect(questions).toEqual([]);
    expect(state.snapshot).toBe("beef5678");
    await expect(rebuildTest(setup().deps, { ...options, snapshot: "../x" })).rejects.toThrow(/not a backup copy ID/);
  });

  it("an unfinished test: carried on without a terminal, a choice with one", async () => {
    const { deps } = setup();
    expect(await unfinishedTest(deps)).toBe("none");
    await expect(rebuildTest(deps, options)).rejects.toThrow(RebuildError);
    expect(await unfinishedTest(deps)).toBe("carry on");
    const { guide, questions } = scripted(() => "clean up");
    expect(await unfinishedTest({ ...deps, guide })).toBe("clean up");
    expect(questions[0]?.choices.map((choice) => choice.value)).toEqual(["carry on", "clean up", "quit"]);
    expect(questions[0]?.message).toMatch(/billed/);
  });

  it("offers the wanted type where it can be ordered first, then the cheapest others", () => {
    const type = (name: string, hourly: string, locations: string[]) => ({ name, architecture: "x86", memory: 4, disk: 40, deprecation: null, locations: locations.map((location) => ({ name: location, available: true })), prices: locations.map((location) => ({ location, price_hourly: { gross: hourly } })) });
    const choices = testServerChoices([type("cpx22", "0.03", ["fsn1"]), type("cx23", "0.01", ["nbg1"]), type("cx33", "0.02", ["fsn1", "nbg1"])], "cx23", ["fsn1", "nbg1", "hel1"]);
    expect(choices.map((choice) => choice.value)).toEqual(["nbg1/cx23", "fsn1/cx33", "nbg1/cx33", "fsn1/cpx22"]);
    expect(choices[0]?.label).toMatch(/recommended/);
  });

  it("lists backup copies newest first, saying which are incomplete, and drops odd IDs", () => {
    const lines = jsonLines([
      '{"message":"copy","id":"aaaa1111","time":"2026-11-01T02:00:00Z","tags":["nightly"]}',
      '{"message":"copy","id":"bbbb2222","time":"2026-11-03T02:00:00Z","tags":["incomplete"]}',
      '{"message":"copy","id":"; rm -rf","time":"2026-11-04T02:00:00Z","tags":[]}',
      '{"message":"copy","id":"cccc3333","time":"2026-10-30T02:00:00Z","tags":["\\u001b[2Jlatest"]}',
      '{"message":"rebuild plan","copy":"aaaa1111"}',
    ].join("\n"));
    expect(copyChoices(lines)).toEqual([
      { value: "bbbb2222", label: "2026-11-03 02:00 UTC (bbbb2222)", hint: "incomplete: something is missing from it" },
      { value: "aaaa1111", label: "2026-11-01 02:00 UTC (aaaa1111)" },
      { value: "cccc3333", label: "2026-10-30 02:00 UTC (cccc3333)", hint: "?[2Jlatest" },
    ]);
  });

  it("shows text from the server or a state file without control characters", () => {
    expect(printable("4.9 GiB\u001b[1A\r")).toBe("4.9 GiB?[1A?");
    expect(shownDate("2026-11-14T09:05:00Z")).toBe("2026-11-14 09:05 UTC");
    expect(shownDate("not a date\u0007")).toBe("not a date?");
  });
});
