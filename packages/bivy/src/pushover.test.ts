import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Asker } from "./ask.js";
import { askPart } from "./configure.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const SECRETS: Record<string, string> = { "pushover-token": "app-token", "pushover-user": "user-key", "healthchecks-api-key": "hc-key" };

function setup(options: { tty?: boolean; answers?: Record<string, string>; pushover?: (path: string) => Response }) {
  const config = mkdtempSync(join(tmpdir(), "bivy-pushover-"));
  dirs.push(config);
  const sent: { path: string; fields: Record<string, string> }[] = [];
  const asked: string[] = [];
  const logs: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.startsWith("https://api.pushover.net/1")) {
      const path = address.slice("https://api.pushover.net/1".length);
      sent.push({ path, fields: Object.fromEntries(new URLSearchParams(String(init?.body))) });
      return options.pushover?.(path) ?? Response.json({ status: 1, request: "r" });
    }
    if (address.endsWith("/channels/")) return Response.json({ channels: [{ name: "phone", kind: "po" }] });
    return Response.json({ ping_url: "https://hc-ping.com/abc" });
  }) as typeof globalThis.fetch;
  const ask: Asker = {
    tty: options.tty ?? true,
    select: async (flag) => {
      asked.push(flag);
      return options.answers?.[flag] as never;
    },
    text: async () => "",
    secret: async (spec) => {
      const value = SECRETS[spec.path.split("/").pop() ?? ""] ?? "";
      writeFileSync(spec.path, value);
      return value;
    },
    typed: async () => true,
    log: (message) => logs.push(message),
  };
  const deps = { ask, config: (name: string) => join(config, name), fetch, checkSmtp: async () => {}, now: Date.now };
  return { deps, sent, asked, logs };
}

describe("alerts: the Pushover keys", () => {
  it("are checked, then a test alert is sent when asked for, and its arrival confirmed", async () => {
    const run = setup({ answers: { "test-alert": "send", "test-alert-arrived": "yes" } });
    const result = await askPart(run.deps, "alerts", "apps.example.org", { testAlert: true });
    expect(run.sent.map((entry) => entry.path)).toEqual(["/users/validate.json", "/messages.json"]);
    expect(run.sent[0]?.fields).toEqual({ token: "app-token", user: "user-key" });
    expect(run.sent[1]?.fields.message).toContain("apps.example.org");
    expect(run.logs).toContain("  ✓ Pushover: the token and the user key are valid");
    expect(result.secrets).toEqual({ alerts: { pushover_token: "app-token", pushover_user: "user-key", healthchecks: { heartbeat: "https://hc-ping.com/abc", backup: "https://hc-ping.com/abc", restore: "https://hc-ping.com/abc" } } });
  });

  it("sends no test alert when it is skipped, without a terminal, or in bivy init", async () => {
    const skipped = setup({ answers: { "test-alert": "skip" } });
    await askPart(skipped.deps, "alerts", "apps.example.org", { testAlert: true });
    expect(skipped.sent.map((entry) => entry.path)).toEqual(["/users/validate.json"]);

    const script = setup({ tty: false });
    await askPart(script.deps, "alerts", "apps.example.org", { testAlert: true });
    expect(script.sent.map((entry) => entry.path)).toEqual(["/users/validate.json"]);
    expect(script.asked).toEqual([]);

    // bivy init: the server sends its own test alert at the end.
    const init = setup({ answers: { "test-alert": "send" } });
    await askPart(init.deps, "alerts", "apps.example.org");
    expect(init.sent.map((entry) => entry.path)).toEqual(["/users/validate.json"]);
    expect(init.asked).toEqual([]);
  });

  it("stops with what to check when the test alert did not arrive", async () => {
    const run = setup({ answers: { "test-alert": "send", "test-alert-arrived": "no" } });
    await expect(askPart(run.deps, "alerts", "apps.example.org", { testAlert: true })).rejects.toThrow(/the test alert did not arrive: check that the Pushover app/);
  });

  it("says plainly what Pushover refused, before healthchecks.io is touched", async () => {
    const run = setup({ pushover: () => Response.json({ user: "invalid", errors: ["user identifier is invalid"], status: 0 }, { status: 400 }) });
    await expect(askPart(run.deps, "alerts", "apps.example.org", { testAlert: true })).rejects.toThrow(/^Pushover refused: user identifier is invalid\. Fix it, or delete .*pushover-token and .*pushover-user to type them again\.$/);
    expect(run.asked).toEqual([]);
  });
});
