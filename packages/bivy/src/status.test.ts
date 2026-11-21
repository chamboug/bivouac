import { describe, expect, it } from "vitest";
import { TOO_OLD, StatusError, backupStep, describeState, readState, reconcilerCommand, type PlatformState } from "./status.js";

const GIB = 1024 ** 3;

function state(change: (value: PlatformState) => void = () => {}): PlatformState {
  const value: PlatformState = {
    generatedAt: "2026-11-21T12:00:00.000Z",
    reconciler: { image: "ghcr.io/x/bivouac-reconciler:sha-4a764e9@sha256:abc", startedAt: "2026-11-20T18:22:58.000Z" },
    lastPass: { at: "2026-11-21T11:59:30.000Z", status: "unchanged", commit: "a290d48aaaaaaa", changes: [], failures: [] },
    containers: [
      { name: "bivouac-app-biblio", kind: "app", image: "i", state: "running", health: "healthy", startedAt: "2026-11-19T20:15:56Z", restarts: 0, oomKilled: false, memory: { usedBytes: 120 * 1024 ** 2, limitBytes: GIB } },
      { name: "bivouac-reconciler", kind: "platform", image: "i", state: "running", health: null, startedAt: "2026-11-20T18:22:58Z", restarts: 0, oomKilled: false, memory: null },
    ],
    backup: { lastSuccessAt: "2026-11-21T02:01:00.000Z", lastAttemptAt: "2026-11-21T02:00:00.000Z", lastError: null, restoreTestWeekPassed: 2968, restoreError: null, maintenanceError: null },
    incidents: [],
    host: {
      bootedAt: "2026-11-15T09:30:00.000Z",
      disk: { totalBytes: 38 * GIB, availableBytes: 21 * GIB },
      memory: { totalBytes: 4 * GIB, availableBytes: 2 * GIB },
      swap: { totalBytes: 2 * GIB, freeBytes: 2 * GIB },
    },
  };
  change(value);
  return value;
}

describe("bivy status", () => {
  it("never sends an unknown command to an older reconciler, which would start a second loop", () => {
    const command = reconcilerCommand("status");
    expect(command).toMatch(/^if docker exec bivouac-reconciler grep -qF '"backup-now"' packages\/reconciler\/dist\/main\.js; then exec docker exec bivouac-reconciler node packages\/reconciler\/dist\/main\.js status; else /);
    expect(command).toContain(`exit ${TOO_OLD}`);
    expect(reconcilerCommand("backup-now", ["--restore-test"])).toContain("main.js backup-now --restore-test;");
  });

  it("reads the server's answer, and says when the reconciler is too old", () => {
    const answer = { status: 0, stdout: `some noise\n${JSON.stringify(state())}\n`, stderr: "" };
    expect(readState(answer).lastPass?.commit).toBe("a290d48aaaaaaa");
    expect(() => readState({ status: TOO_OLD, stdout: "", stderr: "" })).toThrow(/older than this command/);
    expect(() => readState({ status: 1, stdout: `${JSON.stringify({ message: "pass failed" })}\n`, stderr: "" })).toThrow(StatusError);
  });

  it("finds nothing to look at on a healthy platform", () => {
    const { lines, problems } = describeState(state(), "UTC");
    expect(problems).toEqual([]);
    expect(lines.join("\n")).toContain("sha-4a764e9");
    expect(lines.join("\n")).toContain("restore test passed this week");
    expect(lines.join("\n")).toContain("swap 2.0 GB");
  });

  it("names each thing worth a look, in one sentence", () => {
    const { problems } = describeState(state((value) => {
      value.lastPass = { at: "2026-11-21T11:00:00.000Z", status: "applied", changes: [], failures: [{ app: "colis", message: "health check failed" }] };
      value.containers[0] = { ...value.containers[0]!, restarts: 2, oomKilled: true, health: "unhealthy" };
      value.backup = { ...value.backup!, lastSuccessAt: "2026-11-19T02:01:00.000Z", lastError: "bucket missing", restoreTestWeekPassed: 2965 };
      value.incidents = [{ key: "disk:host", message: "Disk 85%", since: "2026-11-21T10:00:00.000Z" }];
      value.host.disk.availableBytes = 4 * GIB;
      value.host.swap.totalBytes = 0;
    }), "UTC");
    expect(problems).toEqual([
      "No pass since Sat 21 Nov, 11:00: the reconciler may be stuck.",
      "colis: health check failed",
      "The disk is 89% full.",
      "No swap: the 2 GiB of zram did not come back (D94).",
      "No good backup since Thu 19 Nov, 02:01.",
      "The last backup failed: bucket missing",
      "The weekly restore test has not passed for 3 weeks.",
      "bivouac-app-biblio is unhealthy.",
      "bivouac-app-biblio was killed for using too much memory.",
      "bivouac-app-biblio restarted 2 times.",
      "Open incident since Sat 21 Nov, 10:00: Disk 85%",
    ]);
  });

  it("says a stopped container and a server with no backup yet", () => {
    const { problems } = describeState(state((value) => {
      value.containers[0] = { ...value.containers[0]!, state: "exited", health: null };
      value.backup = null;
    }), "UTC");
    expect(problems).toContain("bivouac-app-biblio is exited.");
    expect(problems).toContain("No backup on record on this server.");
  });
});

describe("bivy backup", () => {
  it("says each step of the server's run in a sentence", () => {
    expect(backupStep({ message: "backup requested", restoreTest: true })).toContain("with a restore test");
    expect(backupStep({ message: "backup starting" })).toContain("Backing up");
    expect(backupStep({ message: "backup done", restore: "passed" })).toBe("Backup done, and the restore test passed");
    expect(backupStep({ message: "backup failed", error: "bucket missing" })).toBe("The backup failed: bucket missing");
    expect(backupStep({ message: "still waiting", reason: "a restore of biblio is running" })).toBe("Still waiting: a restore of biblio is running");
    expect(backupStep({ message: "backup asked for now" })).toBeUndefined();
  });
});
