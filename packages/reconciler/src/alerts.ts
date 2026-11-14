import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeIfChanged } from "./base.js";
import type { PassResult } from "./pass.js";
import { SecretsError, type PlatformSecrets } from "./secrets.js";

/**
 * What the server reports by itself, and the proof that it is alive (D45).
 *
 * The reconciler passes every minute, so a stuck problem must not become one
 * message a minute: a problem is announced when it has been seen on several
 * passes in a row, repeated at most once a day, and announced once more when
 * it is gone. Requiring several passes also keeps short-lived causes quiet:
 * GitHub unreachable for a minute, or a reboot's first minutes (D68).
 */

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Passes in a row before a problem is announced, or declared over. */
export const CONFIRMATIONS = 3;
export const DISK_ALERT_PERCENT = 80;
/** Rehearsing a full rebuild is the only proof it still works (D44). */
export const REBUILD_REMINDER_DAYS = 90;
/** After a refusal, Pushover may block an address that keeps insisting. */
const REFUSED_PAUSE = HOUR;
/** Disk alert ends below this, so a disk hovering at the limit does not flap. */
export const DISK_CLEAR_PERCENT = 75;
/** Whatever goes wrong, the monthly quota (10,000, D45) must survive it. */
export const DAILY_MESSAGE_LIMIT = 50;
/** Past this, alerts cannot reach anyone: the heartbeat stops, so the outside monitor says so. */
const UNDELIVERED_LIMIT = DAY;

export type AlertCredentials = NonNullable<PlatformSecrets["alerts"]>;

const credentialsFile = (stateDir: string) => join(stateDir, "secrets", "alerts", "credentials.json");

/**
 * Keeps the credentials on the server, readable by root only and mounted in
 * no container. They live in the secrets file, so without this copy the
 * failure "the secrets cannot be decrypted" could not be reported.
 */
export function saveAlertCredentials(stateDir: string, credentials: AlertCredentials | undefined): void {
  const path = credentialsFile(stateDir);
  if (!credentials) {
    rmSync(path, { force: true });
    return;
  }
  const secrets = join(stateDir, "secrets");
  for (const directory of [secrets, join(secrets, "alerts")]) {
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o700);
  }
  writeIfChanged(path, JSON.stringify(credentials), 0o600);
}

export function loadAlertCredentials(stateDir: string): AlertCredentials | undefined {
  try {
    return JSON.parse(readFileSync(credentialsFile(stateDir), "utf8")) as AlertCredentials;
  } catch {
    return undefined;
  }
}

/** A failure message may quote anything: long tokens and URL passwords stay on the server. */
export function redact(text: string): string {
  return text
    .replace(/:\/\/\S+@/g, "://[hidden]@")
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|key)=\S+/gi, "$1=[hidden]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [hidden]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[hidden]")
    .slice(0, 900);
}

export type Category = "pass" | "app" | "platform" | "disk" | "backup" | "reconciler";

export interface Incident {
  /** `<category>:<what>`: the same problem keeps the same key from one pass to the next. */
  key: `${Category}:${string}`;
  message: string;
}

export interface Observation {
  incidents: Incident[];
  /** Only the categories looked at on this pass can be declared over. */
  checked: Category[];
}

/** What came out of one pass: its result, or the error that stopped it. */
export type PassOutcome = { result: PassResult } | { error: Error };

/** Turns the outcome of a pass into what is wrong, and what was actually looked at. */
export function observePass(outcome: PassOutcome): Observation {
  if ("error" in outcome) {
    const secrets = outcome.error instanceof SecretsError;
    return {
      incidents: [{
        key: secrets ? "pass:secrets" : "pass:failed",
        message: secrets ? `The secrets cannot be used: ${outcome.error.message}` : `A reconciler pass failed: ${outcome.error.message}`,
      }],
      checked: ["pass"],
    };
  }
  const { result } = outcome;
  if (result.status === "restart") return { incidents: [], checked: [] };
  if (result.status === "invalid") {
    const first = result.errors[0];
    return {
      incidents: [{
        key: "pass:invalid",
        message: `The instance repo is invalid, nothing is applied: ${first ? `${first.file}: ${first.message}` : "unknown error"}`,
      }],
      checked: ["pass"],
    };
  }
  return {
    incidents: result.failures.map((failure) => failure.app === "(platform)"
      ? { key: `platform:${failure.message.slice(0, 120)}` as const, message: failure.message }
      : { key: `app:${failure.app}` as const, message: `App ${failure.app} failed: ${failure.message}` }),
    checked: ["pass", "app", "platform"],
  };
}

