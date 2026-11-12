import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, appBeingRestored, clearStaleLock, interruptedRestore, readLock, releaseLock } from "./lock.js";
import { chooseSnapshot, parseRestoreArgs, previousName, restoringName, type Snapshot } from "./restore.js";

describe("restore-app arguments", () => {
  it("only says what it would do without --yes", () => {
    expect(parseRestoreArgs(["biblio"])).toEqual({ app: "biblio", list: false, yes: false });
  });

  it("reads a copy, a date and a part", () => {
    expect(parseRestoreArgs(["biblio", "--snapshot", "055d7d51", "--only", "files", "--yes"])).toMatchObject({ snapshot: "055d7d51", only: "files", yes: true });
    expect(parseRestoreArgs(["biblio", "--before", "2026-11-11"]).before).toBe(Date.parse("2026-11-11T23:59:59Z"));
    expect(parseRestoreArgs(["biblio", "--before", "2026-11-12T08:00Z"]).before).toBe(Date.parse("2026-11-12T08:00Z"));
  });

  it("refuses what it does not understand", () => {
    expect(() => parseRestoreArgs([])).toThrow(/usage/);
    expect(() => parseRestoreArgs(["--yes"])).toThrow(/usage/);
    expect(() => parseRestoreArgs(["biblio", "--snapshot", "latest"])).toThrow(/snapshot ID/);
    expect(() => parseRestoreArgs(["biblio", "--snapshot"])).toThrow(/needs a value/);
    expect(() => parseRestoreArgs(["biblio", "--before", "yesterday"])).toThrow(/not a date/);
    expect(() => parseRestoreArgs(["biblio", "--only", "everything"])).toThrow(/database/);
    expect(() => parseRestoreArgs(["biblio", "--snapshot", "055d7d51", "--before", "2026-11-11"])).toThrow(/together/);
    expect(() => parseRestoreArgs(["biblio", "--force"])).toThrow(/unknown option/);
  });
});

describe("choosing the copy", () => {
  const copies: Snapshot[] = [
    { id: "aaaa1111ffff", short_id: "aaaa1111", time: "2026-11-10T02:00:19Z", tags: ["nightly"] },
    { id: "bbbb2222ffff", short_id: "bbbb2222", time: "2026-11-11T02:00:42Z", tags: ["nightly"] },
    { id: "cccc3333ffff", short_id: "cccc3333", time: "2026-11-11T09:00:00Z", tags: ["pre-restore", "app:biblio"] },
    { id: "dddd4444ffff", short_id: "dddd4444", time: "2026-11-12T02:00:56Z", tags: ["incomplete"] },
  ];

  it("takes the latest nightly copy, never an incomplete or a pre-restore one", () => {
    expect(chooseSnapshot(copies, {}).short_id).toBe("bbbb2222");
  });

  it("takes the latest nightly copy at or before a date", () => {
    expect(chooseSnapshot(copies, { before: Date.parse("2026-11-10T23:59:59Z") }).short_id).toBe("aaaa1111");
    expect(() => chooseSnapshot(copies, { before: Date.parse("2026-11-09T00:00:00Z") })).toThrow(/no nightly copy/);
  });

  it("takes any copy named, by its short or full ID", () => {
    expect(chooseSnapshot(copies, { snapshot: "cccc3333" }).short_id).toBe("cccc3333");
    expect(chooseSnapshot(copies, { snapshot: "dddd4444ffff" }).short_id).toBe("dddd4444");
    expect(() => chooseSnapshot(copies, { snapshot: "eeee5555" })).toThrow(/no copy/);
  });
});

describe("database names during a restore", () => {
  const longest = "a".repeat(40);

  it("fit in Postgres's 63 bytes for the longest app name", () => {
    expect(restoringName(longest).length).toBeLessThanOrEqual(63);
    expect(previousName(longest, new Date()).length).toBeLessThanOrEqual(63);
  });

  it("can never be an app's: apps cannot be named bivouac…", () => {
    expect(previousName("biblio", new Date("2026-11-12T19:12:35Z"))).toBe("bivouac_r2611121912_biblio");
    expect(restoringName("biblio")).toBe("bivouac_restoring_biblio");
  });
});

describe("the lock shared by backups and restores", () => {
  let stateDir = "";
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));
  const fresh = () => (stateDir = mkdtempSync(join(tmpdir(), "bivouac-lock-")));

  it("lets one job in at a time", () => {
    fresh();
    expect(acquireLock(stateDir, { job: "restore", app: "biblio", startedAt: 1 })).toBeUndefined();
    expect(acquireLock(stateDir, { job: "backup", startedAt: 2 })).toMatchObject({ job: "restore", app: "biblio" });
    expect(appBeingRestored(stateDir)).toBe("biblio");
    releaseLock(stateDir);
    expect(acquireLock(stateDir, { job: "backup", startedAt: 3 })).toBeUndefined();
    expect(appBeingRestored(stateDir)).toBeUndefined();
  });

  it("turns a restore left behind at startup into an interrupted one", () => {
    fresh();
    acquireLock(stateDir, { job: "restore", app: "biblio", startedAt: 1 });
    expect(clearStaleLock(stateDir)).toMatchObject({ app: "biblio" });
    expect(readLock(stateDir)).toBeUndefined();
    expect(interruptedRestore(stateDir)).toBe("biblio");
  });

  it("simply removes a backup left behind", () => {
    fresh();
    acquireLock(stateDir, { job: "backup", startedAt: 1 });
    clearStaleLock(stateDir);
    expect(readLock(stateDir)).toBeUndefined();
    expect(interruptedRestore(stateDir)).toBeUndefined();
  });
});
