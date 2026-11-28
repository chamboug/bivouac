/**
 * Pushover, where the alerts go (D45), checked while setting up alerts
 * (verified, pushover.net/api, 28 November 2026): `POST /1/users/validate.json`
 * with `token` and `user` answers `"status": 1` when the user key has at
 * least one active device; `POST /1/messages.json` with `token`, `user` and
 * `message` sends a message. A refusal is a 4xx with `"status": 0` and an
 * `errors` list of plain sentences, which never quote the keys. A 4xx must
 * not be retried: Pushover blocks an address that keeps insisting.
 */

const API = "https://api.pushover.net/1";

export class PushoverError extends Error {}

async function post(fetch: typeof globalThis.fetch, path: string, fields: Record<string, string>): Promise<void> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  let answer: { status?: number; errors?: unknown } = {};
  try {
    answer = (await response.json()) as typeof answer;
  } catch {
    // Not JSON: the HTTP status says enough.
  }
  if (response.ok && answer.status === 1) return;
  const errors = Array.isArray(answer.errors) ? answer.errors.filter((entry): entry is string => typeof entry === "string") : [];
  throw new PushoverError(`Pushover refused: ${errors.length > 0 ? errors.join("; ") : `HTTP ${response.status}`}`);
}

/** The token and the user key are valid, and the user has a device that can receive alerts. */
export async function validateUser(fetch: typeof globalThis.fetch, token: string, user: string): Promise<void> {
  await post(fetch, "/users/validate.json", { token, user });
}

/** One test message, sent only when the owner asks for it. */
export async function sendTest(fetch: typeof globalThis.fetch, token: string, user: string, domain: string): Promise<void> {
  await post(fetch, "/messages.json", { token, user, title: "Bivouac", message: `Test alert from bivy: the alerts of ${domain} reach this device.` });
}
