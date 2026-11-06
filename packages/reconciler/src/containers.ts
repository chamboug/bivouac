import { createHash } from "node:crypto";
import type { ContainerInfo, Docker } from "./docker.js";

/** Label set on everything the reconciler creates. */
export const MANAGED_LABEL = "bivouac.managed";
/** Fingerprint of the desired container: when it changes, the container is recreated. */
export const SPEC_LABEL = "bivouac.spec";

export interface Mount {
  type: "bind" | "volume";
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface HealthCheck {
  test: string[];
  intervalSeconds: number;
  startPeriodSeconds: number;
}

export interface ContainerSpec {
  name: string;
  image: string;
  env?: Record<string, string>;
  cmd?: string[];
  mounts?: Mount[];
  /** Docker networks to join, each with a fixed address or `null` for any (only Caddy has one). */
  networks: Record<string, string | null>;
  /** Published ports, e.g. `{ "443/tcp": ["443"] }` or `["127.0.0.1:8443"]`. */
  ports?: Record<string, string[]>;
  healthCheck?: HealthCheck;
  /**
   * Fingerprint of files the container reads at startup (secret files): when
   * they change, the container is recreated so it reads them again.
   */
  inputs?: string;
}

/**
 * The body of Docker's "create container" call. Every container restarts
 * on its own after a crash or a reboot (`unless-stopped`) and keeps at most
 * 30 MB of logs, so logs can never fill the disk.
 *
 * Every container also loses `NET_RAW` (in Docker's default capabilities,
 * verified on Docker 29.7): without it, a compromised container cannot
 * forge packets to impersonate a neighbor on the shared network. And no
 * process may gain privileges through a setuid program
 * (`no-new-privileges`); the images' entrypoints (gosu, su-exec) drop
 * privileges, which this does not prevent.
 */
export function createBody(spec: ContainerSpec): Record<string, unknown> {
  const seconds = (value: number) => value * 1_000_000_000;
  const bindings = Object.fromEntries(
    Object.entries(spec.ports ?? {}).map(([port, hosts]) => [
      port,
      hosts.map((host) => {
        const at = host.lastIndexOf(":");
        return at === -1 ? { HostPort: host } : { HostIp: host.slice(0, at), HostPort: host.slice(at + 1) };
      }),
    ]),
  );
  const body: Record<string, unknown> = {
    Image: spec.image,
    Env: Object.entries(spec.env ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`),
    Labels: { [MANAGED_LABEL]: "true", ...(spec.inputs ? { "bivouac.inputs": spec.inputs } : {}) },
    ExposedPorts: Object.fromEntries(Object.keys(spec.ports ?? {}).map((port) => [port, {}])),
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      Mounts: (spec.mounts ?? []).map((mount) => ({
        Type: mount.type,
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly ?? false,
      })),
      PortBindings: bindings,
      CapDrop: ["NET_RAW"],
      SecurityOpt: ["no-new-privileges:true"],
    },
    NetworkingConfig: {
      EndpointsConfig: Object.fromEntries(
        Object.entries(spec.networks)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([network, address]) => [network, address ? { IPAMConfig: { IPv4Address: address } } : {}]),
      ),
    },
  };
  if (spec.cmd) body.Cmd = spec.cmd;
  if (spec.healthCheck) {
    body.Healthcheck = {
      Test: ["CMD", ...spec.healthCheck.test],
      Interval: seconds(spec.healthCheck.intervalSeconds),
      Timeout: seconds(5),
      Retries: 3,
      StartPeriod: seconds(spec.healthCheck.startPeriodSeconds),
      StartInterval: seconds(1),
    };
  }
  return body;
}

export function fingerprint(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export type EnsureResult = "created" | "recreated" | "started" | "unchanged" | "left-stopped";

/**
 * Brings one container to its spec. A container whose fingerprint differs is
 * removed and created again; an identical one is left alone. Images are
 * pulled only when missing: a deployment always names an exact version
 * (D48), so a present image is the right one.
 *
 * A container that exists with the right spec but was stopped is a
 * deployment that failed its health check: it stays stopped until the
 * manifest changes, instead of being retried every minute (D21).
 */
export async function ensureContainer(
  docker: Docker,
  spec: ContainerSpec,
  pull: (image: string) => Promise<void>,
  options: { restartStopped: boolean },
): Promise<EnsureResult> {
  const body = createBody(spec);
  const wanted = fingerprint(body);
  (body.Labels as Record<string, string>)[SPEC_LABEL] = wanted;

  const current = await docker.inspectContainer(spec.name);
  if (current && current.Config.Labels?.[SPEC_LABEL] === wanted) {
    if (current.State.Running) return "unchanged";
    if (!options.restartStopped) return "left-stopped";
    await docker.startContainer(spec.name);
    return "started";
  }
  if (!(await docker.imageExists(spec.image))) {
    await pull(spec.image);
  }
  if (current) {
    await docker.removeContainer(spec.name);
  }
  await docker.createContainer(spec.name, body);
  await docker.startContainer(spec.name);
  return current ? "recreated" : "created";
}

/** Waits for Docker's own health check to report the container healthy. */
export async function waitHealthy(docker: Docker, name: string, timeoutSeconds: number): Promise<void> {
  await waitFor(
    async () => {
      const info = await docker.inspectContainer(name);
      return describe(info) === "healthy" ? true : describe(info);
    },
    timeoutSeconds,
    name,
  );
}

function describe(info: ContainerInfo | undefined): string {
  if (!info) return "missing";
  if (!info.State.Running) return `not running (${info.State.Status})`;
  return info.State.Health?.Status ?? "running without a health check";
}

/**
 * Calls `check` every second until it returns true. Anything else it
 * returns is the current state, quoted in the error on timeout.
 */
export async function waitFor(
  check: () => Promise<true | string>,
  timeoutSeconds: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "";
  for (;;) {
    const result = await check();
    if (result === true) return;
    last = result;
    if (Date.now() > deadline) {
      throw new Error(`${what} is still ${last} after ${timeoutSeconds} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** `80/tcp=80,443/tcp=127.0.0.1:8443` → `{ "80/tcp": ["80"], "443/tcp": ["127.0.0.1:8443"] }`. */
export function parsePorts(value: string): Record<string, string[]> {
  const ports: Record<string, string[]> = {};
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [port, host] = entry.split("=");
    if (!port || !host || !/^\d+\/(tcp|udp)$/.test(port)) {
      throw new Error(`BIVOUAC_CADDY_PORTS: '${entry}' is not 'port/protocol=[address:]port'`);
    }
    (ports[port] ??= []).push(host);
  }
  return ports;
}
