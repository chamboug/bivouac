import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateCaddyfile, loadInstance, type ValidationError } from "@bivouac/manifest";
import { syncRepository, type GitSource } from "./git.js";

export interface PassConfig {
  source: GitSource;
  /** Local checkout of the instance repo. */
  checkout: string;
  /** Where the generated Caddyfile is written, read by Caddy's container. */
  caddyfile: string;
}

export type PassResult =
  | { status: "applied" | "unchanged"; commit: string; changes: string[] }
  | { status: "invalid"; commit: string; errors: ValidationError[] };

/**
 * One reconciler pass: read the desired state from Git, compare it with
 * what is on the server and correct the difference. Idempotent: a second
 * pass with the same commit changes nothing.
 *
 * An invalid instance changes nothing at all: the server keeps running the
 * last valid state. CI blocks invalid changes before merge; this is the
 * safety net for anything that slips through.
 */
export function runPass(config: PassConfig): PassResult {
  const commit = syncRepository(config.source, config.checkout);
  const instance = loadInstance(config.checkout);
  const errors = [...instance.errors];
  if (!instance.platform) {
    return { status: "invalid", commit, errors };
  }
  const generated = generateCaddyfile(instance.platform, instance.apps, instance.sites);
  errors.push(...generated.errors);
  if (errors.length > 0) {
    return { status: "invalid", commit, errors };
  }

  const changes: string[] = [];
  if (writeIfChanged(config.caddyfile, generated.caddyfile)) {
    changes.push("Caddyfile");
  }
  return { status: changes.length > 0 ? "applied" : "unchanged", commit, changes };
}

/** Writes atomically (temporary file, then rename), only if the content changed. */
function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
  return true;
}
