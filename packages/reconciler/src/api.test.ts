import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Api, SYNC_INTERVAL_MS, backupSummary, containerKind, onInternalNetwork, openIncidents } from "./api.js";
import type { Runtime } from "./base.js";
import type { Docker } from "./docker.js";

const TOKEN = "a".repeat(64);
const INTERNAL = "10.209.1.130";

function fakeDocker(): Docker {
  const containers: Record<string, unknown> = {
    "bivouac-app-biblio": {
      Config: { Image: "ghcr.io/x/biblio:sha-1" },
      State: { Status: "running", Running: true, StartedAt: "2026-11-16T20:15:56Z", OOMKilled: false },
      RestartCount: 0,
      Mounts: [],
      NetworkSettings: { Networks: {} },
    },
    "bivouac-reconciler": {
      Config: { Image: "ghcr.io/x/bivouac-reconciler:sha-2", Env: ["SECRET=nope"] },
      State: { Status: "running", Running: true, StartedAt: "2026-11-15T09:36:41Z" },
      RestartCount: 0,
      Mounts: [],
      NetworkSettings: { Networks: {} },
    },
  };
  return {
    listContainers: async () => ["bivouac-app-biblio", "bivouac-postgres"],
    inspectContainer: async (name: string) => containers[name],
    memory: async () => ({ usedBytes: 50_000_000, limitBytes: 1024 ** 3 }),
    logs: async (_name: string, options: { lines?: number }) =>
      ["2026-11-17T10:00:02Z b", "2026-11-17T10:00:01Z a", "2026-11-17T10:00:03Z c"].slice(0, options.lines ?? 20).join("\n"),
  } as unknown as Docker;
}

function setup(now = () => 1_800_000_000_000) {
  const stateDir = mkdtempSync(join(tmpdir(), "bivouac-api-"));
  const runtime = { docker: fakeDocker(), stateDir, self: "bivouac-reconciler" } as unknown as Runtime;
  let syncs = 0;
  const api = new Api({ runtime, image: "ghcr.io/x/bivouac-reconciler:sha-2", sync: () => (syncs++, true), now });
  api.setToken(TOKEN);
  return { api, stateDir, syncs: () => syncs };
}

