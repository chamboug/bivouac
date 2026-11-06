import { spawnSync } from "node:child_process";

/**
 * Caddy runs in its official container, like Butane (D31). Same version as
 * the one the platform runs. Verified on 6 November 2026 (latest release).
 */
export const CADDY_IMAGE = "caddy:2.11.9";

export class CaddyError extends Error {}

/**
 * Runs `caddy validate` on a Caddyfile. Like Butane's `--strict`, a warning
 * fails the check: Caddy logs one JSON line per message on stderr.
 */
export function validateCaddyfile(caddyfile: string): void {
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--interactive", CADDY_IMAGE, "caddy", "validate", "--config", "/dev/stdin", "--adapter", "caddyfile"],
    { input: caddyfile, encoding: "utf8" },
  );
  if (result.error) {
    throw new CaddyError(`could not run Docker (is it installed and started?): ${result.error.message}`);
  }
  const problems = result.stderr
    .split("\n")
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { level?: string; msg?: string };
        return entry.level === "warn" || entry.level === "error" ? [entry.msg ?? line] : [];
      } catch {
        return [];
      }
    });
  if (result.status !== 0 || problems.length > 0) {
    const details = problems.length > 0 ? problems.join("\n") : result.stderr.trim();
    throw new CaddyError(`Caddy refused the generated Caddyfile:\n${details}`);
  }
}
