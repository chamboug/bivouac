import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appManifestSchema } from "@bivouac/manifest";
import { Hetzner } from "./hetzner.js";
import { HOST_KEY_PATH, secretsIn } from "./hostkey.js";
import { spawnSync } from "node:child_process";
import { checkoutProblems, rebuildReal, type RealDependencies, type RealState, type RebuildPlan } from "./rebuild-real.js";
import type { CommandOutput, Remote } from "./remote.js";

type Json = Record<string, unknown>;

const OLD_KEY = "ssh-ed25519 AAAAold";
const PROVISIONAL = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprovisional\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAAprovisional bivouac-provisional" };
const OWN_KEY = "ssh-ed25519 AAAAown bivouac-server";
const AGE_KEY = Buffer.from("AGE-SECRET-KEY-1TESTONLY\n");
const JWKS = JSON.stringify({ keys: [{ kid: "k1", n: "abc" }] });

/** A Hetzner project holding the real platform. */
class FakeHetzner {
  calls: string[] = [];
  nextId = 1000;
  failRebuild = false;
  failStatus = 500;
  loseAnswer = false;
  killOnRebuild = false;
  actions: Json[] = [];
  servers: Json[] = [{ id: 1, name: "bivouac", status: "running", labels: {}, location: { name: "fsn1" }, protection: { delete: true, rebuild: true }, server_type: { name: "cx23" }, public_net: { ipv4: { id: 2, ip: "203.0.113.10" }, ipv6: { id: 3, ip: "2001:db8:1::/64" }, firewalls: [{ id: 4 }] } }];
  ips: Json[] = [
    { id: 2, type: "ipv4", ip: "203.0.113.10", labels: {}, assignee_id: 1, auto_delete: false, location: { name: "fsn1" }, protection: { delete: true } },
    { id: 3, type: "ipv6", ip: "2001:db8:1::/64", labels: {}, assignee_id: 1, auto_delete: false, location: { name: "fsn1" }, protection: { delete: true } },
  ];
  firewalls: Json[] = [{ id: 4, name: "bivouac", labels: {}, applied_to: [{ server: { id: 1 } }] }];
  userData = "";
  onNewSystem: () => void = () => {};

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    this.calls.push(`${method} ${path}${method === "POST" && path.includes("change_protection") ? ` ${String(body.delete)}` : ""}`);
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    const action = { id: this.nextId++, status: "success" };
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/images") return reply(200, { images: [{ id: 10, description: "flatcar", status: "available", architecture: "x86", disk_size: 40, labels: { os: "flatcar", "flatcar-version": "4757.2.3" } }] });
    if (method === "GET" && path === "/server_types") return reply(200, { server_types: [
      { name: "cx23", architecture: "x86", memory: 4, disk: 40, deprecation: null, locations: [{ name: "fsn1", available: false }], prices: [{ location: "fsn1", price_hourly: { gross: "0.01056" } }] },
      { name: "cpx22", architecture: "x86", memory: 4, disk: 80, deprecation: null, locations: [{ name: "fsn1", available: true }], prices: [{ location: "fsn1", price_hourly: { gross: "0.03744" } }] },
    ] });
    if (method === "GET" && path === "/servers") return reply(200, { servers: this.servers });
    if (method === "GET" && path === "/primary_ips") return reply(200, { primary_ips: this.ips });
    if (method === "GET" && path === "/firewalls") return reply(200, { firewalls: this.firewalls });
    if ((match = /^\/servers\/(\d+)$/.exec(path)) && method === "GET") {
      const server = this.servers.find((entry) => entry.id === Number(match?.[1]));
      return server ? reply(200, { server }) : reply(404, { error: { code: "not_found", message: "no" } });
    }
    if (/^\/servers\/\d+\/actions$/.test(path) && method === "GET") return reply(200, { actions: this.actions });
    if (/^\/actions\/\d+$/.test(path) && method === "GET") return reply(200, { action: { id: 1, status: "success" } });
    if ((match = /^\/servers\/(\d+)\/actions\/change_protection$/.exec(path))) {
      const server = this.servers.find((entry) => entry.id === Number(match?.[1]));
      if (server) server.protection = { delete: body.delete, rebuild: body.rebuild };
      return reply(201, { action });
    }
    if ((match = /^\/servers\/(\d+)\/actions\/rebuild$/.exec(path))) {
      const server = this.servers.find((entry) => entry.id === Number(match?.[1]));
      if ((server?.protection as Json).rebuild) return reply(403, { error: { code: "protected", message: "protected" } });
      if (this.killOnRebuild) throw new Error("killed");
      if (this.failRebuild) return reply(this.failStatus, { error: { code: "server_error", message: "boom" } });
      this.userData = String(body.user_data);
      this.onNewSystem();
      this.actions.unshift({ id: action.id, command: "rebuild_server", status: "success" });
      if (this.loseAnswer) throw new TypeError("fetch failed");
      return reply(201, { action, root_password: "not-for-anyone" });
    }
    if (method === "POST" && path === "/servers") {
      const server = { id: this.nextId++, name: body.name, status: "running", labels: body.labels, location: { name: body.location }, protection: { delete: false, rebuild: false }, server_type: { name: body.server_type }, public_net: { ipv4: { id: 2, ip: "203.0.113.10" }, ipv6: { id: 3, ip: "2001:db8:1::/64" }, firewalls: body.firewalls }, body };
      this.servers.push(server);
      this.userData = String(body.user_data);
      this.onNewSystem();
      return reply(201, { server, action, root_password: "not-for-anyone" });
    }
    return reply(404, { error: { code: "not_found", message: `${method} ${path}` } });
  };
}