async function call(api: Api, method: string, path: string, options: { token?: string; local?: string } = {}) {
  const request = {
    method,
    url: path,
    headers: options.token === undefined ? { authorization: `Bearer ${TOKEN}` } : { authorization: options.token },
    socket: { localAddress: options.local ?? INTERNAL },
  } as unknown as IncomingMessage;
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const response = {
    headersSent: false,
    setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  await api.handle(request, response);
  return { status, body, headers };
}

describe("internal API", () => {
  it("answers only on the internal network", () => {
    expect(onInternalNetwork("10.209.1.130")).toBe(true);
    expect(onInternalNetwork("::ffff:10.209.1.130")).toBe(true);
    expect(onInternalNetwork("10.209.0.130")).toBe(false); // the apps' network
    expect(onInternalNetwork("172.17.0.2")).toBe(false);
    expect(onInternalNetwork("127.0.0.1")).toBe(false);
    expect(onInternalNetwork(undefined)).toBe(false);
  });

  it("closes a connection that does not come through the internal network before reading it", async () => {
    const { api } = setup();
    const server = api.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/state", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => resolve(`answered ${res.statusCode}`));
      req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      req.end();
    });
    server.close();
    expect(outcome).toMatch(/ECONNRESET|socket hang up/);
  });

  it("refuses a connection from the apps' network, even with the token", async () => {
    const { api } = setup();
    expect((await call(api, "GET", "/v1/state", { local: "10.209.0.130" })).status).toBe(403);
  });

  it("refuses a missing or wrong token, and every request before the first pass", async () => {
    const { api } = setup();
    expect((await call(api, "GET", "/v1/state", { token: "" })).status).toBe(401);
    expect((await call(api, "GET", "/v1/state", { token: `Bearer ${"b".repeat(64)}` })).status).toBe(401);
    expect((await call(api, "GET", "/v1/state", { token: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await call(api, "GET", "/v1/state", { token: TOKEN })).status).toBe(401);
    const fresh = new Api({ runtime: { docker: fakeDocker(), stateDir: tmpdir() } as unknown as Runtime, sync: () => true });
    expect((await call(fresh, "GET", "/v1/state")).status).toBe(401);
  });

  it("shows the containers, never their environment", async () => {
    const { api } = setup();
    api.recordPass({ status: "unchanged", commit: "abc", changes: [], failures: [] });
    const { status, body } = await call(api, "GET", "/v1/state");
    expect(status).toBe(200);
    const state = JSON.parse(body);
    expect(state.containers.map((entry: { name: string }) => entry.name)).toEqual(["bivouac-app-biblio", "bivouac-reconciler"]);
    expect(state.containers[0]).toMatchObject({ kind: "app", restarts: 0, oomKilled: false, memory: { usedBytes: 50_000_000 } });
    expect(state.containers[1]).toMatchObject({ kind: "platform" });
    expect(state.lastPass).toMatchObject({ status: "unchanged", commit: "abc" });
    expect(body).not.toContain("SECRET");
    expect(state.host.disk.totalBytes).toBeGreaterThan(0);
  });

  it("gives logs in time order, only of the platform's containers", async () => {
    const { api } = setup();
    const logs = await call(api, "GET", "/v1/logs/bivouac-app-biblio?lines=3");
    expect(logs.status).toBe(200);
    expect(logs.body).toBe("2026-11-17T10:00:01Z a\n2026-11-17T10:00:02Z b\n2026-11-17T10:00:03Z c\n");
    expect((await call(api, "GET", "/v1/logs/some-other-container")).status).toBe(404);
    expect((await call(api, "GET", "/v1/logs/..%2Fetc")).status).toBe(404);
    expect((await call(api, "GET", "/v1/logs/bivouac-postgres")).status).toBe(404);
  });

  it("syncs at most once every 10 seconds", async () => {
    let now = 1_800_000_000_000;
    const { api, syncs } = setup(() => now);
    expect((await call(api, "POST", "/v1/sync")).status).toBe(202);
    const refused = await call(api, "POST", "/v1/sync");
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toBe("10");
    now += SYNC_INTERVAL_MS;
    expect((await call(api, "POST", "/v1/sync")).status).toBe(202);
    expect(syncs()).toBe(2);
    expect((await call(api, "GET", "/v1/sync")).status).toBe(404);
  });

  it("tells the hosted apps from the platform's own containers, the status page included", () => {
    expect(containerKind("bivouac-app-biblio")).toBe("app");
    expect(containerKind("bivouac-app-status")).toBe("platform");
    expect(containerKind("bivouac-postgres")).toBe("platform");
    expect(containerKind("bivouac-reconciler")).toBe("platform");
  });

  it("reads the backup record and the open incidents", () => {
    const { stateDir } = setup();
    expect(backupSummary(stateDir)).toBeNull();
    mkdirSync(join(stateDir, "backup"));
    writeFileSync(join(stateDir, "backup", "state.json"), JSON.stringify({ attempts: 1, lastSuccessAt: 1794880825346, restoreWeek: 2968 }));
    expect(backupSummary(stateDir)).toMatchObject({ lastSuccessAt: "2026-11-17T02:00:25.346Z", restoreTestWeekPassed: 2968, lastError: null });
    mkdirSync(join(stateDir, "alerts"));
    writeFileSync(join(stateDir, "alerts", "state.json"), JSON.stringify({ incidents: { "disk:host": { message: "Disk 85%", seen: 1794880825346, missed: 0 } } }));
    expect(openIncidents(stateDir)).toEqual([{ key: "disk:host", message: "Disk 85%", since: "2026-11-17T02:00:25.346Z" }]);
  });
});
