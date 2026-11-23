import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList } from "node:net";
import { join } from "node:path";
import { PLATFORM_CONTAINERS, PLATFORM_NETWORKS, STATUS_APP, appContainerName } from "@bivouac/manifest";
import type { Runtime } from "./base.js";
import { writeIfChanged } from "./base.js";
import { MANAGED_LABEL } from "./containers.js";
import { deriveSecret, type PlatformSecrets } from "./secrets.js";

/**
 * The reconciler's internal API (D8), read by the status page. It shows what
 * runs, the last pass, the backups, open incidents, the host's disk and
 * memory, and the latest lines of a container's logs; its only action is
 * `POST /v1/sync` (D3).
 *
 * Two locks, because the reconciler holds the Docker socket:
 * - it only answers connections made to its address on the internal
 *   network, where no app is (D56): apps reach the reconciler on `bivouac`,
 *   and their connections are closed as soon as they open. An app cannot
 *   send a packet straight to the internal address: Docker drops traffic
 *   between bridge networks, and apps have neither NET_RAW nor NET_ADMIN
 *   (containers.ts);
 * - every request carries the status page's token, derived from the master
 *   secret (D14) and compared in constant time.
 *
 * It never shows a container's environment, mounts or command: the secrets
 * live there. Nor Postgres's logs: a failed statement is written there whole,
 * and the reconciler's role statements carry derived passwords.
 */

/** The status page's token: computed, never stored (D14). */
export function apiToken(secrets: PlatformSecrets): string {
  return deriveSecret(secrets.master_secret, "api:status");
}

/** A manual sync at most this often (D3). */
export const SYNC_INTERVAL_MS = 10_000;
const MAX_LOG_LINES = 1000;
/** Logs are held in memory before they are sent: a container writing huge lines must not fill it. */
const MAX_LOG_BYTES = 1024 ** 2;
/** Containers whose logs are never shown (see above). */
const HIDDEN_LOGS: string[] = [PLATFORM_CONTAINERS.postgres];

export interface PassSummary {
  at: string;
  status: string;
  commit?: string;
  changes: string[];
  failures: { app: string; message: string }[];
}

export interface ApiOptions {
  runtime: Runtime;
  /** The image this reconciler runs, when known. */
  image?: string;
  /** Starts a pass now; false when one is already running. */
  sync: () => boolean;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const INTERNAL = new BlockList();
INTERNAL.addSubnet(PLATFORM_NETWORKS.internal.subnet.split("/")[0]!, Number(PLATFORM_NETWORKS.internal.subnet.split("/")[1]), "ipv4");

/** True when a connection reached this container through the internal network. */
export function onInternalNetwork(localAddress: string | undefined): boolean {
  if (!localAddress) return false;
  const address = localAddress.replace(/^::ffff:/i, "");
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) && INTERNAL.check(address, "ipv4");
}

export class Api {
  private token?: Buffer;
  private lastPass?: PassSummary;
  private lastSync = 0;
  private readonly startedAt: string;
  private readonly now: () => number;

  constructor(private readonly options: ApiOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
  }

  /** Called after each pass that decrypted the secrets. */
  setToken(token: string): void {
    this.token = Buffer.from(token);
  }

  recordPass(summary: Omit<PassSummary, "at">): void {
    this.lastPass = { at: new Date(this.now()).toISOString(), ...summary };
    // Also on disk, for `main.js status` (bivy status), which runs beside this process.
    try {
      writeIfChanged(lastPassPath(this.options.runtime.stateDir), JSON.stringify(this.lastPass), 0o600);
    } catch (error) {
      this.options.log?.("last pass not saved", { error: (error as Error).message });
    }
  }

  listen(port: number): Server {
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        send(response, 500, { error: (error as Error).message });
      });
    });
    // Slow or idle clients must not pile up inside the process that holds the socket.
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 32;
    // Closed before a byte is read: an app cannot hold the status page's connections.
    server.on("connection", (socket) => {
      if (!onInternalNetwork(socket.localAddress)) socket.destroy();
    });
    server.on("error", (error) => this.options.log?.("internal API stopped", { error: error.message }));
    server.listen(port);
    return server;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!onInternalNetwork(request.socket.localAddress)) return send(response, 403, { error: "internal network only" });
    if (!this.authorized(request.headers.authorization)) return send(response, 401, { error: "a valid token is required" });
    const url = new URL(request.url ?? "/", "http://api");
    if (request.method === "GET" && url.pathname === "/v1/state") return send(response, 200, await this.state());
    const logs = /^\/v1\/logs\/([a-z0-9][a-z0-9_.-]*)$/.exec(url.pathname);
    if (request.method === "GET" && logs) {
      const lines = Math.min(MAX_LOG_LINES, Math.max(1, Number(url.searchParams.get("lines") ?? "200") || 200));
      return this.logs(response, logs[1]!, lines);
    }
    if (request.method === "POST" && url.pathname === "/v1/sync") return this.syncNow(response);
    send(response, 404, { error: "not found" });
  }

  private authorized(header: string | undefined): boolean {
    if (!this.token || !header?.startsWith("Bearer ")) return false;
    const given = Buffer.from(header.slice("Bearer ".length));
    return given.length === this.token.length && timingSafeEqual(given, this.token);
  }

  private syncNow(response: ServerResponse): void {
    const now = this.now();
    const wait = this.lastSync + SYNC_INTERVAL_MS - now;
    if (wait > 0) {
      response.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return send(response, 429, { error: "a sync was asked for less than 10 seconds ago" });
    }
    this.lastSync = now;
    send(response, 202, { started: this.options.sync() });
  }

  /** Only the platform's own containers, never another one on the host. */
  private async managed(): Promise<string[]> {
    const { docker, self } = this.options.runtime;
    const names = await docker.listContainers(`${MANAGED_LABEL}=true`);
    return [...new Set([...(self ? [self] : []), ...names])].sort();
  }

  private async logs(response: ServerResponse, name: string, lines: number): Promise<void> {
    if (HIDDEN_LOGS.includes(name) || !(await this.managed()).includes(name)) return send(response, 404, { error: "no such container" });
    const output = await this.options.runtime.docker.logs(name, { lines, timestamps: true });
    // stdout and stderr come apart: put them back in time order.
    let text = `${output.split("\n").filter(Boolean).sort().slice(-lines).join("\n")}\n`;
    if (Buffer.byteLength(text) > MAX_LOG_BYTES) text = `(cut to the last MiB)\n${Buffer.from(text).subarray(-MAX_LOG_BYTES).toString()}`;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(text);
  }

  async state(): Promise<unknown> {
    return platformState({
      runtime: this.options.runtime,
      reconciler: { image: this.options.image ?? null, startedAt: this.startedAt },
      lastPass: this.lastPass ?? null,
      now: this.now,
    });
  }
}

