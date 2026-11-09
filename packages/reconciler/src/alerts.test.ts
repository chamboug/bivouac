import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIRMATIONS, DAILY_MESSAGE_LIMIT, REBUILD_REMINDER_DAYS, Watch, loadAlertCredentials, observePass, redact, saveAlertCredentials, type PassOutcome } from "./alerts.js";
import { SecretsError } from "./secrets.js";

const DAY = 24 * 3600_000;
const credentials = {
  pushover_token: "token-value",
  pushover_user: "user-value",
  healthchecks: { heartbeat: "https://hc-ping.com/heartbeat", backup: "https://hc-ping.com/backup", restore: "https://hc-ping.com/restore" },
};
const healthy: PassOutcome = { result: { status: "unchanged", commit: "abc", changes: [], failures: [] } };
const appFails: PassOutcome = { result: { status: "unchanged", commit: "abc", changes: [], failures: [{ app: "recipes", message: "unhealthy" }] } };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup(options: { status?: () => number; disk?: () => number; withCredentials?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "bivouac-alerts-"));
  roots.push(stateDir);
  if (options.withCredentials !== false) saveAlertCredentials(stateDir, credentials);
  const clock = { now: 1_000_000 };
  const messages: { title: string; message: string; priority: string | null }[] = [];
  const pings: string[] = [];
  const logs: string[] = [];
  const fetcher = (async (url: string, init: { body?: URLSearchParams }) => {
    if (String(url).includes("hc-ping")) {
      pings.push(String(url));
      return new Response("OK");
    }
    const status = options.status?.() ?? 200;
    if (status === 200) messages.push({ title: init.body!.get("title")!, message: init.body!.get("message")!, priority: init.body!.get("priority") });
    return new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  const watch = new Watch({
    stateDir,
    log: (message, fields) => logs.push(JSON.stringify({ message, ...fields })),
    fetch: fetcher,
    now: () => clock.now,
    disk: options.disk ?? (() => 10),
  });
  const passes = async (outcome: PassOutcome, count: number) => {
    for (let index = 0; index < count; index += 1) await watch.afterPass(outcome);
  };
  return { stateDir, clock, messages, pings, logs, watch, passes };
}

describe("one alert per incident (D45)", () => {
  it("stays quiet until a problem is seen on several passes in a row", async () => {
    const { messages, passes } = setup();
    await passes(appFails, CONFIRMATIONS - 1);
    expect(messages).toEqual([]);
    await passes(appFails, 1);
    expect(messages).toEqual([{ title: "Bivouac: problem", message: "App recipes failed: unhealthy", priority: null }]);
  });

  it("forgets a problem that went away before being announced", async () => {
    const { messages, passes } = setup();
    await passes(appFails, CONFIRMATIONS - 1);
    await passes(healthy, 1);
    await passes(appFails, CONFIRMATIONS - 1);
    expect(messages).toEqual([]);
  });

  it("does not repeat itself, except once a day", async () => {
    const { messages, passes, clock } = setup();
    await passes(appFails, 50);
    expect(messages).toHaveLength(1);
    clock.now += DAY - 1;
    await passes(appFails, 5);
    expect(messages).toHaveLength(1);
    clock.now += 1;
    await passes(appFails, 5);
    expect(messages.map((entry) => entry.title)).toEqual(["Bivouac: problem", "Bivouac: still happening"]);
  });

  it("says once when it is over, after several clean passes", async () => {
    const { messages, passes } = setup();
    await passes(appFails, CONFIRMATIONS);
    await passes(healthy, CONFIRMATIONS - 1);
    expect(messages).toHaveLength(1);
    await passes(healthy, 10);
    expect(messages.map((entry) => entry.title)).toEqual(["Bivouac: problem", "Bivouac: resolved"]);
  });

  it("does not read as a problem when it is over", async () => {
    const { messages, passes } = setup();
    await passes(appFails, CONFIRMATIONS);
    await passes(healthy, CONFIRMATIONS);
    expect(messages[1]).toEqual(expect.objectContaining({ title: "Bivouac: resolved", message: "No longer happening: App recipes failed: unhealthy" }));
  });

  it("reports the first cause, not what later passes repeat", async () => {
    const { messages, passes } = setup();
    const later: PassOutcome = { result: { status: "unchanged", commit: "abc", changes: [], failures: [{ app: "recipes", message: "failed earlier" }] } };
    await passes(appFails, 1);
    await passes(later, CONFIRMATIONS - 1);
    expect(messages).toEqual([expect.objectContaining({ title: "Bivouac: problem", message: "App recipes failed: unhealthy" })]);
  });

  it("does not call an app fixed when the pass could not look at it", async () => {
    const { messages, passes } = setup();
    await passes(appFails, CONFIRMATIONS);
    await passes({ error: new Error("GitHub unreachable") }, 2);
    expect(messages.map((entry) => entry.title)).toEqual(["Bivouac: problem"]);
  });

  it("survives a restart of the reconciler", async () => {
    const { stateDir, messages, passes } = setup();
    await passes(appFails, CONFIRMATIONS);
    const again = new Watch({ stateDir, log: () => {}, fetch: (async () => { throw new Error("must not send"); }) as unknown as typeof globalThis.fetch, disk: () => 10 });
    await again.afterPass(appFails);
    expect(messages).toHaveLength(1);
  });

  it("alerts above 80% of disk, not at 80%", async () => {
    let percent = 80;
    const { messages, passes } = setup({ disk: () => percent });
    await passes(healthy, CONFIRMATIONS);
    expect(messages).toEqual([]);
    percent = 81;
    await passes(healthy, CONFIRMATIONS);
    expect(messages).toEqual([expect.objectContaining({ title: "Bivouac: problem", priority: null })]);
  });

  it("reminds of the rebuild test every 3 months, once", async () => {
    const { messages, passes, clock } = setup();
    await passes(healthy, 1);
    clock.now += (REBUILD_REMINDER_DAYS - 1) * DAY;
    await passes(healthy, 1);
    expect(messages).toEqual([]);
    clock.now += DAY;
    await passes(healthy, 3);
    expect(messages.map((entry) => entry.title)).toEqual(["Bivouac: quarterly check"]);
  });
});

describe("sending", () => {
  it("retries a failed delivery on a later pass", async () => {
    let status = 500;
    const { messages, passes } = setup({ status: () => status });
    await passes(appFails, CONFIRMATIONS);
    expect(messages).toEqual([]);
    status = 200;
    await passes(appFails, 1);
    expect(messages).toHaveLength(1);
  });

  it("pauses for an hour after a refusal, since repeating cannot work", async () => {
    let calls = 0;
    const { messages, passes, clock } = setup({ status: () => { calls += 1; return calls === 1 ? 400 : 200; } });
    await passes(appFails, CONFIRMATIONS + 10);
    expect(calls).toBe(1);
    clock.now += 3600_000;
    await passes(appFails, 1);
    expect(messages).toHaveLength(1);
  });

  it("does nothing without credentials", async () => {
    const { messages, pings, passes } = setup({ withCredentials: false });
    await passes(appFails, CONFIRMATIONS);
    expect([...messages, ...pings]).toEqual([]);
  });

  it("never lets an error escape", async () => {
    const { watch, stateDir } = setup({ disk: () => { throw new Error("statfs failed"); } });
    await expect(watch.afterPass(healthy)).resolves.toBeUndefined();
    expect(stateDir).toBeTruthy();
  });

  it("never logs the heartbeat address or the token", async () => {
    const { logs, passes } = setup({ status: () => 400 });
    await passes(appFails, CONFIRMATIONS);
    expect(logs.join()).not.toMatch(/hc-ping|token-value|user-value/);
  });
});

describe("when things go badly", () => {
  it("still announces once, and does not repeat, when its state cannot be saved", async () => {
    const { stateDir, messages, passes } = setup();
    mkdirSync(join(stateDir, "alerts", "state.json"), { recursive: true });
    await passes(appFails, CONFIRMATIONS + 20);
    expect(messages).toHaveLength(1);
  });

  it("still pings the heartbeat when its state cannot be saved", async () => {
    const { stateDir, pings, passes } = setup();
    mkdirSync(join(stateDir, "alerts", "state.json"), { recursive: true });
    await passes(healthy, 1);
    expect(pings).toHaveLength(1);
  });

  it("does not flap on a disk hovering around the limit", async () => {
    let percent = 85;
    const { messages, passes } = setup({ disk: () => percent });
    await passes(healthy, CONFIRMATIONS);
    percent = 78;
    await passes(healthy, 10);
    expect(messages.map((entry) => entry.title)).toEqual(["Bivouac: problem"]);
    percent = 75;
    await passes(healthy, CONFIRMATIONS);
    expect(messages.map((entry) => entry.title)).toEqual(["Bivouac: problem", "Bivouac: resolved"]);
  });

  it("stops after the daily limit, says so once, and starts again the next day", async () => {
    const { messages, passes, clock } = setup();
    for (let round = 0; round < DAILY_MESSAGE_LIMIT + 10; round += 1) {
      await passes(appFails, CONFIRMATIONS);
      await passes(healthy, CONFIRMATIONS);
    }
    expect(messages.length).toBe(DAILY_MESSAGE_LIMIT + 1);
    expect(messages.filter((entry) => entry.title === "Bivouac: too many alerts")).toHaveLength(1);
    clock.now += DAY;
    await passes(appFails, CONFIRMATIONS);
    await passes(healthy, CONFIRMATIONS);
    expect(messages.length).toBeGreaterThan(DAILY_MESSAGE_LIMIT + 1);
  });

  it("stops trying for this pass once Pushover is unreachable, and pings anyway", async () => {
    let calls = 0;
    const { passes, pings } = setup({ status: () => { calls += 1; return 500; } });
    const several: PassOutcome = { result: { status: "unchanged", commit: "abc", changes: [], failures: [{ app: "a", message: "x" }, { app: "b", message: "x" }] } };
    await passes(several, CONFIRMATIONS);
    expect(calls).toBe(1);
    expect(pings).toHaveLength(CONFIRMATIONS);
  });
});

describe("when alerts cannot be delivered", () => {
  it("withholds the heartbeat after a day, so the outside monitor speaks up", async () => {
    const { pings, passes, clock } = setup({ status: () => 403 });
    await passes(appFails, CONFIRMATIONS);
    expect(pings).toHaveLength(CONFIRMATIONS);
    clock.now += DAY - 1;
    await passes(appFails, 1);
    expect(pings).toHaveLength(CONFIRMATIONS + 1);
    clock.now += 1;
    await passes(appFails, 1);
    expect(pings).toHaveLength(CONFIRMATIONS + 1);
  });

  it("pings again as soon as a message gets through", async () => {
    let status = 500;
    const { pings, passes, clock } = setup({ status: () => status });
    await passes(appFails, CONFIRMATIONS);
    clock.now += DAY;
    await passes(appFails, 1);
    const before = pings.length;
    status = 200;
    await passes(appFails, 1);
    expect(pings.length).toBe(before + 1);
  });
});

describe("heartbeat", () => {
  it("pings after a pass that ran, even with a failing app", async () => {
    const { pings, passes } = setup();
    await passes(healthy, 1);
    await passes(appFails, 1);
    expect(pings).toEqual(["https://hc-ping.com/heartbeat", "https://hc-ping.com/heartbeat"]);
  });

  it("stays silent when a pass is stopped by an error", async () => {
    const { pings, passes } = setup();
    await passes({ error: new Error("boom") }, 1);
    expect(pings).toEqual([]);
  });
});

describe("the secrets cannot be decrypted", () => {
  it("still alerts, from the copy kept on the server", async () => {
    const { messages, passes } = setup();
    await passes({ error: new SecretsError("could not decrypt secrets/platform.sops.yaml") }, CONFIRMATIONS);
    expect(messages[0]?.message).toContain("cannot be used");
  });

  it("keeps that copy for root only, and removes it with the configuration", () => {
    const { stateDir } = setup();
    const path = join(stateDir, "secrets", "alerts", "credentials.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir, "secrets")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(credentials);
    saveAlertCredentials(stateDir, undefined);
    expect(loadAlertCredentials(stateDir)).toBeUndefined();
  });
});

describe("what leaves the server", () => {
  it("hides URL passwords and long tokens", () => {
    expect(redact("cannot reach postgres://user:pw@db:5432/x")).toBe("cannot reach postgres://[hidden]@db:5432/x");
    expect(redact(`key ${"a1".repeat(32)} refused`)).toBe("key [hidden] refused");
  });

  it("hides awkward passwords and named values", () => {
    expect(redact("postgres://u:p@ss/w@db/x")).toBe("postgres://[hidden]@db/x");
    expect(redact("failed: token=short and password=abc")).toBe("failed: token=[hidden] and password=[hidden]");
    expect(redact("Authorization: Bearer short")).toBe("Authorization: Bearer [hidden]");
  });

  it("keeps a message within Pushover's limit", () => {
    expect(redact("word ".repeat(1000)).length).toBeLessThanOrEqual(1024);
  });
});

describe("what a pass means", () => {
  it("does not judge anything when the reconciler is moving to a new version", () => {
    expect(observePass({ result: { status: "restart", commit: "abc", image: "x" } })).toEqual({ incidents: [], checked: [] });
  });

  it("reports the first error of an invalid instance", () => {
    const observation = observePass({ result: { status: "invalid", commit: "abc", errors: [{ file: "apps/x.yml", message: "bad" }] } });
    expect(observation.incidents[0]).toMatchObject({ key: "pass:invalid", message: expect.stringContaining("apps/x.yml: bad") });
  });
});