/** The server at the Primary IPv4: the old system, then the rebuilt one. */
class FakeServer implements Remote {
  commands: string[] = [];
  presented = OLD_KEY;
  rebuilt = false;
  restored = false;
  deployKeyAdded = false;
  deployKeyWritable = false;
  receivePackFails = false;
  /** What the old server's next backup does. */
  backupOutcome: "success" | "failure" = "success";
  lastSuccessAt = Date.parse("2026-11-14T01:01:00Z");
  lastAttemptAt = Date.parse("2026-11-14T01:00:50Z");
  lastError: string | undefined;
  backupAsked = false;
  reachable = true;
  knownHosts = () => "";
  run(command: string): CommandOutput {
    if (!this.reachable) return { status: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" };
    if (!this.knownHosts().includes(this.presented.split(" ").slice(0, 2).join(" "))) return { status: 255, stdout: "", stderr: "Host key verification failed." };
    this.commands.push(command);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (!this.rebuilt) {
      if (command.includes("jq -c")) {
        this.backupAsked = true;
        // The server's clock, unrelated to the Mac's: an hour behind here.
        this.lastAttemptAt = Math.max(this.lastAttemptAt, Date.parse("2026-11-14T08:05:00Z")) + 60_000;
        if (this.backupOutcome === "success") this.lastSuccessAt = this.lastAttemptAt + 30_000;
        else this.lastError = "restic: bucket not found";
        return ok("");
      }
      if (command.includes("state.json")) return ok(`${JSON.stringify({ lastSuccessAt: this.lastSuccessAt, lastAttemptAt: this.lastAttemptAt, ...(this.lastError ? { lastError: this.lastError } : {}) })}\n`);
      return ok("");
    }
    if (command.includes(`-f ${HOST_KEY_PATH}.new`) && command.includes("ssh-keygen")) return ok(`${OWN_KEY}\n`);
    if (command.includes(`mv -f ${HOST_KEY_PATH}.new ${HOST_KEY_PATH}`)) {
      this.presented = OWN_KEY;
      return ok("");
    }
    if (command === "sudo test -e /etc/bivouac/age.key") return { status: 1, stdout: "", stderr: "" };
    if (command.startsWith("grep -E")) return ok('ID="flatcar"\nbivouac-dir\nactive\nmetadata-block\n');
    if (command === "sudo cat /etc/bivouac/rebuild.json") return ok('{"mode":"rebuild"}\n');
    if (command.includes("deploy_key.pub")) return ok("ssh-ed25519 AAAAdeploy bivouac-server-x\n");
    if (command.includes("sha256sum /etc/bivouac/age.key")) return ok(`${createHash("sha256").update(AGE_KEY).digest("hex")}  /etc/bivouac/age.key\n`);
    if (command.includes("ls-remote")) {
      // The owner adds the key after a while.
      if (!this.deployKeyAdded) {
        this.deployKeyAdded = true;
        return { status: 128, stdout: "", stderr: "Permission denied (publickey)." };
      }
      return ok("abc\trefs/heads/main\n");
    }
    if (command.includes("git-receive-pack")) {
      if (this.receivePackFails) return ok("Unable to find image locally\ndocker: error pulling image\n");
      return ok(this.deployKeyWritable ? `00a1${"a".repeat(40)} refs/heads/main\0report-status delete-refs\n0000\n` : "ERROR: The key you are authenticating with has been marked as read only.\n");
    }
    if (command.includes("Health.Status")) return ok("healthy\n");
    if (command.includes("docker ps")) return ok(this.restored ? "bivouac-pocket-id Up 1 minute (healthy)\nbivouac-caddy Up 1 minute (healthy)\nbivouac-app-biblio Up 1 minute\n" : "bivouac-postgres\n");
    if (command.endsWith("restore-platform")) return ok('{"message":"rebuild plan","copy":"abcd1234","taken":"2026-11-14T09:05:00Z","size":"4.9 GiB"}\n');
    if (command.includes("restore-platform --yes")) {
      this.restored = true;
      return ok('{"message":"platform restored"}\n');
    }
    return ok("");
  }
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(overrides: Partial<RealDependencies> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bivy-real-"));
  dirs.push(dir);
  const hetzner = new FakeHetzner();
  const server = new FakeServer();
  const knownHosts = join(dir, "known_hosts");
  writeFileSync(knownHosts, `203.0.113.10,2001:db8:1::1 ${OLD_KEY}\n`, { mode: 0o600 });
  server.knownHosts = () => (existsSync(knownHosts) ? readFileSync(knownHosts, "utf8") : "");
  hetzner.onNewSystem = () => {
    server.rebuilt = true;
    server.presented = PROVISIONAL.publicKey;
  };
  const logs: string[] = [];
  const asked: string[] = [];
  let clock = Date.parse("2026-11-14T09:00:00Z");
  const deps: RealDependencies = {
    instance: () => ({
      platform: { domain: "apps.example.com", repository: "git@github.com:example/bivouac-platform.git", reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-abc1234" }, backup: { repository: "s3:https://s3.example.com/bucket" } },
      sshKeys: { keys: [] },
      apps: [appManifestSchema.parse({ name: "biblio", image: "ghcr.io/example/biblio:sha-1234567", groups: ["g"], database: {}, volumes: { books: "/app/uploads" } })],
    }),
    hetzner: new Hetzner("token", hetzner.fetch, async () => {}),
    remote: () => server,
    scanHostKey: () => ({ line: `203.0.113.10 ${server.presented.split(" ").slice(0, 2).join(" ")}`, fingerprint: "SHA256:any" }),
    newHostKey: () => PROVISIONAL,
    ignition: (ipv6) => `{"ignition":{},"ipv6":"${ipv6}"}`,
    ageKey: () => AGE_KEY,
    probeReal: () => ({ status: 200, body: JSON.stringify({ keys: [{ kid: "k1", n: "abc" }] }) }),
    resolve: async () => ["203.0.113.10"],
    ask: async (question) => {
      asked.push(question);
      return "apps.example.com";
    },
    stateFile: join(dir, "rebuild.json"),
    knownHosts,
    log: (message) => logs.push(message),
    sleep: async () => {
      clock += 10_000;
    },
    now: () => clock,
    ...overrides,
  };
  return { deps, hetzner, server, logs, asked, dir };
}

const options = { root: "/unused", plan: false, withoutFreshBackup: false };
const writes = (hetzner: FakeHetzner) => hetzner.calls.filter((call) => !call.startsWith("GET"));

describe("bivy rebuild --plan (D91)", () => {
  it("only reads, and plans a rebuild in place on the same IPs", async () => {
    const { deps, hetzner, server, asked } = setup();
    const plan = (await rebuildReal(deps, { ...options, plan: true })) as RebuildPlan;
    expect(plan).toMatchObject({ kind: "in place", serverType: "cx23", location: "fsn1", ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8:1::/64" }, problems: [] });
    expect(writes(hetzner)).toEqual([]);
    expect(server.commands.every((command) => !/systemctl|jq|rm |mv |tee|>/.test(command.replace(/2>&1|>&2/g, "").replace(/; echo; sudo test.*$/, "")))).toBe(true);
    expect(asked).toEqual([]);
    expect(existsSync(deps.stateFile)).toBe(false);
  });

  it("stops on DNS pointing elsewhere, an IP that would be deleted, or a missing firewall", async () => {
    const { deps, hetzner } = setup({ resolve: async () => ["198.51.100.1"] });
    (hetzner.ips[0] as Json).auto_delete = true;
    hetzner.firewalls = [];
    const plan = (await rebuildReal(deps, { ...options, plan: true })) as RebuildPlan;
    expect(plan.problems.join("\n")).toMatch(/points to 198\.51\.100\.1/);
    expect(plan.problems.join("\n")).toMatch(/auto_delete/);
    expect(plan.problems.join("\n")).toMatch(/no firewall/);
  });

  it("a new server when the old one is gone: stops if no CX23 can be ordered there, and offers the same place", async () => {
    const { deps, hetzner } = setup();
    hetzner.servers = [];
    for (const ip of hetzner.ips) ip.assignee_id = null;
    const plan = (await rebuildReal(deps, { ...options, plan: true, withoutFreshBackup: true })) as RebuildPlan;
    expect(plan.kind).toBe("new server");
    expect(plan.problems.join("\n")).toMatch(/cx23 cannot be ordered in fsn1.*cpx22 €0\.03744\/h/);
    const chosen = (await rebuildReal(deps, { ...options, plan: true, withoutFreshBackup: true, serverType: "cpx22" })) as RebuildPlan;
    expect(chosen).toMatchObject({ serverType: "cpx22", hourly: 0.03744, problems: [] });
  });

  it("an old server that does not answer needs --without-fresh-backup", async () => {
    const { deps, server } = setup({ probeReal: () => ({ status: 0, body: "" }) });
    server.reachable = false;
    const plan = (await rebuildReal(deps, { ...options, plan: true })) as RebuildPlan;
    expect(plan.problems.join("\n")).toMatch(/--without-fresh-backup/);
    expect(((await rebuildReal(deps, { ...options, plan: true, withoutFreshBackup: true })) as RebuildPlan).problems).toEqual([]);
  });

  it("refuses --server-type for a rebuild in place", async () => {
    const { deps } = setup();
    const plan = (await rebuildReal(deps, { ...options, plan: true, serverType: "cpx22" })) as RebuildPlan;
    expect(plan.problems.join("\n")).toMatch(/new server only/);
  });
});

describe("bivy rebuild (D91)", () => {
  it("refuses to erase a platform that still answers when only SSH fails", async () => {
    const { deps, server } = setup();
    server.reachable = false;
    const plan = (await rebuildReal(deps, { ...options, plan: true, withoutFreshBackup: true })) as RebuildPlan;
    expect(plan.problems.join("\n")).toMatch(/still answers while SSH does not/);
  });

  it("stops on an instance checkout that is not exactly origin/main", async () => {
    const { deps } = setup({ checkout: () => ["/x is not exactly origin/main: pull first"] });
    await expect(rebuildReal(deps, options)).rejects.toThrow(/checkout cannot be trusted/);
  });

  it("--plan never acts, even with a rebuild under way", async () => {
    const { deps, hetzner, server } = setup();
    hetzner.failRebuild = true;
    hetzner.failStatus = 500;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/boom/);
    const before = [writes(hetzner).length, server.commands.length];
    let asked = 0;
    deps.ask = async () => {
      asked++;
      return "apps.example.com";
    };
    await rebuildReal(deps, { ...options, plan: true });
    expect([writes(hetzner).length, asked]).toEqual([before[0], 0]);
    expect(server.commands.slice(before[1] ?? 0).every((command) => command.startsWith("sudo cat /var/lib/bivouac/backup/state.json; echo; sudo test"))).toBe(true);
  });

  it("starts over with a new plan, confirmation and backup when it stopped before erasing", async () => {
    const { deps, hetzner, server, asked } = setup({ probeReal: () => ({ status: 503, body: "" }) });
    await expect(rebuildReal(deps, options)).rejects.toThrow(/Pocket ID answers 503/);
    expect(writes(hetzner)).toEqual([]);
    deps.probeReal = () => ({ status: 200, body: JWKS });
    server.backupAsked = false;
    await rebuildReal(deps, options);
    expect(asked).toHaveLength(2);
    expect(server.backupAsked).toBe(true);
  });

  it("can abandon a rebuild that erased nothing, never one that may have", async () => {
    const { deps, hetzner } = setup({ probeReal: () => ({ status: 503, body: "" }) });
    await expect(rebuildReal(deps, options)).rejects.toThrow(/503/);
    await rebuildReal(deps, { ...options, abandon: true });
    expect(existsSync(deps.stateFile)).toBe(false);
    deps.probeReal = () => ({ status: 200, body: JWKS });
    hetzner.loseAnswer = true;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/fetch failed/);
    await expect(rebuildReal(deps, { ...options, abandon: true })).rejects.toThrow(/may already have been sent/);
  });

  it("a rebuild Hetzner never carried out leads to a new plan, confirmation and backup, not a silent resend", async () => {
    const { deps, hetzner, server, asked } = setup();
    hetzner.failRebuild = true;
    hetzner.failStatus = 503;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/boom/);
    expect(hetzner.servers[0]?.protection).toEqual({ delete: true, rebuild: true });
    hetzner.failRebuild = false;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/never carried out by Hetzner: nothing was erased/);
    expect(hetzner.calls.filter((call) => call.includes("/actions/rebuild"))).toHaveLength(1);
    expect(server.rebuilt).toBe(false);
    server.backupAsked = false;
    await rebuildReal(deps, options);
    expect(asked).toHaveLength(2);
    expect(server.backupAsked).toBe(true);
  });

  it("a refused rebuild (4xx) starts over", async () => {
    const { deps, hetzner, asked } = setup();
    hetzner.failRebuild = true;
    hetzner.failStatus = 422;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/boom/);
    hetzner.failRebuild = false;
    await rebuildReal(deps, options);
    expect(asked).toHaveLength(2);
  });

  it("puts the protection back first when a run was killed while it was lifted", async () => {
    const { deps, hetzner } = setup();
    hetzner.killOnRebuild = true;
    // A kill skips the finally: simulated by lifting the protection by hand.
    await expect(rebuildReal(deps, options)).rejects.toThrow(/killed/);
    (hetzner.servers[0] as Json).protection = { delete: false, rebuild: false };
    hetzner.killOnRebuild = false;
    deps.ask = async () => "no";
    await expect(rebuildReal(deps, options)).rejects.toThrow(/never carried out/);
    expect(hetzner.servers[0]?.protection).toEqual({ delete: true, rebuild: true });
  });

  it("takes over the lock of a run whose process is gone", async () => {
    const { deps } = setup();
    writeFileSync(`${deps.stateFile}.lock`, "999999999\n");
    await rebuildReal(deps, options);
    expect(existsSync(`${deps.stateFile}.lock`)).toBe(false);
  });

  it("checks the instance checkout again on a resumed run", async () => {
    let problems: string[] = [];
    const { deps, server } = setup({ checkout: () => problems });
    const original = server.run.bind(server);
    server.run = (command) => {
      if (server.rebuilt && !problems.length && command.includes("ssh-keygen")) {
        problems = ["/x has uncommitted changes"];
        throw new Error("connection lost");
      }
      return original(command);
    };
    await expect(rebuildReal(deps, options)).rejects.toThrow(/connection lost/);
    await expect(rebuildReal(deps, options)).rejects.toThrow(/checkout cannot be trusted/);
  });

  it("stops when the fresh backup fails, without erasing anything", async () => {
    const { deps, hetzner, server } = setup();
    server.backupOutcome = "failure";
    await expect(rebuildReal(deps, options)).rejects.toThrow(/fresh backup failed.*bucket not found/);
    expect(writes(hetzner)).toEqual([]);
  });

  it("one run at a time", async () => {
    const { deps } = setup();
    writeFileSync(`${deps.stateFile}.lock`, "1\n");
    await expect(rebuildReal(deps, options)).rejects.toThrow(/another bivy rebuild is running/);
  });

  it("looks up a rebuild whose answer was lost instead of sending it again", async () => {
    const { deps, hetzner } = setup();
    hetzner.loseAnswer = true;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/fetch failed/);
    hetzner.loseAnswer = false;
    await rebuildReal(deps, options);
    expect(hetzner.calls.filter((call) => call.includes("/actions/rebuild"))).toHaveLength(1);
  });

