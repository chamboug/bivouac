/**
 * The miniature platform: the real reconciler image, run against a
 * throwaway instance repo, creates the real base services (Postgres, Pocket
 * ID, Caddy) and a small test app on the local Docker engine. Used by the
 * end-to-end tests and by `npm run platform:up` (D43).
 *
 * Nothing here is secret: the age key and the master secret are generated
 * for each run and thrown away with it.
 *
 * Every container, network and volume it touches is named `bivouac…`: it
 * must not run on a machine that hosts a real Bivouac instance.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..");

export const RECONCILER_IMAGE = "bivouac-reconciler:dev";
export const TEST_APP_IMAGE = "bivouac-test-app:dev";
export const DOMAIN = "apps.bivouac.localhost";
/** Caddy's fixed address on the internal network (see PLATFORM_NETWORKS). */
export const CADDY_ADDRESS = "10.209.1.10";
export const INTERNAL_NETWORK = "bivouac-internal";
const SOPS_IMAGE = "ghcr.io/getsops/sops:v3.13.3";
const ALPINE_IMAGE = "alpine:3.24";
const CURL_IMAGE = "curlimages/curl:8.23.0";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function docker(...args: string[]): string {
  const result = run("docker", args);
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Builds the reconciler image from this checkout and the test app. */
export function buildImages(): void {
  docker("build", "--quiet", "--file", join(REPO_ROOT, "packages/reconciler/Dockerfile"), "--tag", RECONCILER_IMAGE, REPO_ROOT);
  docker("build", "--quiet", "--tag", TEST_APP_IMAGE, join(here, "test-app"));
}

/**
 * Removes everything the reconciler creates: containers, networks, volumes.
 * Refuses to run on a machine that holds a real instance's age key.
 */
export function destroyPlatform(): void {
  if (existsSync("/etc/bivouac/age.key")) {
    throw new Error("/etc/bivouac/age.key exists: this looks like a real Bivouac server, refusing to remove anything");
  }
  const containers = docker("ps", "--all", "--quiet", "--filter", "label=bivouac.managed=true");
  if (containers) docker("rm", "--force", "--volumes", ...containers.split("\n"));
  run("docker", ["rm", "--force", "bivouac-reconciler"]);
  run("docker", ["network", "rm", "bivouac", INTERNAL_NETWORK]);
  const volumes = docker("volume", "ls", "--quiet", "--filter", "name=^bivouac-");
  if (volumes) docker("volume", "rm", "--force", ...volumes.split("\n"));
}

export interface Platform {
  /** Temporary folder holding everything below. */
  root: string;
  /** The instance repo (a local Git repo the reconciler clones). */
  repo: string;
  /** The reconciler's state directory, mounted at the same path. */
  state: string;
  ageKey: string;
  masterSecret: string;
  staticApiKey: string;
  /** Writes a file in the instance repo and commits it. */
  commit(files: Record<string, string | null>, message: string): void;
}

/**
 * A fresh instance repo, created from `template/` like `bivy init` will do,
 * with an encrypted secrets file. The real path is used everywhere: on a
 * Mac, tmpdir() is a symbolic link Docker would not resolve the same way.
 */
export function createPlatform(): Platform {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bivouac-e2e-")));
  const repo = join(root, "instance");
  const state = join(root, "state");
  const keys = join(root, "keys");
  mkdirSync(state);
  mkdirSync(keys, { mode: 0o700 });
  cpSync(join(REPO_ROOT, "template"), repo, { recursive: true });

  run("docker", ["run", "--rm", "--volume", `${keys}:/keys`, ALPINE_IMAGE, "sh", "-c",
    "apk add -q age >/dev/null && age-keygen -o /keys/age.key 2>/dev/null && chmod 644 /keys/age.key"]);
  const ageKey = join(keys, "age.key");
  const recipient = /age1[0-9a-z]+/.exec(readFileSync(ageKey, "utf8"))?.[0];
  if (!recipient) throw new Error("could not generate a test age key");

  const masterSecret = randomBytes(32).toString("hex");
  const staticApiKey = randomBytes(24).toString("hex");
  const plain = [
    `master_secret: ${masterSecret}`,
    "pocket_id:",
    `  encryption_key: ${randomBytes(32).toString("base64")}`,
    `  static_api_key: ${staticApiKey}`,
    "",
  ].join("\n");
  mkdirSync(join(repo, "secrets"), { recursive: true });
  writeFileSync(join(repo, ".sops.yaml"), `creation_rules:\n  - age: ${recipient}\n`);
  writeFileSync(join(root, "platform.yaml"), plain);
  const encrypted = run("docker", ["run", "--rm", "--volume", `${root}:/work`, "--workdir", "/work", SOPS_IMAGE,
    "encrypt", "--age", recipient, "--input-type", "yaml", "--output-type", "yaml", "platform.yaml"]);
  rmSync(join(root, "platform.yaml"));
  if (encrypted.status !== 0) throw new Error(`sops encrypt failed: ${encrypted.stderr}`);
  writeFileSync(join(repo, "secrets", "platform.sops.yaml"), encrypted.stdout);

  const sshKey = readFileSync(join(REPO_ROOT, "packages/manifest/fixtures/ssh-key.pub"), "utf8").trim();
  writeFileSync(join(repo, "platform.yml"), `domain: ${DOMAIN}\n`);
  writeFileSync(join(repo, "ssh-keys.yml"), `keys:\n  - name: fixture\n    key: ${sshKey}\n`);
  const git = (...args: string[]) => {
    const result = run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repo });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  };
  git("init", "--quiet", "--initial-branch=main");
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) rmSync(join(repo, file), { force: true });
      else writeFileSync(join(repo, file), content);
    }
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "--message", message);
  };
  commit({}, "initial");
  return { root, repo, state, ageKey, masterSecret, staticApiKey, commit };
}

