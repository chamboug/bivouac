/**
 * healthchecks.io, the dead man's switch (D45), set up through its
 * Management API v3 (verified, healthchecks.io/docs/api, 19 November 2026):
 * `X-Api-Key` with a project's read-write key; `POST /api/v3/checks/`
 * creates a check, or updates the one matching the fields in `unique`;
 * `channels: "*"` assigns every integration of the project; the answer
 * holds `ping_url`. `GET /api/v3/channels/` lists the integrations.
 *
 * The three checks of runbook section 12. Pushover is connected in
 * healthchecks.io's own interface, before (its native integration, D76).
 */

const API = "https://healthchecks.io/api/v3";

export class HealthchecksError extends Error {}

export interface CheckSpec {
  key: "heartbeat" | "backup" | "restore";
  body: Record<string, unknown>;
}

/** Times in seconds; schedules in UTC, as the reconciler runs them (02:00 UTC). */
export function checkSpecs(domain: string): CheckSpec[] {
  const named = (key: CheckSpec["key"]) => `${domain} ${key}`;
  return [
    { key: "heartbeat", body: { name: named("heartbeat"), timeout: 300, grace: 600 } },
    { key: "backup", body: { name: named("backup"), schedule: "0 2 * * *", tz: "UTC", grace: 3 * 3600 } },
    { key: "restore", body: { name: named("restore"), schedule: "0 2 * * 0", tz: "UTC", grace: 6 * 3600 } },
  ].map((spec) => ({ key: spec.key as CheckSpec["key"], body: { ...spec.body, unique: ["name"], channels: "*", desc: "Bivouac: made by bivy" } }));
}

async function call<T>(fetch: typeof globalThis.fetch, apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "X-Api-Key": apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const reasons: Record<number, string> = { 401: "the API key is wrong or read-only (a read-write key is needed)", 403: "the project has reached its number of checks" };
    throw new HealthchecksError(`healthchecks.io ${method} ${path}: ${reasons[response.status] ?? `HTTP ${response.status}`}`);
  }
  return JSON.parse(text) as T;
}

/** The project's integrations: at least one is needed, or a missing ping alerts nobody. */
export async function channels(fetch: typeof globalThis.fetch, apiKey: string): Promise<{ name: string; kind: string }[]> {
  return (await call<{ channels: { name: string; kind: string }[] }>(fetch, apiKey, "GET", "/channels/")).channels;
}

/** Creates (or finds again, by name) the three checks; returns their ping URLs. */
export async function createChecks(fetch: typeof globalThis.fetch, apiKey: string, domain: string): Promise<Record<CheckSpec["key"], string>> {
  const urls: Partial<Record<CheckSpec["key"], string>> = {};
  for (const spec of checkSpecs(domain)) {
    const check = await call<{ ping_url?: string }>(fetch, apiKey, "POST", "/checks/", spec.body);
    if (!check.ping_url?.startsWith("https://")) throw new HealthchecksError(`healthchecks.io gave no HTTPS ping URL for ${spec.key}`);
    urls[spec.key] = check.ping_url;
  }
  return urls as Record<CheckSpec["key"], string>;
}