const lastPassPath = (stateDir: string) => join(stateDir, "reconciler", "last-pass.json");

/** The last pass the running reconciler recorded, as `main.js status` reads it from beside it. */
export function readLastPass(stateDir: string): PassSummary | null {
  return (readJson(lastPassPath(stateDir)) as PassSummary | undefined) ?? null;
}

/**
 * What runs and how the platform is: the status page's `/v1/state`, and
 * `main.js status` for `bivy status` (D104). Only the platform's own
 * containers, never their environment, mounts or command.
 */
export async function platformState(options: {
  runtime: Runtime;
  reconciler: { image: string | null; startedAt: string | null };
  lastPass: PassSummary | null;
  now?: () => number;
}): Promise<unknown> {
  const { runtime } = options;
  const { docker, self } = runtime;
  const names = [...new Set([...(self ? [self] : []), ...(await docker.listContainers(`${MANAGED_LABEL}=true`))])].sort();
  const containers = await Promise.all(
    names.map(async (name) => {
      const info = await docker.inspectContainer(name);
      if (!info) return undefined;
      const running = info.State.Running === true;
      const memory = running ? await docker.memory(name).catch(() => undefined) : undefined;
      return {
        name,
        kind: containerKind(name),
        image: info.Config.Image,
        state: info.State.Status,
        health: info.State.Health?.Status ?? null,
        startedAt: info.State.StartedAt,
        restarts: info.RestartCount ?? 0,
        oomKilled: info.State.OOMKilled === true,
        memory: memory ?? null,
      };
    }),
  );
  return {
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    reconciler: options.reconciler,
    lastPass: options.lastPass,
    containers: containers.filter((entry) => entry !== undefined),
    backup: backupSummary(runtime.stateDir),
    incidents: openIncidents(runtime.stateDir),
    host: hostSummary(runtime.stateDir),
  };
}

/** An app the owner hosts, or a piece of the platform itself (the status page included). */
export function containerKind(name: string): "app" | "platform" {
  return name.startsWith(appContainerName("")) && name !== appContainerName(STATUS_APP) ? "app" : "platform";
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return void response.end();
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const iso = (value: unknown) => (typeof value === "number" ? new Date(value).toISOString() : null);

/** The last backup, clean-up and restore test, from the scheduler's own record (backup.ts). */
export function backupSummary(stateDir: string): unknown {
  const state = readJson(join(stateDir, "backup", "state.json"));
  if (!state) return null;
  return {
    lastSuccessAt: iso(state.lastSuccessAt),
    lastAttemptAt: iso(state.lastAttemptAt),
    lastError: typeof state.lastError === "string" ? state.lastError : null,
    restoreTestWeekPassed: typeof state.restoreWeek === "number" ? state.restoreWeek : null,
    restoreError: typeof state.restoreError === "string" ? state.restoreError : null,
    maintenanceError: typeof state.maintenanceError === "string" ? state.maintenanceError : null,
    // The last backup asked for now (bivy backup), as backup.ts records it.
    request: readJson(join(stateDir, "backup", "request.json")) ?? null,
  };
}

/** What the alerts consider still wrong (alerts.ts). */
export function openIncidents(stateDir: string): { key: string; message: string; since: string | null }[] {
  const state = readJson(join(stateDir, "alerts", "state.json"));
  const incidents = (state?.incidents ?? {}) as Record<string, { message?: unknown; since?: unknown }>;
  return Object.entries(incidents).map(([key, incident]) => ({
    key,
    message: typeof incident.message === "string" ? incident.message : "",
    // `seen` is a pass count, not a date (it showed as 1 Jan. 1970).
    since: iso(incident.since),
  }));
}

/**
 * The host's disk, read through the state directory (it is the host's own
 * file system, mounted at the same path), and its memory: a container reads
 * the host's /proc/meminfo.
 */
export function hostSummary(stateDir: string): unknown {
  const disk = statfsSync(stateDir);
  const meminfo = existsSync("/proc/meminfo") ? readFileSync("/proc/meminfo", "utf8") : "";
  const field = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo);
    return match ? Number(match[1]) * 1024 : null;
  };
  // Not namespaced by Docker: the host's own (from memory, checked on the server).
  const uptime = existsSync("/proc/uptime") ? Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) : Number.NaN;
  return {
    bootedAt: Number.isFinite(uptime) ? new Date(Date.now() - uptime * 1000).toISOString() : null,
    disk: { totalBytes: disk.blocks * disk.bsize, availableBytes: disk.bavail * disk.bsize },
    memory: { totalBytes: field("MemTotal"), availableBytes: field("MemAvailable") },
    swap: { totalBytes: field("SwapTotal"), freeBytes: field("SwapFree") },
  };
}
