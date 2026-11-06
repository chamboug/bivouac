#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPass, type PassConfig } from "./pass.js";

/**
 * Entry point of the reconciler container. Everything it needs comes from
 * the environment and from files placed over SSH in /etc/bivouac (D7):
 *
 *   BIVOUAC_REPOSITORY        address of the instance repo (required)
 *   BIVOUAC_BRANCH            branch to follow (default: main)
 *   BIVOUAC_INTERVAL_SECONDS  delay between passes (default: 60, D2)
 *   /etc/bivouac/deploy_key   read-only deploy key (D30)
 *   /var/lib/bivouac/         checkout and generated files
 */

const here = dirname(fileURLToPath(import.meta.url));

function configFromEnvironment(): PassConfig & { interval: number } {
  const repository = process.env.BIVOUAC_REPOSITORY;
  if (!repository) {
    throw new Error("BIVOUAC_REPOSITORY is not set: it is the address of the instance repo");
  }
  const deployKey = process.env.BIVOUAC_DEPLOY_KEY ?? "/etc/bivouac/deploy_key";
  const state = process.env.BIVOUAC_STATE_DIR ?? "/var/lib/bivouac";
  const interval = Number(process.env.BIVOUAC_INTERVAL_SECONDS ?? "60");
  if (!Number.isFinite(interval) || interval < 10) {
    throw new Error("BIVOUAC_INTERVAL_SECONDS must be a number of seconds, at least 10");
  }
  return {
    source: {
      repository,
      branch: process.env.BIVOUAC_BRANCH ?? "main",
      ...(existsSync(deployKey) ? { deployKey } : {}),
      knownHosts: join(here, "..", "github_known_hosts"),
    },
    checkout: join(state, "repo"),
    caddyfile: join(state, "caddy", "Caddyfile"),
    interval,
  };
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}

function main(): void {
  const config = configFromEnvironment();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    log("stopping");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const loop = () => {
    try {
      const result = runPass(config);
      if (result.status === "invalid") {
        log("instance is invalid: nothing applied", { commit: result.commit, errors: result.errors });
      } else {
        log(`pass ${result.status}`, { commit: result.commit, changes: result.changes });
      }
    } catch (error) {
      log("pass failed", { error: (error as Error).message });
    }
    if (!stopping) {
      timer = setTimeout(loop, config.interval * 1000);
    }
  };
  log("starting", { repository: config.source.repository, interval: config.interval });
  loop();
}

main();
