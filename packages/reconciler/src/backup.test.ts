import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appManifestSchema } from "@bivouac/manifest";
import type { Runtime } from "./base.js";
import { BackupScheduler, backupPlan, backupWeek, dumpsFit, markLatestIncomplete, parseCount, retentionCommands, isDue, restartPaused, type BackupPlan } from "./backup.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const at = (day: number, hour: number) => day * DAY + hour * HOUR;
const plan = { ping: "https://hc-ping.com/job", restorePing: "https://hc-ping.com/restore", databases: [], volumes: [], stop: [] } as unknown as BackupPlan;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup(run: (plan: BackupPlan) => Promise<void> = async () => {}, stateDir = mkdtempSync(join(tmpdir(), "bivouac-backup-")), fresh = false, maintain: (plan: BackupPlan) => Promise<void> = async () => {}, restore: (plan: BackupPlan) => Promise<void> = async () => {}) {
  roots.push(stateDir);
  // Tests start from a server that has already run; `fresh` is a new one.
  if (!fresh) {
    mkdirSync(join(stateDir, "backup"), { recursive: true });
    writeFileSync(join(stateDir, "backup", "state.json"), JSON.stringify({ attempts: 1, day: 50 }));
  }
  const clock = { now: at(100, 3) };
  const pings: string[] = [];
  const logs: string[] = [];
  const scheduler = new BackupScheduler({
    runtime: { stateDir } as Runtime,
    log: (message, fields) => logs.push(JSON.stringify({ message, ...fields })),
    run,
    maintain,
    restore,
    now: () => clock.now,
    fetch: (async (url: string) => { pings.push(String(url)); return new Response("OK"); }) as unknown as typeof globalThis.fetch,
  });
  scheduler.update(plan);
  return { scheduler, clock, pings, logs, stateDir };
}

describe("when a backup is due", () => {
  it("runs once per backup day, which starts at 02:00 UTC", () => {
    const done = { attempts: 1, day: 100 };
    expect(isDue(done, at(101, 1))).toBe(false);
    expect(isDue(done, at(101, 2))).toBe(true);
  });

  it("catches up after the server was off at the usual hour", () => {
    expect(isDue({ attempts: 1, day: 90 }, at(100, 15))).toBe(true);
  });

  it("retries a failure once, an hour later", () => {
    const failed = { attempts: 1, day: 100, lastAttemptAt: at(100, 3), lastError: "x" };
    expect(isDue(failed, at(100, 3) + HOUR - 1)).toBe(false);
    expect(isDue(failed, at(100, 3) + HOUR)).toBe(true);
    expect(isDue({ ...failed, attempts: 2 }, at(100, 20))).toBe(false);
  });
});

describe("the scheduler", () => {
  it("tells healthchecks.io the start and the end", async () => {
    const { scheduler, pings } = setup();
    scheduler.tick();
    await scheduler.idle();
    expect(pings.slice(0, 2)).toEqual(["https://hc-ping.com/job/start", "https://hc-ping.com/job"]);
    expect(scheduler.observation()).toEqual({ incidents: [], checked: ["backup"] });
  });

  it("does not run twice on the same day", async () => {
    let runs = 0;
    const { scheduler } = setup(async () => { runs += 1; });
    scheduler.tick();
    await scheduler.idle();
    scheduler.tick();
    await scheduler.idle();
    expect(runs).toBe(1);
  });

  it("never starts a second run beside the first", async () => {
    let runs = 0;
    let finish = () => {};
    const { scheduler } = setup(() => { runs += 1; return new Promise<void>((resolve) => { finish = resolve; }); });
    scheduler.tick();
    scheduler.tick();
    await vi.waitFor(() => expect(runs).toBe(1));
    scheduler.tick();
    expect(runs).toBe(1);
    expect(scheduler.observation()).toEqual({ incidents: [], checked: [] });
    finish();
    await scheduler.idle();
  });

  it("reports a failure, then clears it when a retry works", async () => {
    let fail = true;
    const { scheduler, clock, pings } = setup(async () => { if (fail) throw new Error("no network"); });
    scheduler.tick();
    await scheduler.idle();
    expect(pings).toContain("https://hc-ping.com/job/fail");
    expect(scheduler.observation().incidents[0]).toMatchObject({ key: "backup:nightly", message: expect.stringContaining("no network") });
    fail = false;
    clock.now += HOUR;
    scheduler.tick();
    await scheduler.idle();
    expect(scheduler.observation().incidents).toEqual([]);
  });

  it("counts a run cut short by a restart as failed", async () => {
    let finish = () => {};
    let started = false;
    const first = setup(() => { started = true; return new Promise<void>((resolve) => { finish = resolve; }); });
    first.scheduler.tick();
    await vi.waitFor(() => expect(started).toBe(true));
    const restarted = setup(async () => {}, first.stateDir, true);
    expect(restarted.scheduler.observation().incidents[0]?.message).toContain("interrupted");
    finish();
    await first.scheduler.idle();
  });

  it("does nothing until it knows what to back up", () => {
    const { scheduler, pings } = setup();
    scheduler.update(undefined);
    scheduler.tick();
    expect(pings).toEqual([]);
  });

  it("waits for the next night on a new server, whose platform is still empty", () => {
    const { scheduler, pings } = setup(async () => {}, undefined, true);
    scheduler.tick();
    expect(scheduler.busy).toBe(false);
    expect(pings).toEqual([]);
  });

  it("never logs the ping address", async () => {
    const { scheduler, logs } = setup(async () => { throw new Error("x"); });
    scheduler.tick();
    await scheduler.idle();
    expect(logs.join()).not.toContain("hc-ping");
  });
});