/**
 * The reconciler container's options: the Docker socket, the instance repo
 * (read through `file://`), the state directory at the same path and the
 * age key, exactly as the systemd unit will mount them in production.
 */
function reconcilerOptions(platform: Platform, ageKey: string, ports: string): string[] {
  return [
    "--name", "bivouac-reconciler",
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", `${platform.repo}:${platform.repo}:ro`,
    "--volume", `${platform.state}:${platform.state}`,
    "--volume", `${ageKey}:/etc/bivouac/age.key:ro`,
    "--env", `BIVOUAC_REPOSITORY=file://${platform.repo}`,
    "--env", `BIVOUAC_STATE_DIR=${platform.state}`,
    "--env", `BIVOUAC_CADDY_PORTS=${ports}`,
    "--env", "BIVOUAC_HEALTH_TIMEOUT=60",
  ];
}

export interface PassOutput {
  status: number;
  /** The JSON lines the reconciler logged. */
  logs: { message: string; [key: string]: unknown }[];
}

/** Runs one reconciler pass (`main.js once`) and returns its exit code and logs. */
export function runOnce(platform: Platform, options: { ageKey?: string; ports?: string } = {}): PassOutput {
  const result = run("docker", [
    "run", "--rm",
    ...reconcilerOptions(platform, options.ageKey ?? platform.ageKey, options.ports ?? ""),
    RECONCILER_IMAGE, "node", "packages/reconciler/dist/main.js", "once",
  ]);
  const logs = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as PassOutput["logs"][number]);
  if (logs.length === 0) throw new Error(`the reconciler printed nothing: ${result.stderr}`);
  return { status: result.status, logs };
}

/** Starts the reconciler in the background, passing every 10 s (local platform). */
export function startReconciler(platform: Platform, ports: string): void {
  docker("run", "--detach", "--restart", "unless-stopped",
    ...reconcilerOptions(platform, platform.ageKey, ports),
    "--env", "BIVOUAC_INTERVAL_SECONDS=10",
    RECONCILER_IMAGE);
}

/**
 * An HTTPS request through Caddy, from a container on the internal network
 * (where Caddy has a fixed address).
 * Caddy serves `*.localhost` names with its own local certificate authority
 * (verified, Caddy 2.11.9), hence `--insecure`.
 */
export function throughCaddy(host: string, path: string, method = "GET"): { status: number; body: string } {
  const result = run("docker", ["run", "--rm", "--network", INTERNAL_NETWORK, CURL_IMAGE,
    "--silent", "--insecure", "--path-as-is", "--max-time", "10", "--write-out", "\n%{http_code}",
    "--request", method, "--resolve", `${host}:443:${CADDY_ADDRESS}`, `https://${host}${path}`]);
  const lines = result.stdout.split("\n");
  return { status: Number(lines.pop()), body: lines.join("\n") };
}

/** A call to Pocket ID's API, straight to its container (not through Caddy). */
export function pocketIdApi(platform: Platform, method: string, path: string): { status: number; body: unknown } {
  const result = run("docker", ["run", "--rm", "--network", INTERNAL_NETWORK, CURL_IMAGE,
    "--silent", "--max-time", "10", "--write-out", "\n%{http_code}", "--request", method,
    "--header", `X-API-KEY: ${platform.staticApiKey}`, `http://bivouac-pocket-id:1411${path}`]);
  const lines = result.stdout.split("\n");
  const status = Number(lines.pop());
  const text = lines.join("\n");
  return { status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

/** Pocket ID's token endpoint with a bogus code: `invalid_grant` means the secret is right. */
export function tokenAnswer(clientId: string, secret: string): string {
  const result = run("docker", ["run", "--rm", "--network", INTERNAL_NETWORK, CURL_IMAGE,
    "--silent", "--max-time", "10", "--user", `${clientId}:${secret}`,
    "--data", "grant_type=authorization_code&code=x&redirect_uri=https://invalid",
    "http://bivouac-pocket-id:1411/api/oidc/token"]);
  return (JSON.parse(result.stdout) as { error: string }).error;
}

/**
 * Runs SQL as `user` with a password, through the platform network like an
 * app would. Not through 127.0.0.1: the image trusts local connections
 * without a password (its default pg_hba.conf), which would hide a wrong one.
 */
export function psql(user: string, password: string, database: string, sql: string): CommandResult {
  return run("docker", ["exec", "--env", `PGPASSWORD=${password}`, "bivouac-postgres",
    "psql", "--host", "bivouac-postgres", "--username", user, "--dbname", database,
    "--no-align", "--tuples-only", "--command", sql]);
}

/** Whether a container on the apps network can open a connection to `url`. */
export function reachableFromApps(url: string): boolean {
  return run("docker", ["run", "--rm", "--network", "bivouac", CURL_IMAGE, "--silent", "--max-time", "5", "--output", "/dev/null", url]).status === 0;
}

export function inspect<T = Record<string, unknown>>(name: string): T {
  return (JSON.parse(docker("inspect", name)) as T[])[0] as T;
}
