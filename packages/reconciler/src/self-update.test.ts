import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Docker } from "./docker.js";
import { IMAGE_ENV_FILE, SelfUpdater, imageRepository, readDesiredImage } from "./self-update.js";

const CURRENT = "ghcr.io/example/bivouac-reconciler:sha-1111111";
const NEXT = "ghcr.io/example/bivouac-reconciler:sha-2222222";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "bivouac-self-update-"));
  roots.push(root);
  return root;
}

/** A checkout whose platform.yml names `image`, next to fields an older reconciler may not know. */
function checkout(image: string): string {
  const root = directory();
  writeFileSync(join(root, "platform.yml"), `domain: apps.example.com\nsomething_new: true\nreconciler:\n  image: ${image}\n`);
  return root;
}

/** A Docker engine where every image exists and the self-test exits with `exitCode`. */
function fakeDocker(exitCode: number, calls: string[]): Docker {
  return {
    imageExists: async () => true,
    removeContainer: async () => void calls.push("remove"),
    createContainer: async (_name: string, body: { Image: string }) => void calls.push(`create ${body.Image}`),
    startContainer: async () => void calls.push("start"),
    waitContainer: async () => exitCode,
    logs: async () => "{\"message\":\"selftest failed\"}\n",
  } as unknown as Docker;
}

function updater(exitCode: number, calls: string[] = [], logs: string[] = []) {
  const stateDir = directory();
  const self = new SelfUpdater({
    docker: fakeDocker(exitCode, calls),
    stateDir,
    current: CURRENT,
    pull: async (image) => void calls.push(`pull ${image}`),
    log: (message) => void logs.push(message),
  });
  return { self, envFile: join(stateDir, IMAGE_ENV_FILE) };
}

describe("self-update", () => {
  it("reads the version on its own, even when the rest of platform.yml is unknown", () => {
    expect(readDesiredImage(checkout(NEXT))).toBe(NEXT);
    expect(readDesiredImage(checkout("ghcr.io/example/bivouac-reconciler:latest"))).toBeUndefined();
    expect(readDesiredImage(checkout("ghcr.io/example/other:sha-2222222"))).toBeUndefined();
    const broken = directory();
    writeFileSync(join(broken, "platform.yml"), "reconciler: [\n");
    expect(readDesiredImage(broken)).toBeUndefined();
    expect(readDesiredImage(directory())).toBeUndefined();
  });

  it("knows an image's repository whatever its tag or digest", () => {
    expect(imageRepository(NEXT)).toBe("ghcr.io/example/bivouac-reconciler");
    expect(imageRepository(`ghcr.io/example/bivouac-reconciler:sha-1@sha256:${"a".repeat(64)}`)).toBe(
      "ghcr.io/example/bivouac-reconciler",
    );
    expect(imageRepository("localhost:5000/x/bivouac-reconciler")).toBe("localhost:5000/x/bivouac-reconciler");
  });

  it("does nothing when platform.yml names the running version", async () => {
    const calls: string[] = [];
    const { self, envFile } = updater(0, calls);
    expect(await self.check(checkout(CURRENT))).toBeUndefined();
    expect(calls).toEqual([]);
    expect(existsSync(envFile)).toBe(false);
  });

  it("moves to a new version once its self-test passes", async () => {
    const calls: string[] = [];
    const { self, envFile } = updater(0, calls);
    expect(await self.check(checkout(NEXT))).toBe(NEXT);
    expect(calls).toEqual(["remove", `create ${NEXT}`, "start", "remove"]);
    expect(readFileSync(envFile, "utf8")).toBe(`BIVOUAC_RECONCILER_IMAGE=${NEXT}\n`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("refuses another publisher's image, once", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const { self, envFile } = updater(0, calls, logs);
    const foreign = checkout("ghcr.io/someone-else/bivouac-reconciler:sha-2222222");
    expect(await self.check(foreign)).toBeUndefined();
    expect(await self.check(foreign)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(logs).toEqual(["new reconciler version refused: staying on the current one"]);
    expect(existsSync(envFile)).toBe(false);
  });

  it("stays on the current version when the new one fails its self-test, and does not retry it", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const { self, envFile } = updater(1, calls, logs);
    expect(await self.check(checkout(NEXT))).toBeUndefined();
    expect(await self.check(checkout(NEXT))).toBeUndefined();
    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(logs).toEqual(["moving to a new reconciler version", "new reconciler version refused: staying on the current one"]);
    expect(existsSync(envFile)).toBe(false);
  });
});