/** Used space as `df` shows it: blocks kept for root do not count as free. */
export function diskPercent(path: string): number {
  const { blocks, bfree, bavail } = statfsSync(path);
  const used = blocks - bfree;
  return Math.ceil((used / (used + bavail)) * 100);
}

export function observeDisk(percent: number, alreadyAlerting: boolean): Observation {
  return {
    incidents: percent > (alreadyAlerting ? DISK_CLEAR_PERCENT : DISK_ALERT_PERCENT)
      ? [{ key: "disk:root", message: `The disk is more than ${DISK_ALERT_PERCENT}% full: a full disk stops Postgres (D42)` }]
      : [],
    checked: ["disk"],
  };
}

const stateSchema = z.object({
  incidents: z.record(z.string(), z.object({
    message: z.string(),
    seen: z.number(),
    missed: z.number(),
    lastSent: z.number().optional(),
  })),
  rebuildReminder: z.number().optional(),
  pausedUntil: z.number().optional(),
  budget: z.object({ day: z.number(), sent: z.number() }).optional(),
  undeliveredSince: z.number().optional(),
});
type State = z.infer<typeof stateSchema>;

class Refused extends Error {}

export interface WatchOptions {
  stateDir: string;
  log: (message: string, fields?: Record<string, unknown>) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  disk?: () => number;
}

/** Called after every pass. Never throws: a broken alert must not stop the reconciler. */
export class Watch {
  private readonly path: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly disk: () => number;
  /** Kept in memory: the file only serves restarts, and may be unwritable when it matters most. */
  private state: State | undefined;
  /** Pushover unreachable on this pass: the others would only wait for their timeout. */
  private unreachable = false;

  constructor(private readonly options: WatchOptions) {
    this.path = join(options.stateDir, "alerts", "state.json");
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
    this.disk = options.disk ?? (() => diskPercent(options.stateDir));
  }

  async afterPass(outcome: PassOutcome, others: Observation[] = []): Promise<void> {
    try {
      const credentials = loadAlertCredentials(this.options.stateDir);
      if (!credentials) return;
      const state = (this.state ??= this.load());
      this.unreachable = false;
      const send = (title: string, message: string) => this.send(credentials, state, title, message);
      await this.apply(state, observePass(outcome), send);
      await this.apply(state, observeDisk(this.disk(), state.incidents["disk:root"] !== undefined), send);
      for (const observation of others) await this.apply(state, observation, send);
      await this.remindRebuild(state, send);
      this.save(state);
      // A pass stopped by an error is no proof of health: the switch stays
      // silent, which also covers a server unable to send anything itself.
      const channelLost = state.undeliveredSince !== undefined && this.now() - state.undeliveredSince >= UNDELIVERED_LIMIT;
      if (channelLost) this.options.log("alerts undelivered for a day: heartbeat withheld");
      else if (!("error" in outcome)) await this.ping(credentials.healthchecks.heartbeat);
    } catch (error) {
      this.options.log("alerts failed", { error: (error as Error).message });
    }
  }