describe("the weekly clean-up", () => {
  const nextNight = async (entry: ReturnType<typeof setup>) => {
    entry.clock.now += DAY;
    entry.scheduler.tick();
    await entry.scheduler.idle();
  };

  it("runs once a week, after a backup", async () => {
    let cleanups = 0;
    const entry = setup(async () => {}, undefined, false, async () => { cleanups += 1; });
    for (let night = 0; night < 14; night += 1) await nextNight(entry);
    expect(cleanups).toBeGreaterThanOrEqual(2);
    expect(cleanups).toBeLessThanOrEqual(3);
  });

  it("starts its weeks on Sunday", () => {
    const sunday = Date.UTC(2026, 10, 8, 3);
    expect(backupWeek(sunday)).toBe(backupWeek(Date.UTC(2026, 10, 14, 3)));
    expect(backupWeek(sunday)).not.toBe(backupWeek(Date.UTC(2026, 10, 15, 3)));
  });

  it("never runs after a backup that failed", async () => {
    let cleanups = 0;
    const entry = setup(async () => { throw new Error("no network"); }, undefined, false, async () => { cleanups += 1; });
    await nextNight(entry);
    expect(cleanups).toBe(0);
  });

  it("reports its failure apart from the backup, and tries again the next night", async () => {
    let fail = true;
    let cleanups = 0;
    const entry = setup(async () => {}, undefined, false, async () => { cleanups += 1; if (fail) throw new Error("locked"); });
    await nextNight(entry);
    expect(entry.scheduler.observation().incidents.map((incident) => incident.key)).toEqual(["backup:retention"]);
    expect(entry.pings).not.toContain("https://hc-ping.com/job/fail");
    fail = false;
    await nextNight(entry);
    expect(cleanups).toBe(2);
    expect(entry.scheduler.observation().incidents).toEqual([]);
  });

  it("keeps 7 days, 4 weeks and 6 months, and never looks at archives", () => {
    const [nightly, incomplete, prune] = retentionCommands();
    expect(nightly).toEqual(["forget", "--host", "bivouac", "--tag", "nightly", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6"]);
    expect(incomplete).toContain("--keep-within");
    expect(prune).toEqual(["prune"]);
    expect(retentionCommands().flat()).not.toContain("archive");
    expect(retentionCommands().flat()).not.toContain("--prune");
  });
});

describe("the weekly restore test", () => {
  const nextNight = async (entry: ReturnType<typeof setup>) => {
    entry.clock.now += DAY;
    entry.scheduler.tick();
    await entry.scheduler.idle();
  };

  it("runs once a week, after the backup, and tells healthchecks.io", async () => {
    let tests = 0;
    const entry = setup(async () => {}, undefined, false, undefined, async () => { tests += 1; });
    await nextNight(entry);
    await nextNight(entry);
    expect(tests).toBeGreaterThanOrEqual(1);
    expect(tests).toBeLessThanOrEqual(2);
    expect(entry.pings).toContain("https://hc-ping.com/restore/start");
    expect(entry.pings).toContain("https://hc-ping.com/restore");
  });

  it("does not run after a backup that failed", async () => {
    let tests = 0;
    const entry = setup(async () => { throw new Error("x"); }, undefined, false, undefined, async () => { tests += 1; });
    await nextNight(entry);
    expect(tests).toBe(0);
  });

  it("reports a failure on its own check, and tries again the next night", async () => {
    let fail = true;
    let tests = 0;
    const entry = setup(async () => {}, undefined, false, undefined, async () => { tests += 1; if (fail) throw new Error("empty dump"); });
    await nextNight(entry);
    expect(entry.pings).toContain("https://hc-ping.com/restore/fail");
    expect(entry.pings).not.toContain("https://hc-ping.com/job/fail");
    expect(entry.scheduler.observation().incidents[0]).toMatchObject({ key: "backup:restore", message: expect.stringContaining("empty dump") });
    fail = false;
    await nextNight(entry);
    expect(tests).toBe(2);
    expect(entry.scheduler.observation().incidents).toEqual([]);
  });
});

describe("apps stopped by a backup", () => {
  const stateDir = () => {
    const directory = mkdtempSync(join(tmpdir(), "bivouac-backup-"));
    roots.push(directory);
    mkdirSync(join(directory, "backup"));
    return directory;
  };
  const list = (directory: string) => writeFileSync(join(directory, "backup", "paused.json"), JSON.stringify([{ app: "a", container: "c-a" }]));

  it("are started again after a crash, and forgotten", async () => {
    const directory = stateDir();
    list(directory);
    const started: string[] = [];
    const runtime = { stateDir: directory, pausedApps: new Set(["a"]), docker: {
      inspectContainer: async () => ({ State: { Running: false } }),
      startContainer: async (name: string) => { started.push(name); },
    } } as unknown as Runtime;
    expect(await restartPaused(runtime)).toEqual([]);
    expect(started).toEqual(["c-a"]);
    expect(runtime.pausedApps.size).toBe(0);
    expect(existsSync(join(directory, "backup", "paused.json"))).toBe(false);
  });

  it("stay listed when they cannot be started, to be tried again", async () => {
    const directory = stateDir();
    list(directory);
    const runtime = { stateDir: directory, pausedApps: new Set(["a"]), docker: {
      inspectContainer: async () => ({ State: { Running: false } }),
      startContainer: async () => { throw new Error("docker busy"); },
    } } as unknown as Runtime;
    expect(await restartPaused(runtime)).toHaveLength(1);
    expect(existsSync(join(directory, "backup", "paused.json"))).toBe(true);
  });
});

describe("after a restart in the middle of a run", () => {
  it("removes the containers first, then the data they used", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bivouac-backup-"));
    roots.push(stateDir);
    mkdirSync(join(stateDir, "backup", "dumps"), { recursive: true });
    mkdirSync(join(stateDir, "backup", "restore-test"), { recursive: true });
    const removed: string[] = [];
    const runtime = { stateDir, pausedApps: new Set<string>(), docker: {
      removeContainer: async (name: string) => { removed.push(`${name}:${existsSync(join(stateDir, "backup", "dumps"))}`); },
    } } as unknown as Runtime;
    const scheduler = new BackupScheduler({ runtime, log: () => {} });
    await scheduler.recover();
    await scheduler.recover();
    expect(removed).toEqual([
      "bivouac-backup:true", "bivouac-backup-dump:true", "bivouac-restore-test:true",
      "bivouac-restore-app:true", "bivouac-restore-app-dump:true", "bivouac-restore-app-load:true", "bivouac-restore-app-files:true",
    ]);
    expect(existsSync(join(stateDir, "backup", "dumps"))).toBe(false);
    expect(existsSync(join(stateDir, "backup", "restore-test"))).toBe(false);
  });
});

describe("reading the restored copy", () => {
  it("refuses an answer that is not a number", () => {
    expect(parseCount(" 35\n", "x")).toBe(35);
    expect(() => parseCount("", "x")).toThrow();
    expect(() => parseCount("NaN", "x")).toThrow();
    expect(() => parseCount("1 row", "x")).toThrow();
  });

  it("marks only the latest snapshot of this host", () => {
    expect(markLatestIncomplete()).toEqual(["tag", "--host", "bivouac", "--set", "incomplete", "latest"]);
  });
});

describe("room for the dumps", () => {
  it("leaves part of the free space", () => {
    expect(dumpsFit(80, 100)).toBe(true);
    expect(dumpsFit(81, 100)).toBe(false);
  });
});

describe("what gets backed up", () => {
  const platform = { backup: { repository: "s3:https://s3.some-region-001.example.com/some-bucket" } } as never;
  const secrets = {
    master_secret: "m",
    backup: { restic_password: "p", b2_key_id: "i", b2_application_key: "k" },
    alerts: { healthchecks: { backup: "https://hc-ping.com/b" } },
  } as never;
  const app = (fields: object) => appManifestSchema.parse({ image: "ghcr.io/example/x:sha-abc123", groups: ["g"], ...fields });

  it("lists Pocket ID's database, the apps' databases and volumes", () => {
    const result = backupPlan(platform, [app({ name: "my-app", database: {}, volumes: { uploads: "/u" } }), app({ name: "plain" })], secrets);
    expect(result).toMatchObject({
      region: "some-region-001",
      databases: ["bivouac_pocket_id", "my_app"],
      volumes: ["bivouac-app-my-app_uploads"],
      stop: [],
      ping: "https://hc-ping.com/b",
    });
  });

  it("stops only the apps that ask for it and have files", () => {
    const result = backupPlan(platform, [
      app({ name: "lite", volumes: { data: "/d" }, backup: { stop: true } }),
      app({ name: "nofiles", backup: { stop: true } }),
    ], secrets);
    expect(result?.stop).toEqual([{ app: "lite", container: "bivouac-app-lite" }]);
  });

  it("is off without its configuration or its secrets", () => {
    expect(backupPlan({} as never, [], secrets)).toBeUndefined();
    expect(backupPlan(platform, [], {} as never)).toBeUndefined();
  });
});
