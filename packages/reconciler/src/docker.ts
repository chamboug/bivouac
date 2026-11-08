import { request } from "node:http";

/**
 * A minimal client for the Docker Engine API, spoken directly over the
 * socket with Node's own HTTP module (rule 9: no library in between).
 *
 * The API version is pinned so the calls below always mean the same thing.
 * Verified (6 November 2026): Docker 29.7 accepts API 1.40 to 1.55; Flatcar
 * stable 4757.2.3 ships Docker 28.2.2. From memory, to be checked on the
 * server: 1.48 is Docker 28.0's version. `checkVersion` refuses to run
 * against an engine that does not accept it.
 */
export const DOCKER_API_VERSION = "1.48";

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> | null; Image: string };
  State: { Status: string; Running: boolean; Health?: { Status: string } };
  Mounts: { Type: string; Source: string; Destination: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Response {
  status: number;
  body: Buffer;
}

export class Docker {
  constructor(private readonly socketPath = "/var/run/docker.sock") {}

  private call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeout?: number): Promise<Response> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path: `/v${DOCKER_API_VERSION}${path}`,
          headers: {
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("error", (error) => reject(new DockerError(`cannot reach Docker at ${this.socketPath}: ${error.message}`)));
      // A stuck daemon or registry must not freeze the reconciler (and its
      // alerts) forever: 15 minutes for a pull, 2 for anything else.
      const limit = timeout ?? (path.startsWith("/images/create") ? 15 * 60_000 : 2 * 60_000);
      req.setTimeout(limit, () => {
        req.destroy(new DockerError(`${method} ${path.split("?")[0]} timed out`));
      });
      req.end(payload);
    });
  }

  /** Calls the API and fails on any status outside `ok`. */
  private async expect(method: string, path: string, ok: number[], body?: unknown, headers?: Record<string, string>, timeout?: number) {
    const response = await this.call(method, path, body, headers, timeout);
    if (!ok.includes(response.status)) {
      throw new DockerError(`${method} ${path.split("?")[0]}: ${errorMessage(response)}`, response.status);
    }
    return response;
  }

  async checkVersion(): Promise<string> {
    const response = await this.call("GET", "/version");
    if (response.status === 400) {
      throw new DockerError(`this Docker engine does not accept API ${DOCKER_API_VERSION}: ${errorMessage(response)}`);
    }
    if (response.status !== 200) throw new DockerError(`GET /version: ${errorMessage(response)}`, response.status);
    return (JSON.parse(response.body.toString()) as { Version: string }).Version;
  }

  async inspectContainer(name: string): Promise<ContainerInfo | undefined> {
    const response = await this.call("GET", `/containers/${encodeURIComponent(name)}/json`);
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new DockerError(`inspect ${name}: ${errorMessage(response)}`, response.status);
    return JSON.parse(response.body.toString()) as ContainerInfo;
  }

  async imageExists(image: string): Promise<boolean> {
    const response = await this.call("GET", `/images/${image}/json`);
    if (response.status === 404) return false;
    if (response.status !== 200) throw new DockerError(`inspect image ${image}: ${errorMessage(response)}`, response.status);
    return true;
  }

  /**
   * Pulls an image. `auth` is the registry login, sent as Docker expects it
   * (base64 JSON in `X-Registry-Auth`). Errors can arrive either as an HTTP
   * status or inside the progress stream, so both are checked.
   */
  async pull(image: string, auth?: { username: string; password: string; serveraddress: string }): Promise<void> {
    const headers = auth ? { "X-Registry-Auth": Buffer.from(JSON.stringify(auth)).toString("base64url") } : undefined;
    const response = await this.expect("POST", `/images/create?fromImage=${encodeURIComponent(image)}`, [200], undefined, headers);
    for (const line of response.body.toString().split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { error?: string };
      if (event.error) throw new DockerError(`pull ${image}: ${event.error}`);
    }
  }

  async networkExists(name: string): Promise<boolean> {
    const response = await this.call("GET", `/networks/${encodeURIComponent(name)}`);
    if (response.status === 404) return false;
    if (response.status !== 200) throw new DockerError(`inspect network ${name}: ${errorMessage(response)}`, response.status);
    return true;
  }

  async createNetwork(
    name: string,
    ipam: { subnet: string; ipRange: string; gateway: string },
    labels: Record<string, string>,
  ): Promise<void> {
    await this.expect("POST", "/networks/create", [201], {
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: labels,
      IPAM: { Config: [{ Subnet: ipam.subnet, IPRange: ipam.ipRange, Gateway: ipam.gateway }] },
    });
  }

  async connectNetwork(network: string, container: string): Promise<void> {
    await this.expect("POST", `/networks/${encodeURIComponent(network)}/connect`, [200], { Container: container });
  }

  async createContainer(name: string, body: unknown): Promise<void> {
    await this.expect("POST", `/containers/create?name=${encodeURIComponent(name)}`, [201], body);
  }

  async startContainer(name: string): Promise<void> {
    await this.expect("POST", `/containers/${encodeURIComponent(name)}/start`, [204, 304]);
  }

  async stopContainer(name: string, timeoutSeconds = 30): Promise<void> {
    await this.expect("POST", `/containers/${encodeURIComponent(name)}/stop?t=${timeoutSeconds}`, [204, 304]);
  }

  /** `anonymousVolumes` also removes the unnamed volumes an image declares; named ones always stay. */
  async removeContainer(name: string, options: { anonymousVolumes?: boolean } = {}): Promise<void> {
    await this.expect("DELETE", `/containers/${encodeURIComponent(name)}?force=true${options.anonymousVolumes ? "&v=true" : ""}`, [204, 404]);
  }

  /** Waits for a container to stop (by default at most 2 minutes) and returns its exit code. */
  async waitContainer(name: string, timeout?: number): Promise<number> {
    const response = await this.expect("POST", `/containers/${encodeURIComponent(name)}/wait`, [200], undefined, undefined, timeout);
    return (JSON.parse(response.body.toString()) as { StatusCode: number }).StatusCode;
  }

  /** A stopped or running container's output, stdout and stderr together. */
  async logs(name: string): Promise<string> {
    const response = await this.expect("GET", `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=20`, [200]);
    const { stdout, stderr } = demultiplex(response.body);
    return `${stdout}${stderr}`;
  }

  /** Runs a command in a running container and waits for it to finish. */
  async exec(container: string, cmd: string[], timeout?: number): Promise<ExecResult> {
    const created = await this.expect("POST", `/containers/${encodeURIComponent(container)}/exec`, [201], {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const { Id } = JSON.parse(created.body.toString()) as { Id: string };
    const started = await this.expect("POST", `/exec/${Id}/start`, [200], { Detach: false, Tty: false }, undefined, timeout);
    const { stdout, stderr } = demultiplex(started.body);
    const inspected = await this.expect("GET", `/exec/${Id}/json`, [200]);
    const { ExitCode } = JSON.parse(inspected.body.toString()) as { ExitCode: number };
    return { exitCode: ExitCode, stdout, stderr };
  }
}

/**
 * Without a TTY, Docker multiplexes stdout and stderr in frames: one byte for
 * the stream (1 = stdout, 2 = stderr), three zero bytes, then the frame size
 * as a big-endian 32-bit integer (verified on Docker 29.7).
 */
export function demultiplex(buffer: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const frame = buffer.subarray(offset + 8, offset + 8 + size);
    (stream === 2 ? err : out).push(frame);
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

function errorMessage(response: Response): string {
  try {
    return (JSON.parse(response.body.toString()) as { message: string }).message;
  } catch {
    return `HTTP ${response.status} ${response.body.toString().slice(0, 200)}`;
  }
}
