import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runPass, type PassConfig } from "./pass.js";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "..", "..", "..", "template");
const SSH_KEY = readFileSync(join(here, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** An instance repo on disk, filled from the template, and a reconciler config reading it. */
function setup(): { work: string; config: PassConfig; commit: (message: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "bivouac-reconciler-"));
  roots.push(root);
  const work = join(root, "work");
  cpSync(template, work, { recursive: true });
  writeFileSync(join(work, "platform.yml"), "domain: apps.example.com\n");
  writeFileSync(join(work, "ssh-keys.yml"), `keys:\n  - name: fixture\n    key: ${SSH_KEY}\n`);
  git(root, "init", "--quiet", "--initial-branch=main", work);
  const commit = (message: string) => {
    git(work, "add", "--all");
    git(work, "commit", "--quiet", "--message", message);
    return git(work, "rev-parse", "HEAD");
  };
  commit("initial");
  return {
    work,
    commit,
    config: {
      // file:// makes git use its normal transport, so `--depth` is honored.
      source: { repository: `file://${work}`, branch: "main" },
      checkout: join(root, "state", "repo"),
      caddyfile: join(root, "state", "caddy", "Caddyfile"),
    },
  };
}

const app = (name: string) => `name: ${name}\nimage: ghcr.io/example/${name}:sha-abc123\ngroups: [family]\n`;

describe("reconciler pass", () => {
  it("clones the repo and writes the Caddyfile, then changes nothing on the next pass", () => {
    const { config, work } = setup();
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).stdout.trim();

    expect(runPass(config)).toEqual({ status: "applied", commit: head, changes: ["Caddyfile"] });
    expect(readFileSync(config.caddyfile, "utf8")).toContain("auth.apps.example.com {");
    expect(runPass(config)).toEqual({ status: "unchanged", commit: head, changes: [] });
  });

  it("follows new commits", () => {
    const { config, work, commit } = setup();
    runPass(config);
    writeFileSync(join(work, "apps", "recipes.yml"), app("recipes"));
    const head = commit("add recipes");

    expect(runPass(config)).toEqual({ status: "applied", commit: head, changes: ["Caddyfile"] });
    expect(readFileSync(config.caddyfile, "utf8")).toContain("reverse_proxy bivouac-app-recipes:3000");
  });

  it("applies nothing from an invalid commit and keeps the last valid state", () => {
    const { config, work, commit } = setup();
    writeFileSync(join(work, "apps", "recipes.yml"), app("recipes"));
    commit("add recipes");
    runPass(config);
    const before = readFileSync(config.caddyfile, "utf8");

    writeFileSync(join(work, "apps", "library.yml"), "name: library\nimage: ghcr.io/example/library:latest\n");
    const head = commit("broken manifest");
    const result = runPass(config);

    expect(result.status).toBe("invalid");
    expect(result.commit).toBe(head);
    expect(readFileSync(config.caddyfile, "utf8")).toBe(before);
  });

  it("discards local edits in the checkout: Git is the only source of truth", () => {
    const { config } = setup();
    runPass(config);
    writeFileSync(join(config.checkout, "platform.yml"), "domain: hacked.example.com\n");
    writeFileSync(join(config.checkout, "apps", "stray.yml"), app("stray"));

    expect(runPass(config).status).toBe("unchanged");
    expect(readFileSync(config.caddyfile, "utf8")).not.toContain("hacked");
  });
});
