import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appManifestSchema } from "@bivouac/manifest";
import { chooseRebuildSnapshot, parsePlatformRestoreArgs, readRebuildState, rebuildTargets } from "./rebuild.js";
import type { Snapshot } from "./restore.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "bivouac-rebuild-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the rebuild marker (D91)", () => {
  it("is absent on a server that is not being rebuilt", () => {
    const dir = temp();
    expect(readRebuildState(join(dir, "rebuild.json"), dir)).toBeUndefined();
  });

  it("waits for the data until restore-platform has brought it back", () => {
    const dir = temp();
    const marker = join(dir, "rebuild.json");
    writeFileSync(marker, '{"mode":"test"}');
    expect(readRebuildState(marker, dir)).toEqual({ mode: "test", waiting: true });
    mkdirSync(join(dir, "rebuild"));
    writeFileSync(join(dir, "rebuild", "restored.json"), "{}");
    expect(readRebuildState(marker, dir)).toEqual({ mode: "test", waiting: false });
  });

  it("stops the pass when it cannot be read, rather than guess", () => {
    const dir = temp();
    const marker = join(dir, "rebuild.json");
    for (const content of ["", "{", '{"mode":"prod"}', '{"mode":"test","extra":1}']) {
      writeFileSync(marker, content);
      expect(() => readRebuildState(marker, dir)).toThrow(/cannot be read/);
    }
  });
});

describe("restore-platform", () => {
  const snapshots: Snapshot[] = [
    { id: "aaaaaaaa11", short_id: "aaaaaaaa", time: "2026-11-12T02:00:00Z", tags: ["nightly"] },
    { id: "bbbbbbbb22", short_id: "bbbbbbbb", time: "2026-11-13T02:00:00Z", tags: ["nightly"] },
    { id: "cccccccc33", short_id: "cccccccc", time: "2026-11-13T09:00:00Z", tags: ["pre-restore", "app:biblio"] },
    { id: "dddddddd44", short_id: "dddddddd", time: "2026-11-14T02:00:00Z", tags: ["incomplete"] },
  ];

  it("starts from the latest nightly copy, never an incomplete or single-app one", () => {
    expect(chooseRebuildSnapshot(snapshots).short_id).toBe("bbbbbbbb");
    expect(chooseRebuildSnapshot(snapshots, "aaaaaaaa").short_id).toBe("aaaaaaaa");
    expect(() => chooseRebuildSnapshot(snapshots, "eeeeeeee")).toThrow(/no copy/);
    expect(() => chooseRebuildSnapshot([])).toThrow(/no nightly copy/);
  });

  it("restores Pocket ID first, then each app's database and volumes", () => {
    const apps = [
      appManifestSchema.parse({ name: "biblio", image: "ghcr.io/x/biblio:sha-1234567", groups: ["g"], database: {}, volumes: { books: "/app/uploads" } }),
      appManifestSchema.parse({ name: "site", image: "ghcr.io/x/site:sha-1234567", auth: "public" }),
    ];
    expect(rebuildTargets(apps)).toEqual({
      databases: ["bivouac_pocket_id", "biblio"],
      volumes: [{ app: "biblio", volume: "bivouac-app-biblio_books" }],
    });
  });

  it("only says what it would do without --yes", () => {
    expect(parsePlatformRestoreArgs([])).toEqual({ list: false, yes: false });
    expect(parsePlatformRestoreArgs(["--snapshot", "bbbbbbbb", "--yes"])).toEqual({ list: false, yes: true, snapshot: "bbbbbbbb" });
    expect(() => parsePlatformRestoreArgs(["--snapshot", "latest"])).toThrow(/snapshot ID/);
    expect(() => parsePlatformRestoreArgs(["--force"])).toThrow(/unknown option/);
  });
});