  it("says it could not check the deploy key, rather than blaming the key", async () => {
    const { deps, server } = setup();
    server.receivePackFails = true;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/could not check that the deploy key is read-only/);
  });

  it("changes nothing without the typed confirmation", async () => {
    const { deps, hetzner, server } = setup({ ask: async () => "yes" });
    await expect(rebuildReal(deps, options)).rejects.toThrow(/not confirmed/);
    expect(writes(hetzner)).toEqual([]);
    expect(server.backupAsked).toBe(false);
    expect(existsSync(deps.stateFile)).toBe(false);
  });

  it("makes a fresh backup, rebuilds in place with protection put back, and brings the platform back", async () => {
    const { deps, hetzner, server, logs } = setup();
    const state = (await rebuildReal(deps, options)) as RealState;
    expect(server.backupAsked).toBe(true);
    // Protection lifted only around the rebuild, then put back.
    expect(writes(hetzner)).toEqual(["POST /servers/1/actions/change_protection false", "POST /servers/1/actions/rebuild", "POST /servers/1/actions/change_protection true"]);
    expect(hetzner.servers[0]?.protection).toEqual({ delete: true, rebuild: true });
    // The real server's own IPv6, and the provisional host key as the only secret.
    expect(hetzner.userData).toContain("2001:db8:1::1/64");
    expect(secretsIn(hetzner.userData)).toEqual([HOST_KEY_PATH]);
    expect(hetzner.userData).not.toContain("AGE-SECRET-KEY");
    // The backup came before anything was erased.
    expect(server.commands.findIndex((command) => command.includes("jq -c"))).toBeLessThan(server.commands.findIndex((command) => command.includes("ssh-keygen")));
    expect(server.commands.some((command) => command.includes('"mode":"rebuild"') || command.includes("rebuild.json.tmp"))).toBe(true);
    expect(server.commands.at(-1)).toContain("rm -f /etc/bivouac/rebuild.json");
    expect(readFileSync(deps.knownHosts, "utf8")).toBe("203.0.113.10,2001:db8:1::1 ssh-ed25519 AAAAown\n");
    expect(readFileSync(`${deps.knownHosts}.before-rebuild-${state.run}`, "utf8")).toContain(OLD_KEY);
    expect(logs.join("\n")).toContain("Allow write access");
    expect(logs).toContain("  Pocket ID publishes the same signing keys as before");
    expect(existsSync(deps.stateFile)).toBe(false);
    expect(existsSync(`${deps.stateFile}.done-${state.run}`)).toBe(true);
  });

  it("puts the protection back when the rebuild fails, and has erased nothing", async () => {
    const { deps, hetzner, server } = setup();
    hetzner.failRebuild = true;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/boom/);
    expect(hetzner.servers[0]?.protection).toEqual({ delete: true, rebuild: true });
    expect(server.rebuilt).toBe(false);
  });

  it("never sends the rebuild twice after an interruption", async () => {
    const { deps, hetzner, server } = setup();
    const original = server.run.bind(server);
    let cut = false;
    server.run = (command) => {
      if (!cut && server.rebuilt) {
        cut = true;
        throw new Error("connection lost");
      }
      return original(command);
    };
    await expect(rebuildReal(deps, options)).rejects.toThrow(/connection lost/);
    await rebuildReal(deps, options);
    expect(hetzner.calls.filter((call) => call.includes("/actions/rebuild"))).toHaveLength(1);
  });

  it("refuses a deploy key that can write", async () => {
    const { deps, server } = setup();
    server.deployKeyWritable = true;
    await expect(rebuildReal(deps, options)).rejects.toThrow(/can write to the repo/);
    expect(server.commands.some((command) => command.includes("age.key.tmp"))).toBe(false);
  });

  it("refuses a Pocket ID that lost its signing keys", async () => {
    let calls = 0;
    const { deps } = setup({ probeReal: (_host, path) => ({ status: 200, body: path.includes("jwks") && calls++ > 0 ? JSON.stringify({ keys: [{ kid: "new", n: "zzz" }] }) : JWKS }) });
    await expect(rebuildReal(deps, options)).rejects.toThrow(/signing keys it had before/);
  });

  it("creates a new server on the same IPs when the old one is gone", async () => {
    const { deps, hetzner, server } = setup();
    hetzner.servers = [];
    for (const ip of hetzner.ips) ip.assignee_id = null;
    await rebuildReal(deps, { ...options, withoutFreshBackup: true, serverType: "cpx22" });
    const created = hetzner.servers[0] as Json;
    expect(created).toMatchObject({ name: "bivouac", labels: {}, protection: { delete: true, rebuild: true } });
    expect((created.body as Json).public_net).toEqual({ enable_ipv4: true, enable_ipv6: true, ipv4: 2, ipv6: 3 });
    expect((created.body as Json).firewalls).toEqual([{ firewall: 4 }]);
    expect(server.backupAsked).toBe(false);
  });
});

describe("the instance checkout", () => {
  it("must be exactly origin/main with nothing uncommitted (.DS_Store aside)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bivy-checkout-"));
    dirs.push(dir);
    const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(dir, "clone", "-q", join(dir, "origin.git"), "work");
    const work = join(dir, "work");
    writeFileSync(join(work, "platform.yml"), "a\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "one");
    git(work, "push", "-q", "origin", "HEAD:main");
    expect(checkoutProblems(work)).toEqual([]);
    writeFileSync(join(work, ".DS_Store"), "x");
    expect(checkoutProblems(work)).toEqual([]);
    writeFileSync(join(work, "platform.yml"), "b\n");
    expect(checkoutProblems(work).join()).toMatch(/uncommitted/);
    git(work, "commit", "-qam", "two");
    expect(checkoutProblems(work).join()).toMatch(/not exactly origin\/main/);
    expect(checkoutProblems(join(dir, "nowhere")).join()).toMatch(/git fetch failed/);
  });
});
