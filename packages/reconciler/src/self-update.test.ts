import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Docker } from "./docker.js";
import { mkdirSync } from "node:fs";
import {
  IMAGE_ENV_FILE,
  REFUSED_FILE,
  SelfUpdater,
  TRIAL_FILE,
  TRIAL_STARTS_FILE,
  imageRepository,
  readDesiredImage,
} from "./self-update.js";

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

function updater(exitCode: number, calls: string[] = [], logs: string[] = [], refused?: string) {
  const stateDir = directory();
  mkdirSync(join(stateDir, "reconciler"));
  if (refused) writeFileSync(join(stateDir, REFUSED_FILE), `BIVOUAC_REFUSED_IMAGE=${refused}\n`);
  const self = new SelfUpdater({
    docker: fakeDocker(exitCode, calls),
    stateDir,
    current: CURRENT,
    pull: async (image) => void calls.push(`pull ${image}`),
    log: (message) => void logs.push(message),
  });
  return { self, stateDir, envFile: join(stateDir, IMAGE_ENV_FILE) };
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

  it("puts the new version on trial, with the one it leaves, before moving to it", async () => {
    const { self, stateDir } = updater(0);
    writeFileSync(join(stateDir, TRIAL_STARTS_FILE), "3\n");
    expect(await self.check(checkout(NEXT))).toBe(NEXT);
    expect(readFileSync(join(stateDir, TRIAL_FILE), "utf8")).toBe(`BIVOUAC_TRIAL_IMAGE=${NEXT}\nBIVOUAC_PREVIOUS_IMAGE=${CURRENT}\n`);
    expect(statSync(join(stateDir, TRIAL_FILE)).mode & 0o777).toBe(0o600);
    // A count left from an earlier trial never carries over.
    expect(existsSync(join(stateDir, TRIAL_STARTS_FILE))).toBe(false);
  });

  it("ends the trial once a pass has applied", () => {
    const logs: string[] = [];
    const { self, stateDir } = updater(0, [], logs);
    writeFileSync(join(stateDir, TRIAL_FILE), `BIVOUAC_TRIAL_IMAGE=${CURRENT}\nBIVOUAC_PREVIOUS_IMAGE=${NEXT}\n`);
    writeFileSync(join(stateDir, TRIAL_STARTS_FILE), "1\n");
    self.confirm();
    expect(existsSync(join(stateDir, TRIAL_FILE))).toBe(false);
    expect(existsSync(join(stateDir, TRIAL_STARTS_FILE))).toBe(false);
    expect(logs).toEqual(["new reconciler version confirmed"]);
    self.confirm();
    expect(logs).toHaveLength(1);
  });

  it("does not move again to a version the host rolled back from, and reports it until platform.yml changes", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const { self, stateDir, envFile } = updater(0, calls, logs, NEXT);
    expect(logs).toEqual(["a new reconciler version crashed at start: rolled back"]);
    expect(await self.check(checkout(NEXT))).toBeUndefined();
    expect(calls).toEqual([]);
    expect(existsSync(envFile)).toBe(false);
    expect(self.observation()).toEqual({
      incidents: [{ key: `reconciler:${NEXT}`, message: expect.stringMatching(/crashed at start, and the server went back to/) }],
      checked: ["reconciler"],
    });
    // Back to the running version: the incident ends, and so does the record.
    expect(await self.check(checkout(CURRENT))).toBeUndefined();
    expect(self.observation()).toEqual({ incidents: [], checked: ["reconciler"] });
    expect(existsSync(join(stateDir, REFUSED_FILE))).toBe(false);
  });

  it("moves to a newer version after a rollback", async () => {
    const { self, stateDir } = updater(0, [], [], NEXT);
    const fixed = "ghcr.io/example/bivouac-reconciler:sha-3333333";
    expect(await self.check(checkout(fixed))).toBe(fixed);
    expect(existsSync(join(stateDir, REFUSED_FILE))).toBe(false);
  });

  it("reports a version that failed its self-test while platform.yml names it", async () => {
    const { self } = updater(1);
    await self.check(checkout(NEXT));
    expect(self.observation().incidents).toEqual([{ key: `reconciler:${NEXT}`, message: expect.stringMatching(/self-test failed/) }]);
  });

  it("keeps the last version that proved itself when a version on trial moves on", async () => {
    const { self, stateDir } = updater(0);
    const proven = "ghcr.io/example/bivouac-reconciler:sha-0000000";
    writeFileSync(join(stateDir, TRIAL_FILE), `BIVOUAC_TRIAL_IMAGE=${CURRENT}\nBIVOUAC_PREVIOUS_IMAGE=${proven}\n`);
    expect(await self.check(checkout(NEXT))).toBe(NEXT);
    expect(readFileSync(join(stateDir, TRIAL_FILE), "utf8")).toBe(`BIVOUAC_TRIAL_IMAGE=${NEXT}\nBIVOUAC_PREVIOUS_IMAGE=${proven}\n`);
  });

  it("forgets a rollback when the server runs that version again", () => {
    const logs: string[] = [];
    const { self, stateDir } = updater(0, [], logs, CURRENT);
    expect(logs).toEqual([]);
    expect(existsSync(join(stateDir, REFUSED_FILE))).toBe(false);
    expect(self.observation().incidents).toEqual([]);
  });

  it("never moves from a digest back to a tag alone", async () => {
    const pinned = `${CURRENT}@sha256:${"b".repeat(64)}`;
    const stateDir = directory();
    const logs: string[] = [];
    const self = new SelfUpdater({
      docker: fakeDocker(0, []),
      stateDir,
      current: pinned,
      pull: async () => undefined,
      log: (message) => void logs.push(message),
    });
    expect(await self.check(checkout(NEXT))).toBeUndefined();
    expect(self.observation().incidents).toEqual([{ key: `reconciler:${NEXT}`, message: expect.stringMatching(/not pinned by digest/) }]);
    const next = `${NEXT}@sha256:${"c".repeat(64)}`;
    expect(await self.check(checkout(next))).toBe(next);
  });
});