  private async apply(state: State, observation: Observation, send: (title: string, message: string) => Promise<boolean>): Promise<void> {
    const now = this.now();
    const current = new Set<string>();
    for (const incident of observation.incidents) {
      current.add(incident.key);
      // The first message stays: it holds the cause, and later passes may only
      // repeat that the problem is known ("failed its health check earlier").
      const entry = (state.incidents[incident.key] ??= { message: redact(incident.message), seen: 0, missed: 0 });
      entry.seen += 1;
      entry.missed = 0;
      if (entry.lastSent === undefined) {
        if (entry.seen >= CONFIRMATIONS && (await send("Bivouac: problem", entry.message))) entry.lastSent = now;
      } else if (now - entry.lastSent >= DAY && (await send("Bivouac: still happening", entry.message))) {
        entry.lastSent = now;
      }
    }
    for (const [key, entry] of Object.entries(state.incidents)) {
      if (current.has(key) || !observation.checked.includes(key.split(":")[0] as Category)) continue;
      entry.seen = 0;
      if (entry.lastSent === undefined) {
        delete state.incidents[key];
        continue;
      }
      entry.missed += 1;
      if (entry.missed >= CONFIRMATIONS && (await send("Bivouac: resolved", `No longer happening: ${entry.message}`))) delete state.incidents[key];
    }
  }

  private async remindRebuild(state: State, send: (title: string, message: string) => Promise<boolean>): Promise<void> {
    const now = this.now();
    if (state.rebuildReminder === undefined) {
      state.rebuildReminder = now;
    } else if (now - state.rebuildReminder >= REBUILD_REMINDER_DAYS * DAY
      && (await send("Bivouac: quarterly check", "Time to rehearse a full rebuild: bivy rebuild --test (D44)"))) {
      state.rebuildReminder = now;
    }
  }

  /** True once Pushover has taken the message. Anything else is tried again on a later pass. */
  private async send(credentials: AlertCredentials, state: State, title: string, message: string): Promise<boolean> {
    if (this.unreachable || (state.pausedUntil !== undefined && this.now() < state.pausedUntil)) return false;
    const day = Math.floor(this.now() / DAY);
    if (state.budget?.day !== day) state.budget = { day, sent: 0 };
    const budget = state.budget;
    if (budget.sent > DAILY_MESSAGE_LIMIT) return false;
    const capped = budget.sent === DAILY_MESSAGE_LIMIT;
    try {
      await sendPushover(
        credentials,
        capped ? "Bivouac: too many alerts" : title,
        capped ? `More than ${DAILY_MESSAGE_LIMIT} alerts today: the next ones wait until tomorrow. Look at the server.` : message,
        this.fetch,
      );
      budget.sent += 1;
      delete state.undeliveredSince;
      this.options.log("alert sent", { title: capped ? "too many alerts" : title });
      return !capped;
    } catch (error) {
      state.undeliveredSince ??= this.now();
      if (error instanceof Refused) state.pausedUntil = this.now() + REFUSED_PAUSE;
      else this.unreachable = true;
      this.options.log("alert not sent", { title, error: (error as Error).message });
      return false;
    }
  }

  /** The address is itself a secret: it is never logged. */
  private async ping(url: string): Promise<void> {
    try {
      const response = await this.fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) this.options.log("heartbeat refused", { status: response.status });
    } catch {
      this.options.log("heartbeat not sent");
    }
  }

  private load(): State {
    if (!existsSync(this.path)) return { incidents: {} };
    try {
      return stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      this.options.log("alert state unreadable: starting again");
      return { incidents: {} };
    }
  }

  private save(state: State): void {
    try {
      writeIfChanged(this.path, JSON.stringify(state), 0o600);
    } catch (error) {
      this.options.log("alert state not saved", { error: (error as Error).message });
    }
  }
}

/**
 * One message. Verified (pushover.net/api): a 4xx will not succeed if
 * repeated; for anything else, not sooner than 5 seconds, which the delay
 * between passes guarantees.
 */
export async function sendPushover(
  credentials: AlertCredentials,
  title: string,
  message: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetcher(PUSHOVER_URL, {
    method: "POST",
    body: new URLSearchParams({
      token: credentials.pushover_token,
      user: credentials.pushover_user,
      title,
      message: redact(message),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 400 && response.status < 500) throw new Refused(`Pushover refused the message (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`Pushover answered HTTP ${response.status}`);
}
